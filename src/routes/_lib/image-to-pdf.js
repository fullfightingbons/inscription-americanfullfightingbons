/**
 * src/routes/_lib/image-to-pdf.js
 *
 * Pièces justificatives envoyées en PHOTO (téléphone) : conversion en PDF.
 *
 * Contexte : le certificat médical, le justificatif Pass Région et le
 * justificatif de tarif réduit sont, pour toute la suite de la chaîne
 * (fusion dans le dossier PDF via pdf-merge.js, fiche adhérent, gestion),
 * des PDF. Or, sur téléphone, la personne photographie son document : le
 * navigateur envoie alors un JPEG ou un PNG. Plutôt que de refuser ce fichier
 * (et de faire échouer l'inscription à la toute dernière étape), on le
 * convertit ici en PDF d'une page avant de le stocker : tout ce qui est en
 * aval continue de ne voir que des PDF, sans aucune adaptation.
 *
 * Ce module est volontairement isolé : il n'est appelé que pour une image,
 * jamais pour un PDF (le chemin PDF existant reste strictement inchangé).
 *
 * pdf-lib n'a aucune dépendance Node (cf. pdf-merge.js) : compatible Workers.
 */

import { PDFDocument, degrees } from 'pdf-lib';

// Côté long de la page produite (points PDF) ≈ côté long d'un A4. La photo
// occupe toute la page : pas de marge, pas de déformation.
const PAGE_LONG_SIDE = 842;

/**
 * Détermine le VRAI type d'un fichier d'après ses premiers octets.
 * Le `file.type` envoyé par un navigateur mobile est parfois vide ou générique
 * (`application/octet-stream`, notamment depuis un gestionnaire de fichiers ou
 * un cloud) : ce n'est donc pas une base fiable à lui seul.
 *
 * @param {Uint8Array} bytes  Au moins les ~1 024 premiers octets du fichier
 * @returns {'pdf'|'jpeg'|'png'|null}
 */
export function sniffFileKind(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  // En-tête PDF « %PDF- » : la spécification tolère quelques octets avant,
  // dans les 1 024 premiers.
  const limit = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= limit; i += 1) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return 'pdf';
    }
  }
  return null;
}

/**
 * Lit l'orientation EXIF (1 à 8) d'un JPEG. Les photos de téléphone prises en
 * portrait sont souvent stockées « couchées » avec une orientation EXIF : sans
 * cette lecture, la page PDF s'afficherait de côté.
 * Renvoie 1 (normal) si l'information est absente ou illisible : jamais d'exception.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function readJpegOrientation(bytes) {
  try {
    if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return 1;
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset += 1; continue; } // octets de remplissage
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0xda || marker === 0xd9) return 1; // début des données image / fin : plus de métadonnées
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2) return 1;
      if (marker === 0xe1) {
        const start = offset + 4;
        const isExif =
          bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 &&
          bytes[start + 3] === 0x66 && bytes[start + 4] === 0x00 && bytes[start + 5] === 0x00;
        if (isExif) return readExifOrientation(bytes, start + 6);
      }
      offset += 2 + length;
    }
  } catch (e) {
    /* illisible : orientation normale */
  }
  return 1;
}

function readExifOrientation(bytes, tiff) {
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49; // « II »
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;    // « MM »
  if (!little && !big) return 1;
  const u16 = (o) => (little ? (bytes[o] | (bytes[o + 1] << 8)) : ((bytes[o] << 8) | bytes[o + 1]));
  const u32 = (o) => (little
    ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
    : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
  if (u16(tiff + 2) !== 42) return 1;
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > bytes.length) return 1;
  const count = u16(ifd0);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > bytes.length) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

// Rotation (degrés, sens horaire) à appliquer à la page pour remettre la photo
// à l'endroit selon l'orientation EXIF. Les variantes « miroir » (2, 4, 5, 7),
// très rares, sont traitées par leur seule rotation.
const ORIENTATION_TO_ROTATION = { 3: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

/**
 * Convertit une image JPEG ou PNG en PDF d'une page.
 *
 * @param {Uint8Array} bytes  Octets de l'image
 * @param {'jpeg'|'png'} kind Type réel (cf. sniffFileKind)
 * @returns {Promise<Uint8Array>}  Le PDF
 * @throws si l'image est corrompue ou non décodable
 */
export async function imageToPdfBytes(bytes, kind) {
  if (kind !== 'jpeg' && kind !== 'png') throw new Error(`Type d'image non pris en charge : ${kind}`);

  const doc = await PDFDocument.create();
  const image = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

  const rotation = kind === 'jpeg' ? (ORIENTATION_TO_ROTATION[readJpegOrientation(bytes)] || 0) : 0;
  const swapped = rotation === 90 || rotation === 270;

  // Dimensions telles qu'AFFICHÉES (après rotation), pour viser ~A4.
  const displayW = swapped ? image.height : image.width;
  const displayH = swapped ? image.width : image.height;
  const scale = PAGE_LONG_SIDE / Math.max(displayW, displayH);

  // Page aux dimensions de l'image « brute » ; la rotation de page (/Rotate)
  // se charge de l'afficher à l'endroit sans toucher aux pixels.
  const page = doc.addPage([image.width * scale, image.height * scale]);
  page.drawImage(image, { x: 0, y: 0, width: image.width * scale, height: image.height * scale });
  if (rotation) page.setRotation(degrees(rotation));

  return doc.save();
}
