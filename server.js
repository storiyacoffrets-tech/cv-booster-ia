import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import pg from "pg";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) {
    console.warn("⚠️  DATABASE_URL non configurée : les comptes clients sont désactivés (le paiement/téléchargement simple fonctionne quand même).");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cvs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      paid BOOLEAN DEFAULT false,
      stripe_session_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS magic_links (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log("✅ Base de données prête (comptes clients activés).");
}

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" })); // photos en base64 = payload plus lourd
app.use(express.static("public"));

const PRICE_EUR_CENTS = 199; // 1,99€

function isValidCV(cv) {
  return (
    cv &&
    typeof cv.fullName === "string" &&
    cv.fullName.trim().length > 1 &&
    typeof cv.jobTitle === "string" &&
    cv.jobTitle.trim().length > 1
  );
}

// Filet de sécurité en plus de la base de données : une copie temporaire en
// mémoire, utilisée uniquement si la base de données n'est pas configurée.
const backupCVs = new Map();
setInterval(() => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of backupCVs) {
    if (entry.createdAt < twoHoursAgo) backupCVs.delete(id);
  }
}, 30 * 60 * 1000);

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return { ok: false, reason: "Envoi d'email non configuré." };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: "CV Designer IA <onboarding@resend.dev>", to: [to], subject, html }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error("Erreur envoi email:", err);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error("Erreur envoi email:", err);
    return { ok: false };
  }
}

// ---- Authentification par lien magique (sans mot de passe) ----

function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.status(401).json({ error: "Non connecté." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session invalide ou expirée." });
  }
}

app.get("/api/me", (req, res) => {
  const token = req.cookies.session;
  if (!token) return res.json({ loggedIn: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ loggedIn: true, email: payload.email });
  } catch {
    res.json({ loggedIn: false });
  }
});

app.post("/api/auth/request-login", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Comptes clients non disponibles pour le moment." });
    const { email } = req.body;
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Email invalide." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await pool.query(
      "INSERT INTO magic_links (email, token, expires_at) VALUES ($1, $2, $3)",
      [email.toLowerCase().trim(), token, expiresAt]
    );

    const link = `${DOMAIN}/api/auth/verify?token=${token}`;
    await sendEmail({
      to: email,
      subject: "Votre lien de connexion - CV Designer IA",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <p style="color:#1f5c4e; font-weight:700; font-size:12px; letter-spacing:1px; text-transform:uppercase;">CV Designer IA</p>
          <h1 style="font-size:22px;">Connexion à votre compte</h1>
          <p style="font-size:14px; color:#444; line-height:1.6;">Cliquez sur le bouton ci-dessous pour accéder à vos CV. Ce lien est valable 30 minutes.</p>
          <a href="${link}" style="display:inline-block; background:#1f5c4e; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:700; margin-top:12px;">Accéder à mon compte</a>
          <p style="font-size:12px; color:#999; margin-top:24px;">Si vous n'avez rien demandé, ignorez simplement cet email.</p>
        </div>`,
    });

    res.json({ sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.get("/api/auth/verify", async (req, res) => {
  try {
    if (!pool) return res.status(503).send("Comptes clients non disponibles.");
    const { token } = req.query;
    if (!token) return res.status(400).send("Lien invalide.");

    const result = await pool.query(
      "SELECT * FROM magic_links WHERE token = $1 AND used = false AND expires_at > now()",
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).send("Ce lien a expiré ou a déjà été utilisé. Redemandez-en un depuis le site.");
    }
    const magicLink = result.rows[0];
    await pool.query("UPDATE magic_links SET used = true WHERE id = $1", [magicLink.id]);

    let userResult = await pool.query("SELECT * FROM users WHERE email = $1", [magicLink.email]);
    let user;
    if (userResult.rows.length === 0) {
      const inserted = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING *", [magicLink.email]);
      user = inserted.rows[0];
    } else {
      user = userResult.rows[0];
    }

    const sessionToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
    res.cookie("session", sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.redirect("/account.html");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur serveur.");
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

// ---- CV du compte client ----

app.get("/api/my-cvs", requireAuth, async (req, res) => {
  if (!pool) return res.json({ cvs: [] });
  const result = await pool.query(
    "SELECT id, data, updated_at FROM cvs WHERE user_id = $1 AND paid = true ORDER BY updated_at DESC",
    [req.userId]
  );
  res.json({ cvs: result.rows });
});

app.get("/api/cv/:id", requireAuth, async (req, res) => {
  if (!pool) return res.status(404).json({ error: "Introuvable." });
  const result = await pool.query(
    "SELECT id, data FROM cvs WHERE id = $1 AND user_id = $2 AND paid = true",
    [req.params.id, req.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "CV introuvable." });
  res.json({ id: result.rows[0].id, cv: result.rows[0].data });
});

app.put("/api/cv/:id", requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Non disponible." });
  const { cv } = req.body;
  if (!isValidCV(cv)) return res.status(400).json({ error: "CV invalide." });
  const result = await pool.query(
    "UPDATE cvs SET data = $1, updated_at = now() WHERE id = $2 AND user_id = $3 AND paid = true RETURNING id",
    [cv, req.params.id, req.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "CV introuvable." });
  res.json({ saved: true });
});

// ---- 1. Améliorer un texte avec l'IA (gratuit, sans paiement) ----
app.post("/api/improve-text", async (req, res) => {
  try {
    const { text, context } = req.body;
    if (!text || text.trim().length < 5) {
      return res.status(400).json({ error: "Texte trop court." });
    }

    const prompt = `Tu es un expert en rédaction de CV et en systèmes ATS (Applicant Tracking System).
Contexte : ${context || "section d'un CV"}
Texte original écrit par le candidat :
---
${text}
---
Réécris ce texte pour qu'il soit :
1. Percutant et orienté résultats (utilise des verbes d'action)
2. Concis, sans fioritures
3. Compatible avec les filtres ATS (mots-clés naturels, pas de jargon inutile)
4. Honnête : n'invente aucune information non présente dans le texte original

Réponds uniquement avec le texte amélioré, sans commentaire, sans guillemets, sans introduction.`;

    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await aiResponse.json();
    if (!aiResponse.ok) {
      console.error("Erreur API Anthropic:", data);
      return res.status(500).json({ error: "Erreur lors de l'amélioration du texte." });
    }

    const improvedText = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    res.json({ improvedText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---- 2. Retoucher la photo de profil (gratuit, sans paiement) ----
app.post("/api/enhance-photo", async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "Image manquante." });
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const inputBuffer = Buffer.from(base64Data, "base64");

    if (inputBuffer.length > 8 * 1024 * 1024) {
      return res.status(413).json({ error: "Image trop lourde (8 Mo max)." });
    }

    const outputBuffer = await sharp(inputBuffer)
      .rotate() // corrige l'orientation EXIF (photos prises au téléphone)
      .resize(500, 625, { fit: "cover", position: "attention" }) // recadrage portrait intelligent
      .normalize() // égalise le contraste automatiquement
      .modulate({ brightness: 1.06, saturation: 1.08 }) // léger boost lumière/couleurs
      .sharpen({ sigma: 0.6 }) // netteté professionnelle
      .jpeg({ quality: 90 })
      .toBuffer();

    const enhancedBase64 = `data:image/jpeg;base64,${outputBuffer.toString("base64")}`;
    res.json({ enhancedImage: enhancedBase64 });
  } catch (err) {
    console.error("Erreur retouche photo:", err);
    res.status(500).json({ error: "Erreur lors de la retouche de la photo." });
  }
});

// ---- 3. Créer une session de paiement Stripe pour débloquer le PDF ----
// Le CV est enregistré en base de données dès ce moment (paid=false), ce qui
// évite toute perte de données quel que soit ce qui se passe ensuite.
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { cv } = req.body;
    if (!isValidCV(cv)) {
      return res.status(400).json({ error: "Données de CV incomplètes (nom et poste requis)." });
    }

    let cvId = null;
    if (pool) {
      const inserted = await pool.query(
        "INSERT INTO cvs (data, paid) VALUES ($1, false) RETURNING id",
        [cv]
      );
      cvId = inserted.rows[0].id;
    } else {
      cvId = crypto.randomUUID();
      backupCVs.set(cvId, { cv, createdAt: Date.now() });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "CV Designer IA - Export PDF",
              description: "Téléchargement de votre CV en PDF haute qualité, sans filigrane.",
            },
            unit_amount: PRICE_EUR_CENTS,
          },
          quantity: 1,
        },
      ],
      success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/builder.html`,
      metadata: { cvId: String(cvId) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la création du paiement." });
  }
});

// ---- 4. Après paiement : confirmer le paiement, renvoyer le CV, créer le compte ----
app.post("/api/verify-payment", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "session_id manquant." });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Paiement non confirmé." });
    }

    const cvId = session.metadata && session.metadata.cvId;
    let cv = null;

    if (pool) {
      const result = await pool.query("SELECT * FROM cvs WHERE id = $1", [cvId]);
      if (result.rows.length === 0) {
        return res.status(410).json({ error: "CV introuvable. Contactez le support, votre paiement a bien été reçu." });
      }
      cv = result.rows[0].data;

      if (!result.rows[0].paid) {
        // Première confirmation de ce paiement : on marque payé, on crée/relie le compte
        let userId = null;
        if (cv.email) {
          let userResult = await pool.query("SELECT id FROM users WHERE email = $1", [cv.email.toLowerCase().trim()]);
          if (userResult.rows.length === 0) {
            userResult = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [cv.email.toLowerCase().trim()]);
          }
          userId = userResult.rows[0].id;
        }
        await pool.query(
          "UPDATE cvs SET paid = true, stripe_session_id = $1, user_id = $2 WHERE id = $3",
          [sessionId, userId, cvId]
        );

        // Email avec le CV + lien de connexion au compte (envoyé une seule fois)
        if (cv.email) {
          const token = crypto.randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 jours pour ce premier lien
          await pool.query(
            "INSERT INTO magic_links (email, token, expires_at) VALUES ($1, $2, $3)",
            [cv.email.toLowerCase().trim(), token, expiresAt]
          );
          const accountLink = `${DOMAIN}/api/auth/verify?token=${token}`;
          sendEmail({
            to: cv.email,
            subject: `Votre CV est prêt - ${cv.fullName}`,
            html: buildCVEmailHTML(cv, accountLink),
          }).catch(() => {});
        }
      }
    } else {
      const backup = backupCVs.get(cvId);
      cv = backup ? backup.cv : null;
    }

    if (!cv) {
      return res.status(410).json({ error: "CV introuvable. Contactez le support, votre paiement a bien été reçu." });
    }

    res.json({ paid: true, cv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

function buildCVEmailHTML(cv, accountLink) {
  const contact = [cv.city, cv.email, cv.phone].filter(Boolean).join(" · ");
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  let experiencesHTML = "";
  (cv.experiences || []).forEach((exp) => {
    experiencesHTML += `
      <tr><td style="padding:10px 0;">
        <div style="font-weight:700; font-size:14px;">${esc(exp.role)} <span style="color:#888; font-weight:400; font-size:12px;">— ${esc(exp.dates)}</span></div>
        <div style="color:#1f5c4e; font-size:13px; font-weight:600; margin-bottom:4px;">${esc(exp.company)}</div>
        <div style="font-size:13px; color:#333; white-space:pre-line;">${esc(exp.description)}</div>
      </td></tr>`;
  });

  let educationsHTML = "";
  (cv.educations || []).forEach((ed) => {
    educationsHTML += `
      <tr><td style="padding:8px 0;">
        <div style="font-weight:700; font-size:14px;">${esc(ed.degree)} <span style="color:#888; font-weight:400; font-size:12px;">— ${esc(ed.dates)}</span></div>
        <div style="color:#1f5c4e; font-size:13px; font-weight:600;">${esc(ed.school)}</div>
      </td></tr>`;
  });

  return `
  <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
    <p style="color:#1f5c4e; font-weight:700; font-size:12px; letter-spacing:1px; text-transform:uppercase;">CV Designer IA</p>
    ${accountLink ? `<div style="background:#e4efe9; border-radius:10px; padding:16px; margin-bottom:20px;">
      <p style="font-size:13px; margin:0 0 10px; color:#1f5c4e; font-weight:600;">Vous pouvez modifier et retélécharger ce CV à tout moment, gratuitement.</p>
      <a href="${accountLink}" style="display:inline-block; background:#1f5c4e; color:white; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:700; font-size:13px;">Accéder à mon compte</a>
    </div>` : ""}
    <h1 style="font-size:24px; margin:0 0 4px;">${esc(cv.fullName)}</h1>
    <p style="color:#1f5c4e; font-weight:600; margin:0 0 10px;">${esc(cv.jobTitle)}</p>
    <p style="font-size:13px; color:#555; margin:0 0 20px;">${esc(contact)}</p>
    ${cv.summary ? `<p style="font-size:14px; line-height:1.6; color:#2a2a2a;">${esc(cv.summary)}</p>` : ""}
    ${experiencesHTML ? `<h3 style="font-size:13px; text-transform:uppercase; letter-spacing:1px; color:#1f5c4e; border-bottom:2px solid #1f5c4e; padding-bottom:6px; margin-top:26px;">Expérience professionnelle</h3><table width="100%">${experiencesHTML}</table>` : ""}
    ${educationsHTML ? `<h3 style="font-size:13px; text-transform:uppercase; letter-spacing:1px; color:#1f5c4e; border-bottom:2px solid #1f5c4e; padding-bottom:6px; margin-top:20px;">Formation</h3><table width="100%">${educationsHTML}</table>` : ""}
    ${cv.skills ? `<h3 style="font-size:13px; text-transform:uppercase; letter-spacing:1px; color:#1f5c4e; border-bottom:2px solid #1f5c4e; padding-bottom:6px; margin-top:20px;">Compétences</h3><p style="font-size:13px;">${esc(cv.skills)}</p>` : ""}
  </div>`;
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  await initDB();
  console.log(`CV Designer IA lancé sur ${DOMAIN}`);
});
