/**
 * Certificat médical à l'inscription : pièce jointe OU engagement à la fournir.
 *
 * Le certificat reste OBLIGATOIRE pour les mineurs et dès qu'une réponse du
 * questionnaire de santé (QS-Sport) est positive (cf. validatePayload() dans
 * api/public/inscription.js). Mais un adhérent peut ne pas l'avoir sous la
 * main le jour de l'inscription : plutôt que de bloquer le parcours (et le
 * paiement), il peut cocher une case d'engagement à le fournir au plus vite.
 *
 * Troisième issue, au RENOUVELLEMENT : si un certificat a déjà été validé et
 * reste dans sa durée de validité (3 ans réglementaires), il est réutilisé et
 * l'adhérent n'a rien à fournir (cf. evaluateCertificateReuse ci-dessous).
 *
 * Les décisions (resolveCertificateSubmission, evaluateCertificateReuse) sont des
 * fonctions pures, sans accès base/réseau, pour pouvoir les tester directement et
 * les partager entre l'enregistrement du dossier, le PDF et les e-mails ;
 * seul findReusableCertificate lit la base.
 *
 * Suite côté `gestion` : la fiche reste « certificat manquant » (certificat = 0)
 * et un rappel e-mail automatique part tant que le bureau n'a pas validé la
 * pièce (cf. checkCertificatsEnAttente dans gestion/src/index.ts). Le drapeau
 * `computedTotals.certificateDeferred` écrit dans dossier_json est ce que
 * `gestion` relit : aucune colonne ni migration n'est nécessaire ici.
 */

// Libellé exact affiché à côté de la case (public/index.html) — conservé ici
// pour que les e-mails et le PDF citent le même engagement.
export const CERTIFICATE_COMMITMENT_TEXT =
  "Je m'engage à fournir le certificat médical au plus vite, à défaut, l'accès aux entraînements me sera refusé";

/**
 * @param {object} input
 * @param {boolean} input.required    Certificat obligatoire (mineur ou QS positif)
 * @param {boolean} input.hasFile     Un fichier de certificat a été envoyé avec le formulaire
 * @param {boolean} input.commitment  La case d'engagement est cochée
 * @param {boolean} [input.reusable]  Un certificat déjà validé et encore valable existe pour cet adhérent
 * @returns {{ deferred: boolean, reused: boolean, commitment: boolean, error: string|null }}
 *   - deferred   : certificat obligatoire, non fourni, mais engagement pris
 *   - reused     : certificat obligatoire, non joint, mais un certificat validé encore valable est réutilisé
 *   - commitment : valeur d'engagement À ENREGISTRER (jamais vraie si une pièce est jointe, si un
 *                  certificat est réutilisé ou si le certificat n'est pas exigé : pas d'engagement sans objet)
 *   - error      : message à renvoyer à l'adhérent si ni pièce, ni certificat réutilisable, ni engagement
 *
 * Ordre de priorité : une pièce jointe l'emporte toujours (plus récente que le dossier existant),
 * puis le certificat réutilisable, puis l'engagement.
 */
export function resolveCertificateSubmission({ required, hasFile, commitment, reusable }) {
  const none = { deferred: false, reused: false, commitment: false, error: null };
  if (!required) return none;
  if (hasFile) return none;
  if (reusable === true) return { ...none, reused: true };
  if (commitment === true) return { ...none, deferred: true, commitment: true };
  return {
    ...none,
    error:
      "Le certificat médical est obligatoire pour votre profil : joignez-le, ou cochez la case d'engagement à le fournir au plus vite.",
  };
}

// ─── Réutilisation d'un certificat déjà validé (renouvellement) ─────────────

// Plafond réglementaire : un certificat médical d'aptitude vaut 3 ans.
export const CERTIFICATE_MAX_VALIDITY_MONTHS = 36;
// Même repli que gestion (checkCertificatsExpirants, profil espace membre) quand
// club_info.duree_validite_certificat_mois est absente ou illisible.
const CERTIFICATE_FALLBACK_VALIDITY_MONTHS = 12;

/**
 * Durée de validité retenue pour la réutilisation, en mois : celle de l'onglet Club
 * de gestion (club_info.duree_validite_certificat_mois), jamais au-delà de 3 ans.
 * Lire la même valeur que gestion garantit qu'on ne réutilise jamais un certificat
 * que gestion considère déjà expiré (et pour lequel il enverrait une relance).
 */
export function certificateValidityMonths(raw) {
  const configured = Math.floor(Number(String(raw ?? "").trim())) || CERTIFICATE_FALLBACK_VALIDITY_MONTHS;
  return Math.min(Math.max(configured, 1), CERTIFICATE_MAX_VALIDITY_MONTHS);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const toIsoDay = (v) => (ISO_DAY.test(String(v || "")) ? String(v).slice(0, 10) : "");

function addMonthsIso(isoDay, months) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function parseJsonObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Un certificat validé est-il encore réutilisable ?
 *
 * Fonction pure. Conditions cumulatives :
 *  1. la fiche est cochée « Certificat » (adherents.certificat = 1 : fourni et validé) ;
 *  2. on sait DATER ce certificat. Sources, la plus récente l'emporte :
 *       - adherents.certificat_date (date saisie : dépôt par l'adhérent depuis l'espace membre) ;
 *       - la date de dépôt d'une inscription où un certificat a été JOINT (documents_json) :
 *         le certificat date au plus de ce jour-là ;
 *       - la date d'origine reportée par une inscription qui avait déjà réutilisé un certificat
 *         (computedTotals.certificateReferenceDate) : la chaîne ne prolonge jamais la validité.
 *     Sans date, rien n'est réutilisé : « Certificat = 1 » vaut aussi pour un adulte dispensé,
 *     qui n'a donc aucun certificat ;
 *  3. date + durée de validité >= aujourd'hui.
 *
 * @param {{ certificat: unknown, certificatDate?: string|null, registrations?: Array<{dossier_json?: unknown, documents_json?: unknown, submitted_at?: string|null, created_at?: string|null}>, validityMonths: number, today: string }} input
 * @returns {{ reusable: boolean, reason: string, referenceDate: string|null, validUntil: string|null }}
 */
export function evaluateCertificateReuse({ certificat, certificatDate, registrations, validityMonths, today }) {
  const no = (reason, extra = {}) => ({ reusable: false, reason, referenceDate: null, validUntil: null, ...extra });
  const validated = certificat === 1 || certificat === true || String(certificat ?? "").trim() === "1";
  if (!validated) return no("not_validated");

  const candidates = [];
  const explicit = toIsoDay(certificatDate);
  if (explicit) candidates.push(explicit);
  for (const reg of registrations || []) {
    const docs = parseJsonObject(reg?.documents_json);
    if (docs?.medicalCertificate) {
      const day = toIsoDay(reg.submitted_at || reg.created_at);
      if (day) candidates.push(day);
    }
    const totals = parseJsonObject(reg?.dossier_json)?.computedTotals;
    if (totals?.certificateReused === true) {
      const day = toIsoDay(totals.certificateReferenceDate);
      if (day) candidates.push(day);
    }
  }

  // Une date postérieure à aujourd'hui est une donnée incohérente : ignorée.
  const usable = candidates.filter((d) => d <= today).sort();
  const referenceDate = usable.length ? usable[usable.length - 1] : "";
  if (!referenceDate) return no("no_date");

  const validUntil = addMonthsIso(referenceDate, validityMonths);
  if (!validUntil) return no("no_date");
  if (validUntil < today) return no("expired", { referenceDate, validUntil });
  return { reusable: true, reason: "reusable", referenceDate, validUntil };
}

/**
 * Lit en base ce qu'il faut pour evaluateCertificateReuse. Ne lève jamais : en cas
 * d'erreur de lecture, le certificat n'est simplement pas réutilisé (on le demande
 * comme avant), ce qui est le comportement sûr.
 *
 * @param {{ prepare: Function }} db  Binding D1
 * @param {string} adherentId         Fiche déjà identifiée (nom + prénom + naissance + e-mail vérifiés)
 */
export async function findReusableCertificate(db, adherentId, now = new Date()) {
  try {
    if (!db || !adherentId) return { reusable: false, reason: "no_adherent", referenceDate: null, validUntil: null };
    const adherent = await db
      .prepare(`SELECT certificat, certificat_date FROM adherents WHERE id = ?`)
      .bind(String(adherentId))
      .first();
    if (!adherent) return { reusable: false, reason: "no_adherent", referenceDate: null, validUntil: null };

    const { results } = await db
      .prepare(`SELECT dossier_json, documents_json, submitted_at, created_at FROM inscriptions_publiques WHERE adherent_id = ?`)
      .bind(String(adherentId))
      .all();
    const duree = await db
      .prepare(`SELECT valeur FROM club_info WHERE cle = 'duree_validite_certificat_mois' LIMIT 1`)
      .first();

    return evaluateCertificateReuse({
      certificat: adherent.certificat,
      certificatDate: adherent.certificat_date,
      registrations: results || [],
      validityMonths: certificateValidityMonths(duree?.valeur),
      today: now.toISOString().slice(0, 10),
    });
  } catch {
    return { reusable: false, reason: "lookup_failed", referenceDate: null, validUntil: null };
  }
}
