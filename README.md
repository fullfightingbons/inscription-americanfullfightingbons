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

Les informations bancaires réelles (`BANK_IBAN`, `BANK_BIC`, etc.) ne doivent pas être ajoutées dans `wrangler.json`, car ce fichier est versionné en clair. La configuration publique d'inscription lit d'abord les champs `club_info.public_inscription_*` dans la base D1 partagée, éditable depuis l'admin gestion. Si un fallback par variable d'environnement devient nécessaire, utiliser `wrangler secret put`.

Secrets attendus côté Cloudflare selon l'environnement :

- `HELLOASSO_CLIENT_ID`
- `HELLOASSO_CLIENT_SECRET`

Optionnel :

- `PUBLIC_ORIGIN` pour forcer l'origine publique canonique si besoin
- `HELLOASSO_NOTIFICATION_SIGNATURE_KEY` — **uniquement pertinent pour un compte HelloAsso « partenaire »** (cf. dev.helloasso.com/docs/secure-webhook). Un compte association standard (authentification par `HELLOASSO_CLIENT_ID`/`HELLOASSO_CLIENT_SECRET`, ce qui est le cas ici) ne reçoit jamais de `x-ha-signature` : laisser ce secret vide. `verifyHelloAssoNotification` (notification-helpers.js) se rabat alors sur la vérification par adresse IP source (51.138.206.200 en production, 4.233.135.234 en sandbox), documentée par HelloAsso pour ce cas.
- `INSCRIPTION_ADMIN_STATUS_TOKEN` pour activer `/api/admin/inscription/status`, une route admin en lecture seule qui renvoie uniquement des agrégats de dossiers

### ⚠️ Étape manuelle obligatoire : enregistrer l'URL de webhook auprès de HelloAsso

Rien dans ce dépôt (ni `wrangler.json`, ni un script de déploiement) n'enregistre automatiquement l'URL de notification auprès de HelloAsso — **c'est une étape à faire une fois, manuellement, dans leur interface**, sans quoi `/api/public/payment/helloasso/notification` ne recevra jamais aucun appel. Sans ce webhook, la finalisation d'une inscription (création de la fiche adhérent, du PDF, de l'écriture comptable) ne repose plus que sur le retour du navigateur après paiement — peu fiable si l'onglet se ferme avant la fin du polling (~10 s).

Pour l'enregistrer (compte association, pas partenaire) : se connecter sur helloasso.com, **Mon Compte > Intégrations et API**, et renseigner :

```
https://inscription.americanfullfightingbons.fr/api/public/payment/helloasso/notification
```

À refaire pour chaque nouvel environnement (sandbox vs production ont des URLs de notification distinctes).

## URLs publiques

- `/` : formulaire d'inscription
- `/inscription`, `/inscription/` : redirections de compatibilité vers `/`
- `/inscription-config` : configuration publique du formulaire
- `/api/public/inscription` : soumission du dossier
- `/api/public/payment/helloasso/status` : vérification du paiement HelloAsso
- `/api/public/payment/helloasso/notification` : webhook HelloAsso `Order` / `Payment`

## URL admin optionnelle

- `GET /api/admin/inscription/status` : agrégats non nominatifs des dossiers publics, protégé par `Authorization: Bearer $INSCRIPTION_ADMIN_STATUS_TOKEN`. La route renvoie `503` tant que le secret n'est pas configuré.
