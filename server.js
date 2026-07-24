import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PRICE_EUR_CENTS = 990; // 9,90€

// ---- 1. Créer une session de paiement Stripe ----
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { resume, jobOffer } = req.body;
    if (!resume || !jobOffer || resume.length < 20 || jobOffer.length < 20) {
      return res.status(400).json({ error: "CV ou offre d'emploi trop courts / manquants." });
    }

    // On stocke temporairement le CV + l'offre dans les metadata Stripe
    // (limite 500 caractères par champ metadata -> on tronque si besoin,
    // pour un usage réel on préfèrera stocker en base + un id)
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
      metadata: {
        resume: resume.slice(0, 4900),
        jobOffer: jobOffer.slice(0, 4900),
      },
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

    const { resume, jobOffer } = session.metadata;

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
