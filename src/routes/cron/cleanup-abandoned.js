/**
 * AFFBC — Cron : purge des inscriptions abandonnées
 *
 * À placer dans : inscription-americanfullfightingbons/src/routes/cron/cleanup-abandoned.js
 *
 * Déclenché automatiquement par Cloudflare Workers Cron Triggers
 * selon le planning configuré dans wrangler.json (triggers.crons).
 *
 * Cible les inscriptions restées bloquées au-delà de ABANDONED_AFTER_HOURS
 * sans qu'un paiement HelloAsso ait été confirmé (adherent_id toujours NULL) :
 *
 *   - "paiement_en_attente" : checkout HelloAsso créé, utilisateur parti sans payer
 *   - "brouillon"           : handler a planté entre l'INSERT et le checkout (rare)
 *   - "echec_creation"      : handler a déjà nettoyé les fichiers, on purge la ligne DB
 *
 * Pour chacune :
 *   1. Supprime les fichiers R2 référencés dans documents_json
 *   2. Passe le statut à "abandonnee" et vide documents_json
 *
 * Idempotent : peut être appelé plusieurs fois sans effet de bord.
 */

const ABANDONED_AFTER_HOURS = 48; // délai de grâce avant purge (heures)
const BATCH_SIZE = 50;            // max d'inscriptions traitées par exécution

/**
 * Supprime les fichiers R2 d'une inscription à partir de son documents_json.
 * Chaque entrée a la forme : { bucket: "fullfighting-pdf"|"storage", key: "public-inscriptions/…" }
 */
async function deleteRegistrationFiles(env, documentsJson) {
  let docs = {};
  try {
    docs = typeof documentsJson === "string"
      ? JSON.parse(documentsJson || "{}")
      : (documentsJson || {});
  } catch {
    docs = {};
  }

  const results = [];
  for (const [docKey, doc] of Object.entries(docs)) {
    if (!doc?.key) continue;
    // Le champ "bucket" contient le nom logique ("fullfighting-pdf" ou "storage")
    const bucket = doc.bucket === "storage" ? env.R2_STORAGE : env.R2_PDF;
    if (!bucket) {
      results.push({ docKey, key: doc.key, status: "no_bucket" });
      continue;
    }
    try {
      await bucket.delete(doc.key);
      results.push({ docKey, key: doc.key, status: "deleted" });
    } catch (err) {
      results.push({ docKey, key: doc.key, status: "error", error: err?.message });
    }
  }
  return results;
}

/**
 * Traite un lot d'inscriptions abandonnées.
 * @returns {{ processed: number, errors: number, details: Array }}
 */
async function processAbandonedBatch(env, db, cutoffIso) {
  const rows = await db
    .prepare(
      `SELECT id, statut, documents_json
       FROM inscriptions_publiques
       WHERE statut IN ('paiement_en_attente', 'brouillon', 'echec_creation')
         AND adherent_id IS NULL
         AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(cutoffIso, BATCH_SIZE)
    .all();

  const inscriptions = rows?.results || [];
  if (!inscriptions.length) return { processed: 0, errors: 0, details: [] };

  const details = [];
  let processed = 0;
  let errors = 0;

  for (const row of inscriptions) {
    try {
      // 1. Supprimer les fichiers R2 (seulement s'il y en a)
      const fileDeletions = await deleteRegistrationFiles(env, row.documents_json);

      // 2. Marquer en "abandonnee" et vider documents_json pour éviter
      //    toute tentative de suppression ultérieure
      await db
        .prepare(
          `UPDATE inscriptions_publiques
           SET statut = 'abandonnee',
               documents_json = ?,
               updated_at = ?
           WHERE id = ? AND adherent_id IS NULL`,
        )
        .bind(
          JSON.stringify({}),
          new Date().toISOString(),
          row.id,
        )
        .run();

      details.push({ id: row.id, statut: row.statut, files: fileDeletions, status: "purged" });
      processed++;
    } catch (err) {
      console.error(`[cron/cleanup] Erreur pour inscription ${row.id}:`, err?.message ?? String(err));
      details.push({ id: row.id, status: "error", error: err?.message });
      errors++;
    }
  }

  return { processed, errors, details };
}

/**
 * Point d'entrée appelé depuis l'export "scheduled" de src/index.ts.
 */
export async function handleCleanupCron(env) {
  if (!env.DB) {
    console.error("[cron/cleanup] D1 binding (DB) manquant");
    return { ok: false, error: "D1 binding manquant" };
  }

  const cutoff = new Date(Date.now() - ABANDONED_AFTER_HOURS * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  console.log(`[cron/cleanup] Démarrage — cutoff : ${cutoffIso}`);
  const result = await processAbandonedBatch(env, env.DB, cutoffIso);
  console.log(`[cron/cleanup] Terminé — ${result.processed} purgées, ${result.errors} erreurs`);

  return {
    ok: true,
    cutoff: cutoffIso,
    processed: result.processed,
    errors: result.errors,
    details: result.details,
  };
}
