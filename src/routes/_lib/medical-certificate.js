/**
 * Certificat médical à l'inscription : pièce jointe OU engagement à la fournir.
 *
 * Le certificat reste OBLIGATOIRE pour les mineurs et dès qu'une réponse du
 * questionnaire de santé (QS-Sport) est positive (cf. validatePayload() dans
 * api/public/inscription.js). Mais un adhérent peut ne pas l'avoir sous la
 * main le jour de l'inscription : plutôt que de bloquer le parcours (et le
 * paiement), il peut cocher une case d'engagement à le fournir au plus vite.
 *
 * Ce module ne contient que la règle de décision (aucun accès base/réseau)
 * pour pouvoir la tester directement, et la partager entre l'enregistrement
 * du dossier, le PDF et les e-mails.
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
 * @returns {{ deferred: boolean, commitment: boolean, error: string|null }}
 *   - deferred   : certificat obligatoire, non fourni, mais engagement pris
 *   - commitment : valeur d'engagement À ENREGISTRER (jamais vraie si une pièce est jointe
 *                  ou si le certificat n'est pas exigé : on ne garde pas d'engagement sans objet)
 *   - error      : message à renvoyer à l'adhérent si ni pièce ni engagement
 */
export function resolveCertificateSubmission({ required, hasFile, commitment }) {
  if (!required) return { deferred: false, commitment: false, error: null };
  if (hasFile) return { deferred: false, commitment: false, error: null };
  if (commitment === true) return { deferred: true, commitment: true, error: null };
  return {
    deferred: false,
    commitment: false,
    error:
      "Le certificat médical est obligatoire pour votre profil : joignez-le, ou cochez la case d'engagement à le fournir au plus vite.",
  };
}
