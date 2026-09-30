/**
 * AFFBC — Accès « CSE Thalès » hors période d'ouverture des inscriptions.
 *
 * Quand les inscriptions sont fermées au public (club_info.public_inscription_enabled
 * à 0), les membres du CSE Thalès doivent pouvoir continuer à s'inscrire toute
 * l'année. L'accès est protégé par un code secret, défini dans le logiciel de
 * gestion (Tarifs en ligne → « Accès CSE Thalès ») et stocké dans
 * club_info.public_inscription_cse_code.
 *
 * Règles de sécurité :
 *  - Le code n'est JAMAIS renvoyé au navigateur (la config publique n'expose
 *    qu'un booléen `cseAccessEnabled`).
 *  - Aucune valeur par défaut : code absent ou trop court = fonctionnalité
 *    désactivée (l'accès reste fermé).
 *  - La comparaison se fait sur des empreintes SHA-256 (temps constant).
 *  - Le code n'ouvre QUE le tarif « cse_thales » : cette restriction est
 *    imposée côté serveur dans /api/public/inscription, pas seulement masquée
 *    dans l'interface.
 */

export const CSE_ACCESS_CODE_KEY = "public_inscription_cse_code";
export const CSE_ACCESS_HEADER = "X-CSE-Access-Code";
export const CSE_ACCESS_FORMULA = "cse_thales";

// Longueur minimale (après normalisation) pour qu'un code soit pris en compte.
// Doit rester alignée avec la validation du logiciel de gestion.
export const CSE_ACCESS_MIN_LENGTH = 8;

/**
 * Normalise un code : insensible à la casse, aux espaces et aux tirets, pour
 * tolérer « ABCD-EFGH-JKLM », « abcd efgh jklm » ou « abcdefghjklm ».
 */
export function normalizeCseCode(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

/** Vrai si la valeur stockée en base constitue un code exploitable. */
export function isUsableCseCode(value) {
  return normalizeCseCode(value).length >= CSE_ACCESS_MIN_LENGTH;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function constantTimeEquals(left, right) {
  const [a, b] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Lit le code attendu en base. Retourne une chaîne normalisée, ou "" si la
 * fonctionnalité est désactivée (clé absente, vide, trop courte ou erreur D1).
 */
export async function loadCseAccessCode(db) {
  try {
    const row = await db
      .prepare(`SELECT valeur FROM club_info WHERE cle = ? LIMIT 1`)
      .bind(CSE_ACCESS_CODE_KEY)
      .first();
    const code = normalizeCseCode(row?.valeur);
    return code.length >= CSE_ACCESS_MIN_LENGTH ? code : "";
  } catch {
    return "";
  }
}

/**
 * Vérifie un code saisi. Toujours faux si aucun code n'est configuré.
 */
export async function verifyCseAccessCode(db, candidate) {
  const expected = await loadCseAccessCode(db);
  const given = normalizeCseCode(candidate);
  if (!expected || !given) return false;
  return constantTimeEquals(given, expected);
}

/**
 * Lit le code transmis par le navigateur dans l'en-tête X-CSE-Access-Code
 * (encodé avec encodeURIComponent côté client pour rester en ASCII).
 */
export function readCseAccessHeader(request) {
  const raw = request.headers.get(CSE_ACCESS_HEADER);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
