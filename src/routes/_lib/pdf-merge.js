/**
 * src/_lib/pdf-merge.js
 *
 * Fusion des pièces jointes PDF externes (certificat médical, justificatif
 * Pass Région, justificatif tarif réduit) dans le dossier d'adhésion généré
 * par pdf.js/pdf-engine.js.
 *
 * Pourquoi un fichier séparé, et pourquoi pdf-lib :
 *   pdf-engine.js (cf. son commentaire d'en-tête) est un générateur PDF
 *   "maison" pour Workers : il construit ses propres pages à partir de flux
 *   de contenu + images JPEG/PNG (addAutoImage), mais ne sait pas parser un
 *   PDF externe (xref, arbre des pages, ressources/polices, filtres
 *   /CCITTFaxDecode ou /JBIG2Decode fréquents sur des PDF issus d'appli de
 *   scan mobile...). Réécrire un parseur PDF généraliste maison serait un
 *   sous-projet en soi et un risque de régression sur le moteur existant.
 *   pdf-lib fait exactement ça (charger un PDF existant, copier des pages
 *   dans un autre document) et n'a aucune dépendance à des API Node
 *   (fs/Buffer/path) — cf. ses dépendances (pako, @pdf-lib/upng,
 *   @pdf-lib/standard-fonts, tslib) : compatible Cloudflare Workers sans
 *   nodejs_compat.
 *
 * Ce module ne touche à rien d'existant : il prend en entrée les bytes déjà
 * produits par generateAdherentPdf() (inchangé) et les complète. Il ne lève
 * jamais d'exception vers l'appelant — toute erreur (pièce corrompue,
 * dossier de base illisible, etc.) retombe sur les bytes déjà valides
 * fournis en entrée, jamais sur un échec bloquant l'envoi/l'enregistrement
 * du PDF.
 */

import { PDFDocument } from 'pdf-lib';

/**
 * @param {Uint8Array} dossierBytes  PDF déjà généré par generateAdherentPdf()
 * @param {{ label: string, name?: string, bytes: Uint8Array }[]} attachments
 *        Pièces à annexer, dans l'ordre où elles doivent apparaître.
 * @returns {Promise<Uint8Array>}  Le PDF fusionné, ou dossierBytes inchangé
 *          si aucune pièce, ou en cas d'échec (partiel ou total).
 */
export async function mergeAttachedPdfs(dossierBytes, attachments) {
  const list = Array.isArray(attachments) ? attachments.filter((a) => a?.bytes?.length) : [];
  if (!list.length) return dossierBytes;

  let finalDoc;
  try {
    finalDoc = await PDFDocument.load(dossierBytes);
  } catch (err) {
    // Ne devrait jamais arriver (dossierBytes vient de notre propre moteur),
    // mais si ça arrive un jour on ne bloque surtout pas l'envoi du dossier.
    console.error('[pdf-merge] dossier de base illisible par pdf-lib, fusion annulee:', err?.message ?? String(err));
    return dossierBytes;
  }

  let mergedAtLeastOne = false;
  for (const att of list) {
    try {
      const srcDoc = await PDFDocument.load(att.bytes, { ignoreEncryption: true });
      const pageIndices = srcDoc.getPageIndices();
      if (!pageIndices.length) continue;
      const pages = await finalDoc.copyPages(srcDoc, pageIndices);
      pages.forEach((page) => finalDoc.addPage(page));
      mergedAtLeastOne = true;
    } catch (err) {
      // Une piece individuelle corrompue/illisible ne doit jamais empecher
      // la fusion des autres pieces ni du dossier de base.
      console.error(`[pdf-merge] echec fusion piece "${att.label || att.name || '?'}":`, err?.message ?? String(err));
    }
  }

  if (!mergedAtLeastOne) return dossierBytes;

  try {
    return await finalDoc.save();
  } catch (err) {
    console.error('[pdf-merge] echec sauvegarde du PDF fusionne, retour au dossier de base:', err?.message ?? String(err));
    return dossierBytes;
  }
}
