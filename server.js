import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import crypto from "crypto";
import sharp from "sharp";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");

app.use(cors());
app.use(express.json({ limit: "10mb" })); // photos en base64 = payload plus lourd
app.use(express.static("public"));

const PRICE_EUR_CENTS = 199; // 1,99€

// Stockage temporaire en mémoire (les metadata Stripe sont limitées à 500
// caractères par champ, donc on garde le CV complet ici et on ne passe
// qu'un identifiant court à Stripe). Nettoyage automatique après 2h.
const pendingCVs = new Map();

function cleanupOld() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of pendingCVs) {
    if (entry.createdAt < twoHoursAgo) pendingCVs.delete(id);
  }
}
setInterval(cleanupOld, 30 * 60 * 1000);

function isValidCV(cv) {
  return (
    cv &&
    typeof cv.fullName === "string" &&
    cv.fullName.trim().length > 1 &&
    typeof cv.jobTitle === "string" &&
    cv.jobTitle.trim().length > 1
  );
}

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
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { cv } = req.body;
    if (!isValidCV(cv)) {
      return res.status(400).json({ error: "Données de CV incomplètes (nom et poste requis)." });
    }

    const dataId = crypto.randomUUID();
    pendingCVs.set(dataId, { cv, createdAt: Date.now() });

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
      metadata: { dataId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la création du paiement." });
  }
});

// ---- 4. Après paiement : renvoyer les données du CV pour le rendu final ----
app.post("/api/get-cv", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "session_id manquant." });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Paiement non confirmé." });
    }

    const { dataId } = session.metadata;
    const entry = pendingCVs.get(dataId);
    if (!entry) {
      return res.status(410).json({
        error: "Données introuvables (session expirée). Contactez le support, votre paiement a bien été reçu.",
      });
    }

    res.json({ cv: entry.cv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CV Designer IA lancé sur ${DOMAIN}`);
});
