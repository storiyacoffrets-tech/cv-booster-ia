import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PRICE_EUR_CENTS = 990; // 9,90€

// Stockage temporaire en mémoire (les metadata Stripe sont limitées à 500
// caractères par champ, donc on garde le CV/l'offre ici et on ne passe
// qu'un identifiant court à Stripe). Nettoyage automatique après 2h.
const pendingSubmissions = new Map();

function cleanupOldSubmissions() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of pendingSubmissions) {
    if (entry.createdAt < twoHoursAgo) pendingSubmissions.delete(id);
  }
}
setInterval(cleanupOldSubmissions, 30 * 60 * 1000);

// ---- 1. Créer une session de paiement Stripe ----
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { resume, jobOffer } = req.body;
    if (!resume || !jobOffer || resume.length < 20 || jobOffer.length < 20) {
      return res.status(400).json({ error: "CV ou offre d'emploi trop courts / manquants." });
    }

    // On génère un identifiant court et on garde le CV + l'offre en mémoire
    // côté serveur (les metadata Stripe sont limitées à 500 caractères).
    const dataId = crypto.randomUUID();
    pendingSubmissions.set(dataId, { resume, jobOffer, createdAt: Date.now() });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "CV Booster IA - Optimisation ATS",
              description: "Votre CV réécrit et optimisé pour passer les filtres de recrutement automatiques.",
            },
            unit_amount: PRICE_EUR_CENTS,
          },
          quantity: 1,
        },
      ],
      success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/index.html`,
      metadata: { dataId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la création du paiement." });
  }
});

// ---- 2. Après paiement : vérifier + générer le CV optimisé ----
app.post("/api/generate", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "session_id manquant." });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Paiement non confirmé." });
    }

    const { dataId } = session.metadata;
    const submission = pendingSubmissions.get(dataId);

    if (!submission) {
      return res.status(410).json({
        error: "Données introuvables (session expirée). Contactez le support, votre paiement a bien été reçu.",
      });
    }

    const { resume, jobOffer } = submission;

    const prompt = `Tu es un expert en recrutement et en systèmes ATS (Applicant Tracking System).
Voici le CV actuel d'un candidat :
---
${resume}
---
Voici l'offre d'emploi visée :
---
${jobOffer}
---
Réécris ce CV pour qu'il :
1. Intègre naturellement les mots-clés importants de l'offre (compétences, titre de poste, outils)
2. Soit structuré de façon lisible par un ATS (pas de tableaux, pas de colonnes complexes)
3. Mette en avant les expériences les plus pertinentes pour ce poste précis
4. Reste honnête : n'invente aucune expérience ou compétence non présente dans le CV original
5. Soit prêt à copier-coller directement

Réponds uniquement avec le CV optimisé, sans commentaire ni introduction.`;

    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await aiResponse.json();

    if (!aiResponse.ok) {
      console.error("Erreur API Anthropic:", data);
      return res.status(500).json({ error: "Erreur lors de la génération du CV." });
    }

    const optimizedResume = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.json({ optimizedResume });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CV Booster IA lancé sur ${DOMAIN}`);
});
