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
- `src/routes/api/public/payment/helloasso/resume.js` : reprise du paiement d'un dossier déjà enregistré (nouveau checkout)
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

## E-mail de confirmation de paiement

Quand le paiement HelloAsso est confirmé (`payment/helloasso/status.js` → `sendPaymentConfirmedAlert`), **un seul e-mail Brevo** part au club et à l'adhérent, avec **deux pièces jointes distinctes** :

- `inscription-affbc-XXXXXXXX.pdf` : le dossier récapitulatif (questionnaire de santé, consentements, pièces déposées fusionnées) ;
- `Recu-cotisation-<Prénom>-<NOM>-<saison>.pdf` : le reçu de cotisation — cotisation, Pass Région, t-shirt, pantalon, passeport sportif et produits en option, avec l'état du paiement quand il est en 2 ou 3 fois.

Le reçu est un fichier **séparé** du récapitulatif pour que l'adhérent puisse le transmettre (employeur, comité d'entreprise, mutuelle) sans communiquer ses données de santé.

- C'est **le même document** que le bouton « Reçu » de l'onglet Adhérents de `gestion` (mêmes lignes, même total, même numéro `REC-<saison>-<id adhérent>`). Son code, `src/routes/_lib/cotisation-receipt.js`, est une **copie** de `gestion/src/lib/pdf/cotisation-receipt.ts` : les deux fichiers doivent être modifiés ensemble (les tests de chaque repo portent les mêmes valeurs de référence).
- Un échec de génération du reçu n'empêche jamais l'envoi : l'e-mail part avec le seul récapitulatif et le signale. Si Brevo refuse l'envoi (erreur 4xx) alors que le reçu est joint, l'e-mail est renvoyé sans lui.
- Pas de reçu pour une inscription gratuite (total nul).
- Les e-mails envoyés à la **réception** du dossier (avant paiement) n'ont pas de reçu : rien n'est encore réglé.
- Limites Brevo : 4 Mo par pièce jointe, 20 Mo par message.

Secret Cloudflare : `BREVO_API_KEY` (sans lui, aucun e-mail n'est envoyé).

## Retour depuis HelloAsso et reprise du paiement

Le lien de paiement HelloAsso n'est valable que **15 minutes**. Un adhérent peut quitter la page à tout moment (flèche retour, erreur technique, refus bancaire / 3-D Secure, onglet fermé). Le dossier et les pièces jointes sont alors déjà enregistrés (statut `paiement_en_attente`) et **conservés 48 h** avant purge par le cron (`cron/cleanup-abandoned.js`).

- Les trois URLs de retour envoyées à HelloAsso portent la référence du dossier : `/?helloasso=success&ref=…` (paiement), `/?helloasso=cancel&ref=…` (flèche retour), `/?helloasso=error&ref=…` (erreur technique ; HelloAsso y ajoute `checkoutIntentId` et `error`).
- Au retour sans paiement, le navigateur vérifie d'abord si le paiement n'a pas abouti malgré tout, puis affiche « Reprenez votre paiement » avec un bouton qui appelle `POST /api/public/payment/helloasso/resume`. Rien n'est à ressaisir ni à renvoyer.
- Le brouillon du formulaire n'est effacé qu'une fois le paiement **confirmé**. Le dossier en attente est mémorisé dans le navigateur (`localStorage`, clé `affbc_pending_payment`) : à la visite suivante, l'état du dossier est vérifié avant d'afficher un formulaire vierge (évite aussi de payer deux fois).
- L'e-mail de réception du dossier contient un lien de reprise : `/?helloasso=resume&ref=<id du dossier>`. Le club peut aussi l'envoyer à la main à un adhérent bloqué (l'id est dans `inscriptions_publiques`), tant que le dossier est en `paiement_en_attente`.
- Côté serveur, `resume.js` : (1) refuse un dossier expiré (`abandonnee`) ; (2) **vérifie d'abord qu'aucune tentative précédente n'a été payée** (via `status.js`, qui finalise alors le dossier) et refuse d'ouvrir un second paiement si HelloAsso est injoignable ; (3) crée un nouveau checkout à partir du dossier stocké (l'adhérent peut changer le nombre d'échéances) ; (4) garde l'ancien identifiant dans `dossier_json.payment.previousCheckoutIntentIds`, que `status.js` relit pour retrouver un paiement fait sur un ancien lien. Plafond : 8 reprises par dossier.
- Ce traitement passe **avant** l'état « inscriptions fermées » : quelqu'un qui a déjà envoyé son dossier peut toujours terminer son paiement.

## URLs publiques

- `/` : formulaire d'inscription
- `/inscription`, `/inscription/` : redirections de compatibilité vers `/`
- `/inscription-config` : configuration publique du formulaire
- `/api/public/inscription` : soumission du dossier
- `/api/public/payment/helloasso/status` : vérification du paiement HelloAsso
- `/api/public/payment/helloasso/notification` : webhook HelloAsso `Order` / `Payment`
- `/api/public/payment/helloasso/resume` : reprise du paiement d'un dossier en attente (`POST`, JSON `{ registrationId, installmentCount? }`)

## URL admin optionnelle

- `GET /api/admin/inscription/status` : agrégats non nominatifs des dossiers publics, protégé par `Authorization: Bearer $INSCRIPTION_ADMIN_STATUS_TOKEN`. La route renvoie `503` tant que le secret n'est pas configuré.
