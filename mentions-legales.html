PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inscriptions_publiques (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  prenom TEXT NOT NULL,
  email TEXT NOT NULL,
  telephone TEXT NOT NULL,
  naissance TEXT NOT NULL,
  ville TEXT NOT NULL,
  formule_code TEXT NOT NULL,
  pratique_type TEXT NOT NULL,
  montant_total REAL NOT NULL,
  paiement_mode TEXT NOT NULL,
  paiement_reference TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'nouvelle',
  mineur INTEGER NOT NULL DEFAULT 0,
  pass_region INTEGER NOT NULL DEFAULT 0,
  droit_image INTEGER NOT NULL DEFAULT 0,
  reglement_accepte INTEGER NOT NULL DEFAULT 0,
  adherent_id TEXT,
  dossier_json TEXT NOT NULL,
  documents_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  helloasso_checkout_intent_id TEXT,
  helloasso_url TEXT,
  exercice_id TEXT,
  FOREIGN KEY (adherent_id) REFERENCES adherents(id),
  FOREIGN KEY (exercice_id) REFERENCES exercices(id)
);

CREATE INDEX IF NOT EXISTS idx_inscriptions_publiques_email ON inscriptions_publiques(email);
CREATE INDEX IF NOT EXISTS idx_inscriptions_publiques_statut ON inscriptions_publiques(statut, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inscriptions_publiques_created_at ON inscriptions_publiques(created_at DESC);
