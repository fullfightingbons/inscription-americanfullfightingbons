PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS club_info (
  cle TEXT PRIMARY KEY,
  valeur TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS utilisateurs (
  id TEXT PRIMARY KEY,
  prenom TEXT,
  nom TEXT,
  email TEXT,
  mot_de_passe TEXT,
  role TEXT,
  actif INTEGER,
  must_change_password INTEGER DEFAULT 0,
  perm_adherents TEXT,
  perm_banque TEXT,
  perm_comptabilite TEXT,
  perm_achats TEXT,
  perm_facturation TEXT,
  perm_administration TEXT,
  password_changed_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS exercices (
  id TEXT PRIMARY KEY,
  libelle TEXT,
  date_debut TEXT,
  date_fin TEXT,
  statut TEXT,
  created_at TEXT,
  updated_at TEXT,
  date_cloture TEXT
);

CREATE TABLE IF NOT EXISTS adherents (
  id TEXT PRIMARY KEY,
  nom TEXT,
  prenom TEXT,
  naissance TEXT,
  email TEXT,
  telephone TEXT,
  adresse TEXT,
  code_postal TEXT,
  ville TEXT,
  discipline TEXT,
  droit_image INTEGER,
  certificat INTEGER,
  pass_region INTEGER,
  montant_pass_region REAL,
  reglement INTEGER,
  cotisation REAL,
  paiement TEXT,
  statut TEXT,
  date_inscription TEXT,
  date_fin_adhesion TEXT,
  urgence_nom TEXT,
  urgence_telephone TEXT,
  urgence_lien TEXT,
  notes TEXT,
  pdf_storage_path TEXT,
  pdf_public_url TEXT,
  pdf_nom_fichier TEXT,
  pdf_uploaded_at TEXT,
  source_logiciel TEXT,
  exercice_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  couleur_ceinture TEXT,
  numero_licence TEXT,
  FOREIGN KEY (exercice_id) REFERENCES exercices(id)
);

CREATE TABLE IF NOT EXISTS comptes_bancaires (
  id TEXT PRIMARY KEY,
  nom TEXT,
  numero TEXT,
  solde_initial REAL,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  compte_id TEXT,
  date_op TEXT,
  date_valeur TEXT,
  libelle TEXT,
  debit REAL,
  credit REAL,
  rapproche INTEGER,
  ecriture_piece TEXT,
  source_document TEXT,
  source_format TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (compte_id) REFERENCES comptes_bancaires(id)
);

CREATE TABLE IF NOT EXISTS journal_comptable (
  id TEXT PRIMARY KEY,
  date_op TEXT,
  piece TEXT,
  compte TEXT,
  libelle TEXT,
  debit REAL,
  credit REAL,
  source_type TEXT,
  source_id TEXT,
  source_logiciel TEXT,
  exercice_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (exercice_id) REFERENCES exercices(id)
);

CREATE TABLE IF NOT EXISTS achats (
  id TEXT PRIMARY KEY,
  date_op TEXT,
  fournisseur TEXT,
  designation TEXT,
  categorie TEXT,
  montant REAL,
  mode_paiement TEXT,
  reference_paiement TEXT,
  statut TEXT,
  piece TEXT,
  notes TEXT,
  exercice_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  pdf_storage_path TEXT,
  pdf_public_url TEXT,
  pdf_nom_fichier TEXT,
  pdf_uploaded_at TEXT,
  FOREIGN KEY (exercice_id) REFERENCES exercices(id)
);

CREATE TABLE IF NOT EXISTS factures (
  id TEXT PRIMARY KEY,
  numero TEXT,
  date_op TEXT,
  destinataire TEXT,
  adresse TEXT,
  objet TEXT,
  lignes TEXT,
  statut TEXT,
  notes TEXT,
  exercice_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (exercice_id) REFERENCES exercices(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT,
  FOREIGN KEY (user_id) REFERENCES utilisateurs(id)
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  ip TEXT PRIMARY KEY,
  failures INTEGER DEFAULT 0,
  last_failure_at TEXT,
  blocked_until TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_utilisateurs_email ON utilisateurs(email);
CREATE INDEX IF NOT EXISTS idx_utilisateurs_role ON utilisateurs(role);
CREATE INDEX IF NOT EXISTS idx_adherents_exercice_id ON adherents(exercice_id);
CREATE INDEX IF NOT EXISTS idx_adherents_nom ON adherents(nom, prenom);
CREATE INDEX IF NOT EXISTS idx_adherents_statut ON adherents(statut);
CREATE INDEX IF NOT EXISTS idx_adherents_fin_adhesion ON adherents(date_fin_adhesion);
CREATE INDEX IF NOT EXISTS idx_transactions_compte_id ON transactions(compte_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date_op ON transactions(date_op);
CREATE INDEX IF NOT EXISTS idx_transactions_rapproche ON transactions(rapproche, date_op);
CREATE INDEX IF NOT EXISTS idx_journal_exercice_id ON journal_comptable(exercice_id);
CREATE INDEX IF NOT EXISTS idx_journal_piece ON journal_comptable(piece);
CREATE INDEX IF NOT EXISTS idx_journal_date_op ON journal_comptable(date_op);
CREATE INDEX IF NOT EXISTS idx_achats_exercice_id ON achats(exercice_id);
CREATE INDEX IF NOT EXISTS idx_achats_statut ON achats(statut, date_op);
CREATE INDEX IF NOT EXISTS idx_factures_exercice_id ON factures(exercice_id);
CREATE INDEX IF NOT EXISTS idx_factures_statut ON factures(statut, date_op);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id, created_at DESC);
