/**
 * Plafonds de taille des pièces déposées à l'inscription — source de vérité unique côté serveur.
 * (Le navigateur applique les mêmes valeurs : UPLOAD_MAX_BYTES dans public/assets/inscription.js ;
 * un test vérifie qu'elles ne divergent pas.)
 *
 * Objectif : TOUTES les pièces d'un dossier doivent pouvoir être annexées au dossier PDF puis jointes
 * à l'e-mail de confirmation. Deux contraintes, et c'est la première qui commande :
 *
 *  1. Le Worker. Le dossier PDF fusionne les pièces avec pdf-lib (load / copyPages / save), dont le
 *     coût en mémoire croît avec leur poids. Un Worker est limité à 128 Mo ; au-delà Cloudflare le
 *     tue (erreur 1102) sans qu'aucun try/catch puisse réagir : ni PDF ni e-mail. Mesures en pire
 *     cas (trois justificatifs de même taille, flux actuel à PDF unique) :
 *
 *        3 × 1 Mo → +23 Mo de mémoire,   3 × 2 Mo → +45 Mo,   3 × 3 Mo → +73 Mo,   3 × 4 Mo → +102 Mo
 *
 *     Le coût suit le TOTAL fusionné, pas la répartition : 3 + 1,5 + 1,5 Mo revient au même que
 *     2 + 2 + 2 Mo (≈ 320 ms de CPU, message d'environ 8 Mo). On fixe donc un total de 6 Mo.
 *
 *  2. Brevo. Pour un envoi par l'API avec pièces en base64, Brevo limite le MESSAGE ENTIER à 20 Mo
 *     (pièces et contenu compris, base64 inclus : +33 %). Le « 4 Mo par pièce » de sa documentation
 *     vise les pièces de template et de campagne, pas ce chemin. Pire cas ici : (6 Mo de justificatifs
 *     + 2 Mo de photo + dossier de synthèse) × 4/3 ≈ 12 Mo : sous la limite (vérifié par les tests).
 *
 * Répartition du total de 6 Mo : le certificat médical est la pièce la plus lourde (souvent un scan
 * de plusieurs pages, ou un certificat de compétition à rubriques) → 3 Mo. Le justificatif Pass
 * Région et celui de tarif réduit sont des attestations ou des cartes, bien plus légères → 1,5 Mo
 * chacun. Le pire cas reste donc de 6 Mo, comme avec trois plafonds égaux de 2 Mo.
 *
 * Changer un plafond : modifier la valeur ici ET celle du navigateur ; garder la somme des trois
 * justificatifs sous le budget voulu. Les tests vérifient la cohérence et le pire cas.
 */

export const MB = 1024 * 1024;

/** Poids maximal de la photo d'identité (le navigateur la réduit déjà à ~100-200 Ko). */
export const MAX_PHOTO_BYTES = 2 * MB;

/** Certificat médical / certificat de compétition : la pièce la plus lourde. */
export const MAX_MEDICAL_CERTIFICATE_BYTES = 3 * MB;

/** Justificatif Pass Région. */
export const MAX_PASS_REGION_BYTES = 1.5 * MB;

/** Justificatif de tarif réduit. */
export const MAX_PROOF_BYTES = 1.5 * MB;

/**
 * Budget cumulé des pièces annexées au dossier PDF. Égal au pire cas autorisé (les trois justificatifs
 * à leur plafond) : un dossier conforme voit donc TOUTES ses pièces annexées. Ce budget ne joue plus
 * que de filet de sécurité pour les dossiers déposés avant les plafonds (cf. planAttachmentMerge dans pdf.js).
 */
export const MAX_MERGED_ATTACHMENTS_BYTES = MAX_MEDICAL_CERTIFICATE_BYTES + MAX_PASS_REGION_BYTES + MAX_PROOF_BYTES;

/** Limite Brevo pour un message complet envoyé par l'API (pièces + contenu, base64 inclus). */
export const BREVO_MAX_MESSAGE_BYTES = 20 * MB;

/**
 * Tolérance sur le poids d'un justificatif APRÈS conversion photo → PDF : l'enveloppe PDF ajoute
 * quelques Ko, une photo qui pèse pile le plafond ne doit pas être refusée pour cela.
 */
export const CONVERSION_OVERHEAD_BYTES = 64 * 1024;

/**
 * Champs fichier du formulaire d'inscription : nom du champ, nom technique de la pièce (cf.
 * DOCUMENT_LABELS dans inscription.js), libellé utilisé dans les messages, plafond.
 */
export const UPLOAD_FIELDS = [
  { field: "photoIdentity",      target: "photo-identite",     label: "photo d'identité",             maxBytes: MAX_PHOTO_BYTES,               photo: true },
  { field: "medicalCertificate", target: "certificat-medical", label: "certificat médical",           maxBytes: MAX_MEDICAL_CERTIFICATE_BYTES, photo: false },
  { field: "passRegionDocument", target: "pass-region",        label: "justificatif Pass Région",     maxBytes: MAX_PASS_REGION_BYTES,         photo: false },
  { field: "proProofDocument",   target: "justificatif-tarif", label: "justificatif de tarif réduit", maxBytes: MAX_PROOF_BYTES,               photo: false },
];

/**
 * Plafond d'une pièce d'après son nom technique. Une pièce inconnue (ne devrait pas arriver) reçoit le
 * plafond le plus strict : mieux vaut trop prudent que de laisser passer une pièce hors budget.
 */
export function uploadLimitFor(target, preferImage = false) {
  const entry = UPLOAD_FIELDS.find((item) => item.target === target);
  if (entry) return entry.maxBytes;
  return preferImage ? MAX_PHOTO_BYTES : Math.min(MAX_PASS_REGION_BYTES, MAX_PROOF_BYTES);
}

/** « 2 Mo », « 1,5 Mo » — arrondi vers le HAUT pour qu'un fichier refusé n'affiche jamais « 2 Mo » en dépassant 2 Mo. */
export function formatSize(bytes) {
  const value = Math.ceil((Number(bytes) / MB) * 10) / 10;
  return `${Number.isInteger(value) ? value : String(value).replace(".", ",")} Mo`;
}

/**
 * Message lisible (affiché tel quel à l'adhérent) quand une pièce dépasse son plafond.
 * @param {string} label  libellé sans article (« certificat médical », « photo d'identité »…)
 */
export function oversizeMessage(label, size, limit, { photo = false } = {}) {
  const base = `Le document ${label} dépasse la taille maximale de ${formatSize(limit)} (fichier reçu : ${formatSize(size)}).`;
  return photo
    ? `${base} Choisissez une photo plus légère.`
    : `${base} Réduisez le PDF ou joignez-le en photo (JPEG ou PNG).`;
}

/**
 * Première pièce du formulaire qui dépasse son plafond, ou null. Appelé AVANT toute écriture
 * (ligne brouillon, R2, HelloAsso) : un refus ne laisse rien à nettoyer.
 *
 * @param {FormData} formData
 * @returns {{ field: string, label: string, size: number, maxBytes: number, message: string } | null}
 */
export function findOversizedUpload(formData) {
  for (const { field, label, maxBytes, photo } of UPLOAD_FIELDS) {
    const value = formData.get(field);
    if (typeof File !== "undefined" && value instanceof File && value.size > maxBytes) {
      return { field, label, size: value.size, maxBytes, message: oversizeMessage(label, value.size, maxBytes, { photo }) };
    }
  }
  return null;
}
