# CV Booster IA — Guide de lancement (aujourd'hui, ce soir)

Business du jour : un outil qui optimise un CV pour les filtres ATS via IA, vendu 9,90€ en paiement unique.

Checklist pour être en ligne et vendre ce soir. Compte environ **45-60 minutes** de setup total.

---

## 1. Stripe (10 min) — pour encaisser l'argent

1. Va sur https://dashboard.stripe.com/register et crée un compte (email + mot de passe).
2. Une fois connecté, reste en **mode Test** pour l'instant (bouton en haut à droite).
3. Va dans **Developers > API keys**, copie la clé qui commence par `sk_test_...`.
4. Pour activer les paiements **réels** (recevoir de l'argent) : dans le dashboard, section "Activer votre compte", remplis tes infos (identité, IBAN). En France, l'activation est généralement quasi-instantanée pour un particulier/auto-entrepreneur, parfois quelques heures si vérification manuelle. Tu peux tester tout le tunnel en mode Test pendant ce temps.
5. Une fois activé, remplace `sk_test_...` par ta clé `sk_live_...` dans le `.env`.

Carte de test pour vérifier le tunnel en mode Test : `4242 4242 4242 4242`, date future, CVC quelconque.

## 2. Clé Anthropic (2 min) — pour générer les CV

1. Va sur https://console.anthropic.com/settings/keys
2. Crée une clé API, copie-la (commence par `sk-ant-...`).
3. Ajoute quelques euros de crédit si besoin (Billing).

## 3. Configuration locale

```bash
cp .env.example .env
# Édite .env et remplis :
# STRIPE_SECRET_KEY=sk_test_...  (ou sk_live_... une fois activé)
# ANTHROPIC_API_KEY=sk-ant-...
# DOMAIN=http://localhost:3000

npm install
npm start
```

Ouvre http://localhost:3000 — teste le tunnel complet avec la carte de test Stripe.

## 4. Déploiement (10-15 min) — pour que ce soit en ligne ce soir

Option la plus rapide : **Render.com** (gratuit pour démarrer).

1. Crée un dépôt GitHub avec ce projet (`git init`, `git add .`, `git commit`, push).
2. Sur https://render.com, "New Web Service" → connecte ton repo GitHub.
3. Build command : `npm install` — Start command : `npm start`.
4. Dans "Environment", ajoute les variables : `STRIPE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `DOMAIN` (mets l'URL Render une fois qu'elle t'est attribuée, ex: `https://cv-booster-ia.onrender.com`), puis redéploie.
5. Ton site est en ligne. Teste à nouveau le paiement + génération en prod.

Alternative tout aussi rapide : Railway.app (même principe, souvent encore plus simple).

## 5. Pub Meta Ads — 30€ ce soir

Cible : personnes en recherche d'emploi, 25-45 ans, intérêts "recherche d'emploi", "LinkedIn", "recrutement", "développement de carrière".

1. https://www.facebook.com/adsmanager → Créer une campagne → Objectif "Trafic" ou "Conversions" si tu as installé le Pixel Meta (recommandé mais pas obligatoire pour démarrer ce soir).
2. Budget : 30€ sur 2-3 jours (ou 10€/jour) pour lisser l'apprentissage de l'algorithme.
3. Ciblage : France, 22-50 ans, intérêts ci-dessus.
4. Visuel : simple, texte sur fond coloré type "75% des CV sont rejetés avant qu'un humain les lise. Le vôtre passe les filtres ?" — tu peux le faire en 5 min sur Canva.
5. Accroche (exemples à tester) :
   - "Votre CV est peut-être rejeté par un robot avant même qu'un recruteur le voie."
   - "CV optimisé pour les logiciels de recrutement en 2 minutes, 9,90€."
6. Lien vers ta page `/index.html`.

## 6. Après le lancement

- Ajoute un webhook Stripe (`checkout.session.completed`) pour plus de robustesse en production — la version actuelle vérifie le paiement en synchrone au moment de la génération, suffisant pour démarrer mais pas idéal à grande échelle.
- Ajoute une page CGV/mentions légales (obligatoire légalement pour vendre en France — statut auto-entrepreneur recommandé si tu n'as pas encore de structure).
- Suis les ventes via le dashboard Stripe (Payments).

---

**Fichiers du projet :**
- `server.js` — backend Express (paiement + génération IA)
- `public/index.html` — landing page / formulaire
- `public/success.html` — page de résultat après paiement
- `.env.example` — variables à configurer
