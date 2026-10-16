/**
 * Encodage base64 d'un Uint8Array (pièces jointes Brevo : `attachment.content`
 * attend du base64 pur, sans préfixe `data:`).
 *
 * Remplace les anciennes copies locales (status.js, free-registration.js) qui
 * construisaient la chaîne octet par octet avec `result += …` : plusieurs
 * millions d'itérations pour un PDF de quelques Mo, à chaque envoi de mail,
 * pour un résultat identique. Ici on convertit par blocs de 30 000 octets avec le
 * `btoa` natif du runtime (Workers et Node), qui fait le gros du travail hors
 * du JavaScript. Sortie strictement identique à l'ancienne implémentation
 * (alphabet standard, remplissage `=`).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const CHUNK = 30_000; // multiple de 3 : aucun remplissage `=` au milieu de la chaîne

export function uint8ToBase64(bytes) {
  if (!bytes || !bytes.length) return "";
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))));
  }
  return parts.join("");
}
