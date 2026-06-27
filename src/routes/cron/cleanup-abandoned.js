/**
 * AFFBC — Cron : purge des inscriptions abandonnées
 *
 * Déclenché par le cron Cloudflare Workers (voir wrangler.json → triggers.crons).
 * Supprime les fichiers R2 et marque comme "abandonnee" les inscriptions restées
 * bloquées en statut "paiement_en_attente" sans paiement confirmé au-delà de la
 * durée de grâce (ABANDONED_AFTER_HOURS, défaut 48 h).
 *
 * Statuts couverts :
 *  - "paiement_en_attente" : checkout HelloAsso créé mais jamais validé
 *  - "brouillon"           : ligne créée mais étapes suivantes échouées (normalement
 *                            déjà passée en "echec_creation" par le handler, mais on
 *                            couvre le cas d'une coupure entre les deux)
 *  - "echec_creation"      : inscription échouée (fichiers déjà supprimés par le
 *                            handler, mais on nettoie la ligne DB si trop vieille)
 *
 * Ce handler est idempotent : il peut être appelé plusieurs fois sans effet de bord.
 */

const ABANDONED_AFTER_HOURS = 48; // grâce de 48 h avant purge
const BATCH_SIZE = 50;             // max d'inscriptions traitées par exécution cron

/**
 * Supprime les fichiers R2 associés à une inscription.
 * Les clés sont stockées dans documents_json (objet plat : { photoIdentity, medicalCertificate, … }).
 * Chaque entrée a la forme { bucket: "fullfighting-pdf" | "storage", key: "public-inscriptions/…" }.
 */
async function deleteRegistrationFiles(env, documentsJson, registrationId) {
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

  // Supprimer aussi le PDF d'inscription généré si présent dans R2
  // (stocké sous adherents/{adherentId}/inscription-{registrationId}.pdf)
  // → Dans ce cas aucun adhérent n'a été créé (pas de paiement), donc pas de
  //   pdf_storage_path à chercher. Rien à faire.

  return results;
}

/**
 * Traite un lot d'inscriptions abandonnées.
 * @returns {{ processed: number, errors: number, details: object[] }}
 */
async function processAbandonedBatch(env, db, cutoffIso) {
  const rows = await db
    .prepare(
      `SELECT id, statut, documents_json, adherent_id, created_at, updated_at
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
      // 1. Suppression des fichiers R2
      const fileDeletions = await deleteRegistrationFiles(env, row.documents_json, row.id);

      // 2. Mise à jour du statut en DB
      await db
        .prepare(
          `UPDATE inscriptions_publiques
           SET statut = 'abandonnee',
               documents_json = ?,
               updated_at = ?
           WHERE id = ? AND adherent_id IS NULL`,
        )
        .bind(
          JSON.stringify({}), // on vide documents_json pour éviter des tentatives futures
          new Date().toISOString(),
          row.id,
        )
        .run();

      details.push({
        id: row.id,
        statut: row.statut,
        files: fileDeletions,
        status: "purged",
      });
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
 * Point d'entrée du Cron Trigger Cloudflare Workers.
 * Appelé via l'export "scheduled" du worker principal (src/index.ts).
 */
export async function handleCleanupCron(env) {
  if (!env.DB) {
    console.error("[cron/cleanup] D1 binding manquant");
    return { ok: false, error: "D1 binding manquant" };
  }

  const cutoff = new Date(Date.now() - ABANDONED_AFTER_HOURS * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  console.log(`[cron/cleanup] Démarrage — cutoff : ${cutoffIso}`);

  const result = await processAbandonedBatch(env, env.DB, cutoffIso);

  console.log(
    `[cron/cleanup] Terminé — ${result.processed} purgées, ${result.errors} erreurs`,
  );

  return {
    ok: true,
    cutoff: cutoffIso,
    processed: result.processed,
    errors: result.errors,
    details: result.details,
  };
}
