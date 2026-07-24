-- Corrige un décalage entre le code et le schéma : `free-registration.js`
-- et `payment/helloasso/status.js` écrivent tous les deux dans les colonnes
-- `pdf_inscription_storage_path` / `pdf_inscription_public_url` /
-- `pdf_inscription_nom_fichier` / `pdf_inscription_uploaded_at` de la table
-- `adherents`, colonnes qui n'ont jamais été créées par la migration 0001.
-- Résultat : la finalisation d'une inscription gratuite ET la confirmation
-- de paiement HelloAsso échouaient systématiquement avec l'erreur
-- "no such column: pdf_inscription_storage_path" au moment d'enregistrer
-- le PDF du dossier d'inscription sur la fiche adhérent.
--
-- IMPORTANT : on n'a PAS renommé les colonnes existantes `pdf_storage_path`
-- / `pdf_public_url` / `pdf_nom_fichier` / `pdf_uploaded_at`, car le worker
-- `gestion` les utilise pour un objet distinct — la "fiche de notation"
-- (coach/secrétaire) — et interroge déjà les deux familles de colonnes
-- ensemble dans une même requête (cf. gestion/src/index.ts, endpoint
-- suppression adhérent). Ce sont bien deux PDF différents rattachés au même
-- adhérent : on ajoute donc les colonnes manquantes plutôt que de réutiliser
-- ou renommer les existantes.
ALTER TABLE adherents ADD COLUMN pdf_inscription_storage_path TEXT;
ALTER TABLE adherents ADD COLUMN pdf_inscription_public_url   TEXT;
ALTER TABLE adherents ADD COLUMN pdf_inscription_nom_fichier  TEXT;
ALTER TABLE adherents ADD COLUMN pdf_inscription_uploaded_at  TEXT;
