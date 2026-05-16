# Inscription AFFBC

Application publique d'inscription pour `inscription.americanfullfightingbons.fr`, déployée sur Cloudflare Workers avec :

- un frontend statique servi depuis `public/`
- un worker principal dans `src/index.ts`
- une base D1 pour les données métier
- R2 pour le stockage des pièces justificatives
- HelloAsso pour le paiement en ligne

## Structure

- `public/index.html` : page d'inscription servie à la racine
- `public/assets/` : CSS et JavaScript du frontend
- `src/index.ts` : routage du worker
- `src/routes/api/public/inscription-config.js` : configuration publique du formulaire
- `src/routes/api/public/inscription.js` : création du dossier + session HelloAsso
- `src/routes/api/public/payment/helloasso/status.js` : validation du paiement et finalisation métier
- `migrations/` : schéma D1

## Pré-requis

- Node.js
- `npm install`
- compte Cloudflare avec Worker, D1 et R2 configurés
- secrets HelloAsso configurés dans Cloudflare si le paiement en ligne est actif

## Scripts

```bash
npm install
npm run check
npm run deploy
```

Scripts disponibles :

- `npm run check` : TypeScript + `wrangler deploy --dry-run`
- `npm run deploy` : applique les migrations D1 distantes puis déploie le worker
- `npm run dev` : applique les migrations locales puis lance Wrangler en local
- `npm run cf-typegen` : régénère `worker-configuration.d.ts`

## Déploiement

Le projet est prévu pour être publié via Wrangler :

```bash
npm run deploy
```

Le domaine public peut être raccordé :

- soit via `workers.dev`
- soit via un `CNAME` externe pointant vers l'URL `workers.dev` du worker

## Variables et bindings

La configuration principale se trouve dans `wrangler.json`.

Bindings attendus :

- `DB` : base D1
- `R2_STORAGE` : bucket des pièces justificatives
- `R2_PDF` : bucket PDF
- `ASSETS` : assets statiques

Variables non sensibles déjà déclarées :

- `APP_NAME`
- `SUPABASE_EXPORT_DIR`
- `SIGNUP_ALERT_TO`
- `SIGNUP_ALERT_FROM`
- `SIGNUP_ALERT_SENDER_NAME`
- `SIGNUP_ALERT_TO_NAME`
- `PAYMENT_CURRENCY`
- `HELLOASSO_ORGANIZATION_SLUG`
- `HELLOASSO_ENV`

Secrets attendus côté Cloudflare selon l'environnement :

- `HELLOASSO_CLIENT_ID`
- `HELLOASSO_CLIENT_SECRET`

Optionnel :

- `PUBLIC_ORIGIN` pour forcer l'origine publique canonique si besoin
- `HELLOASSO_NOTIFICATION_SIGNATURE_KEY` si vous utilisez une signature webhook HelloAsso

## URLs publiques

- `/` : formulaire d'inscription
- `/inscription`, `/inscription/` : redirections de compatibilité vers `/`
- `/inscription-config` : configuration publique du formulaire
- `/api/public/inscription` : soumission du dossier
- `/api/public/payment/helloasso/status` : vérification du paiement HelloAsso
- `/api/public/payment/helloasso/notification` : webhook HelloAsso `Order` / `Payment`
