/**
 * src/_lib/pdf.js
 *
 * Générateur PDF du dossier d'adhésion pour Cloudflare Workers.
 * Reproduit la mise en page :
 *   – En-tête noir + doré (partagé avec boutique/gestion, cf. document-template.js)
 *   – Badge vert "DOSSIER VALIDÉ"
 *   – Bandeau doré récapitulatif (formule / cotisation / tenue / total)
 *   – S1 Identité (avec photo d'identité embarquée si disponible)
 *   – S2 Coordonnées  S3 Pratique  S4 Tenue
 *   – S5 Questionnaire santé  S6 Engagements & signature
 *   – Pied de page noir (partagé) sur toutes les pages
 *
 * Harmonisation visuelle (cf. pdf-harmonization) : ce fichier ne dessine
 * plus lui-même son en-tête/pied de page/palette — il s'appuie sur
 * pdf-engine.js + document-template.js (mêmes fichiers, à la structure
 * près, que boutique/gestion/espace-membre), pour que le dossier ait
 * enfin la même identité graphique que les factures/reçus/attestations
 * du club plutôt qu'une charte redessinée à la main en parallèle. Tout le
 * contenu (champs, sections, questionnaire, signature) est inchangé —
 * seul l'habillage visuel change.
 *
 * Contraintes Workers :
 *   – Pas de DOM, pas de canvas, pas de require() Node
 *   – Uniquement fetch, crypto, TextEncoder, CompressionStream/DecompressionStream
 *   – Polices : Helvetica / Helvetica-Bold (intégrées PDF Type1), Times-Italic
 *     pour la signature (cf. drawSignature plus bas)
 *
 * Intégration des images (photo d'identité, logo du club) :
 *   Déléguée à pdf-engine.js (addAutoImage / addPngImage) — JPEG embarqué
 *   tel quel via /DCTDecode, PNG décodé "maison" (chunks IHDR/IDAT, inflate
 *   via DecompressionStream) puis ré-encodé en /FlateDecode. Voir le
 *   commentaire d'en-tête de pdf-engine.js pour le détail : cette capacité
 *   PNG est un ajout propre à la copie inscription du moteur (boutique et
 *   gestion n'embarquent que des JPEG fixes et n'en ont pas besoin).
 *
 * Utilisation :
 *   import { generateAdherentPdf, fetchPhotoDocument } from '../_lib/pdf.js';
 *   const photo = await fetchPhotoDocument(env, registration.documents_json);
 *   const pdfBytes = await generateAdherentPdf(registration, photo, env);   // Uint8Array
 *
 * Logo d'en-tête :
 *   Récupéré dynamiquement via le binding ASSETS (comme avant l'harmonisation)
 *   plutôt qu'un instantané base64 figé comme boutique/gestion — reflète
 *   toujours le vrai fichier logo actuel. Le paramètre env est optionnel :
 *   sans lui (ou si l'asset ne charge pas), drawHeader retombe sur son
 *   médaillon-texte par défaut.
 */

import { currentSeasonLabel } from './helpers.js';
import { addAutoImage, addPngImage, safe, PdfBuilder, buildPdfDocument, measureTextWidth, ML, MM, CW } from './pdf-engine.js';
import { mergeAttachedPdfs } from './pdf-merge.js';
import {
  drawHeader, drawFooter,
  NOIR, INK, MUTED, LINE, WHITE, GREEN, DORE, DORE_CLAIR, DORE_BG,
  WARN_BG, OK_BG, BEIGE_BG, FORMULA_BG,
} from './document-template.js';

// ─── Récupération de la photo d'identité depuis R2 ───────────────────────────

/**
 * Va chercher la photo d'identité de l'adhérent dans le bucket R2 référencé
 * par `documents_json` (colonne de `inscriptions_publiques`, écrite au moment
 * de l'upload initial du dossier — cf. uploadRequiredFile() dans
 * src/routes/api/public/inscription.js).
 *
 * @param {object} env             Bindings Worker (env.R2_STORAGE / env.R2_PDF)
 * @param {string|object} documentsJson  Colonne documents_json (texte JSON ou déjà objet)
 * @returns {Promise<{bytes: Uint8Array, contentType: string} | null>}
 */
export async function fetchPhotoDocument(env, documentsJson) {
  try {
    const docs = typeof documentsJson === 'string'
      ? JSON.parse(documentsJson || '{}')
      : (documentsJson || {});
    const ref = docs.photoIdentity;
    if (!ref?.bucket || !ref?.key) return null;
    const bucket = ref.bucket === 'fullfighting-pdf' ? env.R2_PDF : env.R2_STORAGE;
    if (!bucket) return null;
    const object = await bucket.get(ref.key);
    if (!object) return null;
    const arrayBuffer = await object.arrayBuffer();
    return {
      bytes: new Uint8Array(arrayBuffer),
      contentType: object.httpMetadata?.contentType || ref.contentType || '',
    };
  } catch (e) {
    return null; // photo absente/illisible : le PDF retombe sur le cadre vide
  }
}

// ─── Pièces jointes (certificat médical, Pass Région, tarif réduit) ──────────
// Contrairement à la photo d'identité (image JPEG/PNG embarquée telle quelle
// via addAutoImage, cf. resolvePhotoImage ci-dessus), ces trois documents
// sont obligatoirement des PDF (cf. uploadRequiredFile(..., preferImage=false)
// dans src/routes/api/public/inscription.js). Le moteur PDF interne
// (pdf-engine.js) ne sait construire que ses propres pages à partir de flux
// de contenu + images JPEG/PNG : il ne sait pas parser/fusionner un PDF
// externe. Fusionner réellement leurs pages dans ce dossier demanderait un
// vrai import de PDF (xref, arbre des pages, ressources/polices) — hors
// de portée de ce fichier. On se contente donc ici de lister les pièces
// reçues (nom de fichier, taille) pour que leur présence soit tracée dans
// le dossier PDF ; le fichier lui-même reste consultable depuis la fiche
// adhérent (gestion, onglet Adhérents — cf. section "Documents & justificatifs").
const ATTACHED_DOC_LABELS = [
  ['medicalCertificate', 'Certificat medical'],
  ['passRegionDocument', 'Justificatif Pass Region'],
  ['proofDocument',      'Justificatif tarif reduit / CSE'],
];

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * @param {string|object} documentsJson  Colonne documents_json (texte JSON ou déjà objet)
 * @returns {{label: string, name: string, size: string}[]}  Pièces jointes présentes
 *          (hors photoIdentity, déjà affichée en S1 — cf. resolvePhotoImage)
 */
function describeAttachedDocuments(documentsJson) {
  let docs = {};
  try {
    docs = typeof documentsJson === 'string'
      ? JSON.parse(documentsJson || '{}')
      : (documentsJson || {});
  } catch (e) {
    docs = {};
  }
  return ATTACHED_DOC_LABELS
    .map(([key, label]) => {
      const ref = docs?.[key];
      if (!ref?.key) return null; // pièce non fournie (ex. certificat medical si non requis)
      return { label, name: safe(ref.name) || label, size: formatFileSize(ref.size) };
    })
    .filter(Boolean);
}

/**
 * Va chercher, en plus de la photo d'identité (cf. fetchPhotoDocument), les
 * bytes bruts des 3 documents PDF fournis à l'inscription (certificat
 * médical, justificatif Pass Région, justificatif tarif réduit), pour
 * fusion réelle via mergeAttachedPdfs() — cf. pdf-merge.js pour le pourquoi
 * de cette séparation.
 *
 * @param {object} env
 * @param {string|object} documentsJson
 * @returns {Promise<{key: string, label: string, name: string, bytes: Uint8Array}[]>}
 */
export async function fetchAttachedDocuments(env, documentsJson) {
  let docs = {};
  try {
    docs = typeof documentsJson === 'string'
      ? JSON.parse(documentsJson || '{}')
      : (documentsJson || {});
  } catch (e) {
    docs = {};
  }

  const results = [];
  for (const [key, label] of ATTACHED_DOC_LABELS) {
    const ref = docs?.[key];
    if (!ref?.bucket || !ref?.key) continue; // piece non fournie (ex. certificat non requis)
    try {
      const bucket = ref.bucket === 'fullfighting-pdf' ? env?.R2_PDF : env?.R2_STORAGE;
      if (!bucket) continue;
      const object = await bucket.get(ref.key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      results.push({ key, label, name: ref.name || label, bytes });
    } catch (e) {
      // Une piece illisible ne doit pas empecher la recuperation des autres.
      console.error(`[pdf] fetchAttachedDocuments: echec lecture "${label}":`, e?.message ?? String(e));
    }
  }
  return results;
}

/**
 * Point d'entrée recommandé pour générer le dossier complet : dossier de
 * synthèse (generateAdherentPdf, inchangé) + fusion réelle des pièces PDF
 * jointes en pages annexées (mergeAttachedPdfs, cf. pdf-merge.js).
 *
 * Ne lève jamais d'exception : toute erreur de récupération/fusion des
 * pièces retombe sur le dossier de base seul (comportement historique).
 *
 * @param {object} registration
 * @param {{bytes: Uint8Array, contentType: string}|null} [photo]
 * @param {object|null} [env]
 * @returns {Promise<Uint8Array>}
 */
export async function generateAdherentPdfWithAttachments(registration, photo = null, env = null) {
  const dossierBytes = await generateAdherentPdf(registration, photo, env);
  try {
    const documentsJson = registration?.documentsJson ?? registration?.documents_json;
    const attachments = await fetchAttachedDocuments(env, documentsJson);
    if (!attachments.length) return dossierBytes;
    return await mergeAttachedPdfs(dossierBytes, attachments);
  } catch (e) {
    console.error('[pdf] generateAdherentPdfWithAttachments: fusion des pieces jointes echouee, dossier de base renvoye:', e?.message ?? String(e));
    return dossierBytes;
  }
}

// ─── Semantique locale — hors charte de marque ───────────────────────────────
// ALERT n'est PAS une couleur de marque (celles-ci viennent toutes de
// document-template.js) : c'est un rouge d'alerte, utilisé uniquement pour
// signaler une reponse positive au questionnaire de sante (S5), ou le
// cadre de synthese qui en decoule. Contrairement a l'ancien fichier, le
// noir de marque (NOIR) n'est plus reutilise pour ce role — un badge
// "OUI" en texte noir sur fond rose n'alerte pas clairement l'oeil, alors
// que la mention meme d'un antecedent medical merite de rester lisible
// comme une alerte au premier coup d'oeil.
const ALERT = [178, 58, 42];

// Doit rester synchronise avec SIZE_UNAVAILABLE dans public/assets/inscription.js
// et src/routes/_lib/boutique-stock.js. La colonne "Taille" du tableau S4 ne
// fait qu'environ 20mm de large (cf. colXs) : la phrase complete choisie
// dans le formulaire y deborderait sur la colonne "Qte" voisine, d'ou ce
// libelle court specifique a l'affichage PDF.
const SIZE_UNAVAILABLE = "Ma taille n'est pas disponible";

function displaySize(size) {
  const s = safe(size);
  if (!s) return '-';
  if (s === safe(SIZE_UNAVAILABLE)) return 'A confirmer';
  return s;
}

// ─── Construction du PDF ──────────────────────────────────────────────────────

// Zone utile : le pied de page partagé (document-template.js) occupe les
// 20 derniers mm de chaque page (a partir de y=277) → on reserve une marge
// de securite de 3mm avant lui, comme le reste des gabarits du club.
const PAGE_H_MM = 297;
const CONTENT_MAX = 274; // 277 (haut du footer) - 3mm de marge

// ─── Résolution de l'image photo (JPEG direct / PNG décodé) ──────────────────
// Retourne { id, width, height } prêt pour drawImageContain(), ou null si la
// photo est absente/illisible/dans un format non supporté — dans ce cas le
// cadre "Photo d'identite" pré-existant reste affiché (comportement inchangé).
async function resolvePhotoImage(p, photo) {
  if (!photo?.bytes?.length) return null;
  return addAutoImage(p, photo.bytes);
}

// ─── Résolution du logo du club (asset statique embarqué) ────────────────────
// Le fichier public/assets/Logo_1_nnoir_copie-removebg-preview.png est
// recupere via le binding ASSETS (Fetcher, cf. `assets.binding` dans
// wrangler.json — le meme mecanisme que `env.ASSETS.fetch(request)` dans
// index.ts). Retourne null si `env` n'est pas fourni ou si l'asset est
// introuvable : drawHeader retombe alors sur son medaillon-texte par
// defaut (comportement inchange).
const LOGO_ASSET_PATH = '/assets/Logo_1_nnoir_copie-removebg-preview.png';

export async function resolveLogoImage(p, env) {
  if (!env?.ASSETS) return null;
  try {
    const res = await env.ASSETS.fetch(new URL(LOGO_ASSET_PATH, 'https://assets.internal/'));
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return await addPngImage(p, bytes); // null si l'asset n'est pas un PNG supporte
  } catch (e) {
    return null; // asset absent/illisible : on retombe sur le medaillon texte
  }
}

/**
 * @param {object} registration  Données du dossier (format dossier JSON de status.js)
 * @param {{bytes: Uint8Array, contentType: string}|null} [photo]
 *        Photo d'identité déjà récupérée via fetchPhotoDocument(). Optionnel :
 *        si absente, le PDF affiche le cadre "Photo d'identite" comme avant.
 * @param {object|null} [env]
 *        Bindings Worker (pour env.ASSETS, cf. resolveLogoImage). Optionnel :
 *        si absent, le logo d'en-tête retombe sur le médaillon-texte par défaut.
 * @returns {Promise<Uint8Array>}
 */
export async function generateAdherentPdf(registration, photo = null, env = null) {
  const id    = registration.identity        || {};
  const ct    = registration.contact         || {};
  const em    = registration.emergency       || {};
  const pr    = registration.practice        || {};
  const hl    = registration.health          || {};
  const co    = registration.clothingOrder   || {};
  const cs    = registration.consents        || {};
  const totals= registration.computedTotals  || {};
  const pay   = registration.payment         || {};
  const qs    = hl.qsSport                   || {};
  const orderItems = Array.isArray(totals.orderItems) ? totals.orderItems : [];

  const formulaLabel = totals.formulaLabel || pr.formulaCode || 'Tarif de base';
  const cotisation   = Number(totals.cotisation   || 0);
  const clothingTotal= Number(totals.clothingTotal || 0);
  const extraProductsTotal = Number(totals.extraProductsTotal || 0);
  const total        = Number(totals.total         || 0);
  const installments = Math.max(1, Math.min(3, Number(pay.installmentCount || pr.installmentCount || 1)));
  const ref          = String(registration.id || 'AFFBC-XXXX').slice(0, 36);
  const submittedAt  = registration.submittedAt || new Date().toISOString().slice(0, 10);
  const season       = safe(registration.seasonLabel) || currentSeasonLabel();

  const p = new PdfBuilder();
  const photoImage  = await resolvePhotoImage(p, photo);
  const logoImage   = await resolveLogoImage(p, env);
  const attachedDocs = describeAttachedDocuments(registration.documentsJson ?? registration.documents_json);

  // ── Curseur vertical courant (mm depuis le haut de la page courante) ────────
  let y = 0;

  // ══════════════════════════════════════════════════════════════════════════════
  // HELPERS RÉUTILISABLES (section, field, qsRow, saut de page)
  // ══════════════════════════════════════════════════════════════════════════════

  // Vérifie si le prochain bloc de hauteur `neededMm` tient encore sur la page
  // et effectue un saut de page si nécessaire.
  // Les pieds de page sont dessinés tous ensemble à la fin (une fois le nombre
  // de pages connu) — on ne les dessine pas ici pour éviter les doublons.
  function ensureSpace(neededMm) {
    if (y + neededMm > CONTENT_MAX) {
      p.newPage();
      y = 8; // marge haute des pages suivantes
    }
  }

  function section(num, title) {
    ensureSpace(10);
    p.setFillRgb(NOIR);
    p.circle(ML/MM + 3, y + 3, 3.5, 'f');
    p.setFont('F2', 7);
    p.text(String(num), ML/MM + 3, y + 4,    { color: WHITE, align: 'center' });
    p.setFont('F2', 11);
    p.text(title,       ML/MM + 10, y + 4.5, { color: INK });
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.3);
    p.line(ML/MM, y + 7, 210 - ML/MM, y + 7);
    y += 9;
  }

  function field(label, value, xMm, yMm, wMm) {
    p.setFillRgb(WHITE);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(xMm, yMm, wMm, 7.5, 1.5, 'B');
    p.setFont('F1', 4.8);
    p.text(label.toUpperCase(), xMm + 2, yMm + 3,   { color: MUTED });
    const val = safe(value);
    // Valeurs saisies par l'utilisateur (nom compose, intitule de
    // formule...) sans longueur garantie : on reduit legerement la
    // police si besoin plutot que de laisser deborder du cadre, comme
    // pour le numero de facture (meme categorie de bug).
    let fs = 7;
    const maxPt = (wMm - 4) * MM;
    while (fs > 5 && val && measureTextWidth(val, 'F1', fs) > maxPt) fs -= 0.5;
    p.setFont('F1', fs);
    p.text(val || '-', xMm + 2, yMm + 6.2, { color: val ? INK : MUTED });
  }

  function qsRow(question, answer) {
    ensureSpace(7);
    const positive = answer === 'yes';
    p.setFillRgb(WHITE);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM - 22, 6, 1.2, 'B');
    p.setFont('F1', 5.8);
    p.text(question, ML/MM + 2, y + 3.9, { color: INK });
    p.setFillRgb(positive ? WARN_BG : OK_BG);
    p.roundedRect(210 - ML/MM - 20, y, 20, 6, 3, 'f');
    p.setFont('F1', 6);
    p.text(positive ? 'OUI' : 'NON', 210 - ML/MM - 10, y + 3.9, {
      color: positive ? ALERT : GREEN, align: 'center',
    });
    y += 7;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // EN-TÊTE + BADGE  (page 1 uniquement) — partagé avec boutique/gestion
  // ══════════════════════════════════════════════════════════════════════════════

  drawHeader(p, {
    title: "Dossier d'adhesion",
    numero: ref,
    dateLabel: `Saison ${season} - ${submittedAt}`,
    logoImage,
  });

  p.setFillRgb(GREEN);
  p.roundedRect(210 - ML/MM - 30, 32, 30, 6.5, 3, 'f');
  p.setFont('F2', 6);
  p.text('DOSSIER VALIDE', 210 - ML/MM - 15, 36.3, { color: WHITE, align: 'center' });

  // ══════════════════════════════════════════════════════════════════════════════
  // BANDEAU DORÉ — récapitulatif (41 → 49 mm)
  // ══════════════════════════════════════════════════════════════════════════════

  y = 41;
  p.setFillRgb(DORE_BG);
  p.setStrokeRgb(DORE_CLAIR);
  p.setLineWidth(0.3);
  p.rect(0, y, 210, 8, 'B');

  const summaryItems = [
    [formulaLabel,                    'Formule'],
    [`${cotisation.toFixed(2)} EUR`,  'Cotisation'],
    [`${(clothingTotal + extraProductsTotal).toFixed(2)} EUR`,'Commandes club'],
    [`${total.toFixed(2)} EUR total`, `HelloAsso ${installments}x`],
  ];
  const colW = 210 / summaryItems.length;
  // Les 4 cellules ne font que 52.5mm de large : un intitule de formule
  // libre (saisi cote admin) peut largement depasser cette largeur a
  // 7pt et chevaucher les colonnes voisines. On reduit la police, et en
  // dernier recours on tronque avec des points de suspension.
  function fitCell(val, maxWMm, baseFs, minFs) {
    let fs = baseFs;
    while (fs > minFs && measureTextWidth(val, 'F1', fs) > maxWMm * MM) fs -= 0.5;
    if (measureTextWidth(val, 'F1', fs) > maxWMm * MM) {
      let truncated = val;
      while (truncated.length > 1 && measureTextWidth(truncated + '…', 'F1', fs) > maxWMm * MM) {
        truncated = truncated.slice(0, -1);
      }
      val = truncated + '…';
    }
    return { val, fs };
  }
  summaryItems.forEach(([val, lbl], i) => {
    const cx = i * colW + colW / 2;
    const cellMaxW = colW - 4;
    const fitted = fitCell(val, cellMaxW, 7, 5);
    p.setFont('F2', fitted.fs);
    p.text(fitted.val, cx, y + 4,   { color: [61, 40, 0],     align: 'center' });
    p.setFont('F1', 5.2);
    p.text(lbl, cx, y + 6.8, { color: [138, 105, 32],  align: 'center' });
    if (i < summaryItems.length - 1) {
      p.setStrokeRgb(DORE_CLAIR);
      p.setLineWidth(0.3);
      p.line(i * colW + colW, y + 1.2, i * colW + colW, y + 6.8);
    }
  });

  y += 10;

  // ══════════════════════════════════════════════════════════════════════════════
  // S1 — IDENTITÉ
  // ══════════════════════════════════════════════════════════════════════════════

  section(1, "Identite du pratiquant");

  p.setFillRgb([241, 236, 228]);
  p.setStrokeRgb(LINE);
  p.setLineWidth(0.2);
  p.roundedRect(ML/MM, y, 22, 26, 2, 'B');
  if (photoImage) {
    p.drawImageContain(photoImage.id, ML/MM + 1, y + 1, 20, 24, photoImage.width, photoImage.height);
  } else {
    p.setFont('F1', 5);
    p.text("Photo",      ML/MM + 11, y + 13,   { color: MUTED, align: 'center' });
    p.text("d'identite", ML/MM + 11, y + 16.5, { color: MUTED, align: 'center' });
  }

  const fx2 = ML/MM + 25;
  const fw2 = (CW/MM - 27) / 2;
  field('Nom',               safe(id.lastName)?.toUpperCase(), fx2,       y,      fw2);
  field('Prenom',            safe(id.firstName),               fx2+fw2+2, y,      fw2);
  field('Date de naissance', safe(id.birthDate),               fx2,       y + 9,  fw2);
  field('Lieu de naissance', safe(id.birthPlace),              fx2+fw2+2, y + 9,  fw2);

  y += 30;

  // ══════════════════════════════════════════════════════════════════════════════
  // S2 — COORDONNÉES
  // ══════════════════════════════════════════════════════════════════════════════

  section(2, "Coordonnees");

  const hw = (CW/MM - 4) / 2;
  field('Adresse', `${safe(ct.address1)} ${safe(ct.address2)}`.trim(), ML/MM, y, CW/MM);
  y += 9;
  field('Code postal',          safe(ct.postalCode),     ML/MM,       y, hw);
  field('Ville',                safe(ct.city),           ML/MM+hw+4,  y, hw);
  y += 9;
  field('Telephone principal',  safe(ct.phonePrimary),   ML/MM,       y, hw);
  field('Telephone secondaire', safe(ct.phoneSecondary), ML/MM+hw+4,  y, hw);
  y += 9;
  field('Email', safe(ct.email), ML/MM, y, CW/MM);
  y += 11;

  p.setFont('F1', 6);
  p.text("PERSONNE A CONTACTER EN CAS D'URGENCE", ML/MM, y, { color: MUTED });
  y += 5;
  const qw = (CW/MM - 6) / 4;
  field('Nom',             safe(em.lastName)?.toUpperCase(), ML/MM,          y, qw);
  field('Prenom',          safe(em.firstName),               ML/MM+qw+2,     y, qw);
  field('Tel. principal',  safe(em.phonePrimary),            ML/MM+2*(qw+2), y, qw);
  field('Tel. secondaire', safe(em.phoneSecondary),          ML/MM+3*(qw+2), y, qw);
  y += 11;

  // ══════════════════════════════════════════════════════════════════════════════
  // S3 — PRATIQUE & FORMULE
  // ══════════════════════════════════════════════════════════════════════════════

  section(3, "Pratique & Formule tarifaire");

  const tw = (CW/MM - 8) / 3;
  field("Type d'inscription", pr.typeInscription === 'nouvelle' ? 'Nouvelle adhesion' : 'Renouvellement',
        ML/MM, y, tw);
  field('Type de pratique',   pr.practiceType === 'loisir' ? 'Loisir' : safe(pr.practiceType),
        ML/MM+tw+2, y, tw);
  field('Formule tarifaire',  formulaLabel,
        ML/MM+2*(tw+2), y, tw);
  y += 9;
  field('Passeport sportif', pr.passportEnabled ? 'Oui' : 'Non',
        ML/MM, y, tw);
  field('Pass Region',       pr.passRegionEnabled ? `Oui - ${pr.passRegionAmount} EUR` : 'Non utilise',
        ML/MM+tw+2, y, tw);
  field('Paiement',          `HelloAsso - ${installments} fois`,
        ML/MM+2*(tw+2), y, tw);
  y += 11;

  // Formule box dorée
  ensureSpace(18);
  p.setFillRgb(FORMULA_BG);
  p.setStrokeRgb(DORE_CLAIR);
  p.setLineWidth(0.5);
  p.roundedRect(ML/MM, y, CW/MM, 15, 2, 'B');
  p.setFont('F1', 11);
  p.text(formulaLabel, ML/MM + 4, y + 5.5, { color: INK });
  p.setFont('F1', 6.2);
  p.text(`Adhesion annuelle - Licence FFK - Assurance RC + IA - Saison ${season}`,
         ML/MM + 4, y + 10, { color: MUTED });
  p.setFont('F2', 14);
  p.text(`${total.toFixed(2)} EUR`, 210 - ML/MM - 4, y + 7.5, { color: INK, align: 'right' });
  p.setFont('F1', 5.8);
  p.text(
      `Cotis. ${cotisation.toFixed(2)} + Commandes ${(clothingTotal + extraProductsTotal).toFixed(2)}`,
      210 - ML/MM - 4, y + 12, { color: MUTED, align: 'right' },
  );
  y += 18;

  // Échéancier si > 1 fois
  if (installments > 1) {
    ensureSpace(12);
    const base = Math.floor((total * 100) / installments);
    const rem  = Math.round(total * 100) - base * installments;
    const ecW  = (CW/MM - (installments - 1) * 3) / installments;
    for (let i = 0; i < installments; i++) {
      const amount = ((base + (i === 0 ? rem : 0)) / 100).toFixed(2);
      p.setFillRgb(WHITE);
      p.setStrokeRgb(LINE);
      p.setLineWidth(0.2);
      p.roundedRect(ML/MM + i * (ecW + 3), y, ecW, 9, 1.5, 'B');
      p.setFont('F1', 5.2);
      p.text(`${i + 1}${i === 0 ? 're' : 'e'} echeance`,
             ML/MM + i * (ecW + 3) + ecW / 2, y + 3.2, { color: MUTED, align: 'center' });
      p.setFont('F2', 8);
      p.text(`${amount} EUR`,
             ML/MM + i * (ecW + 3) + ecW / 2, y + 7,   { color: INK,   align: 'center' });
    }
    y += 12;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // S4 — TENUE
  // ══════════════════════════════════════════════════════════════════════════════

  section(4, "Commande tenue du club");

  const colXs = [ML/MM, ML/MM+65, ML/MM+90, ML/MM+110, ML/MM+135];
  p.setFont('F1', 5.2);
  ['Article', 'P.U.', 'Taille', 'Qte', 'Sous-total'].forEach((h, i) => {
    p.text(h, colXs[i], y, { color: MUTED });
  });
  y += 4;

  const tshirtQty    = Number(co.tshirtQty    || 0);
  const pantalonQty  = Number(co.pantalonQty  || 0);
  const priceTshirt  = Number(totals.pricingTshirt   || 25);
  const pricePantalon= Number(totals.pricingPantalon || 15);

  const tenueRows = [
    ['T-shirt club AFFBC',  `${priceTshirt} EUR`,  displaySize(co.tshirtSize),   tshirtQty,   `${(tshirtQty   * priceTshirt  ).toFixed(2)} EUR`],
    ['Pantalon club AFFBC', `${pricePantalon} EUR`, displaySize(co.pantalonSize), pantalonQty, `${(pantalonQty * pricePantalon).toFixed(2)} EUR`],
  ];
  tenueRows.forEach(row => {
    ensureSpace(9);
    p.setFillRgb(WHITE);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM, 7.5, 1.2, 'B');
    row.forEach((cell, i) => {
      p.setFont('F1', i === 0 ? 6.5 : 6);
      p.text(String(cell), colXs[i] + 2, y + 5, { color: INK });
    });
    y += 9;
  });
  orderItems.forEach((item) => {
    ensureSpace(9);
    p.setFillRgb(WHITE);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM, 7.5, 1.2, 'B');
    const sizeSuffix = item.size ? ` (${safe(item.size)})` : '';
    const row = [
      `${safe(item.name)}${sizeSuffix}`,
      `${Number(item.unitPrice || 0).toFixed(2)} EUR`,
      item.size ? safe(item.size) : '-',
      Number(item.quantity || 0),
      `${Number(item.total || 0).toFixed(2)} EUR`,
    ];
    row.forEach((cell, i) => {
      p.setFont('F1', i === 0 ? 6.5 : 6);
      p.text(String(cell), colXs[i] + 2, y + 5, { color: INK });
    });
    y += 9;
  });
  p.setFont('F2', 6.2);
  p.text(`Total commandes : ${(clothingTotal + extraProductsTotal).toFixed(2)} EUR`, 210 - ML/MM, y, { color: INK, align: 'right' });
  y += 7;

  // ══════════════════════════════════════════════════════════════════════════════
  // S5 — QUESTIONNAIRE SANTÉ
  // ══════════════════════════════════════════════════════════════════════════════

  section(5, "Questionnaire de sante (art. L. 231-2-1 Code du sport)");

  const QS_LABELS = [
    ['familyCardiacDeath',  'Deces cardiaque soudain dans la famille avant 50 ans'],
    ['chestPain',           'Douleur thoracique a l effort'],
    ['wheezing',            'Sifflements / difficultes respiratoires pendant l effort'],
    ['fainting',            'Perte de connaissance ou syncope'],
    ['sportStop',           'Medecin ayant conseille l arret du sport'],
    ['longTermTreatment',   'Traitement medical de longue duree'],
    ['bonePain',            'Douleurs articulaires ou osseuses hors traumatismes'],
    ['practiceInterrupted', 'Interruption d entrainement pour raison medicale (12 mois)'],
    ['medicalAdviceNeeded', 'Avis medical ou surveillance particuliere requise'],
  ];

  const positives = [];
  QS_LABELS.forEach(([key, label]) => {
    const ans = qs[key] ?? 'no';
    if (ans === 'yes') positives.push(label);
    qsRow(label, ans);
  });

  if (positives.length > 0) {
    ensureSpace(12);
    p.setFillRgb(WARN_BG);
    p.setStrokeRgb(ALERT);
    p.setLineWidth(0.3);
    p.roundedRect(ML/MM, y, CW/MM, 10, 1.5, 'B');
    p.setFont('F1', 6);
    p.text('! Reponse(s) affirmative(s) - un certificat medical est joint au dossier',
           ML/MM + 3, y + 4.5, { color: INK });
    p.setFont('F1', 5.2);
    p.text(`Questions : ${positives.join(', ')}`,
           ML/MM + 3, y + 8, { color: MUTED });
    y += 12;
  }
  y += 3;

  // ══════════════════════════════════════════════════════════════════════════════
  // S6 — ENGAGEMENTS & SIGNATURE
  // ══════════════════════════════════════════════════════════════════════════════

  section(6, "Engagements, consentements & signature");

  const imageRightsLabel = cs.imageRights === 'yes' ? 'Autorise' : 'Non autorise';
  const engagements = [
    [cs.rulesAccepted,
     "J'ai lu et j'accepte sans reserve le reglement interieur du club AFFBC."],
    [cs.insuranceAcknowledged,
     "J'ai pris connaissance des modalites d'assurance FFK (WTW DGPL Federations)."],
    [cs.imageRights === 'yes',
     `Droit a l'image : ${imageRightsLabel} - utilisation a but non commercial.`],
  ];

  engagements.forEach(([ok, text]) => {
    ensureSpace(9);
    p.setFillRgb(ok ? OK_BG : [248, 245, 242]);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM, 7.5, 1.2, 'B');
    p.setFillRgb(ok ? GREEN : MUTED);
    p.circle(ML/MM + 4.5, y + 3.75, 2.8, 'f');
    p.setFont('F2', 6.5);
    p.text(ok ? 'v' : '-', ML/MM + 4.5, y + 4.5, { color: WHITE, align: 'center' });
    p.setFont('F1', 5.8);
    p.text(text, ML/MM + 10, y + 4.5, { color: INK });
    y += 9;
  });

  y += 3;

  // Blocs Fait à / Le
  ensureSpace(14);
  const sw = (CW/MM - 4) / 2;
  [['Fait a', safe(cs.city) || 'Thonon-les-Bains'], ['Le', safe(cs.signedAt)]].forEach(([lbl, val], i) => {
    p.setFillRgb(WHITE);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM + i * (sw + 4), y, sw, 11, 1.5, 'B');
    p.setFont('F1', 5);
    p.text(lbl.toUpperCase(), ML/MM + i * (sw + 4) + 2, y + 3.2, { color: MUTED });
    p.setFont('F1', 7);
    p.text(val || '-',        ML/MM + i * (sw + 4) + 2, y + 7.5, { color: INK   });
  });
  y += 14;

  // Bloc signature — le nom saisi vaut signature electronique (pas d'image de
  // signature capturee) ; rendu en Times-Italic (F3) pour un rendu plus proche
  // d'une signature manuscrite, meme police que le bloc signataire des
  // attestations de cotisation (cf. document-template.js, type 'attestation').
  ensureSpace(14);
  p.setFillRgb(WHITE);
  p.setStrokeRgb(LINE);
  p.setLineWidth(0.2);
  p.roundedRect(ML/MM, y, CW/MM, 13, 1.5, 'B');
  p.setFont('F1', 5);
  p.text("SIGNATURE DE L'ADHERENT(E) - nom saisi valant signature electronique",
         ML/MM + 2, y + 3.5, { color: MUTED });
  p.setFont('F3', 12);
  p.text(safe(cs.applicantSignatureName) || '', ML/MM + 3, y + 10.5, { color: INK });
  y += 16;

  // Bloc réservé club
  ensureSpace(11);
  p.setFillRgb(BEIGE_BG);
  p.setStrokeRgb(LINE);
  p.setLineWidth(0.2);
  p.roundedRect(ML/MM, y, CW/MM, 10, 1.5, 'B');
  p.setFont('F2', 5.5);
  p.text('RESERVE AU CLUB', ML/MM + 2, y + 4, { color: INK });
  p.setFont('F1', 5.2);
  p.text('Verifie par : _______________________  .  N deg. adherent : ___________  .  Licence FFK emise le : ___________  .  Visa : _______',
         ML/MM + 2, y + 8, { color: MUTED });
  y += 13;

  // ══════════════════════════════════════════════════════════════════════════════
  // S7 — PIÈCES JOINTES (documents fournis à l'inscription, conservés à part)
  // ══════════════════════════════════════════════════════════════════════════════
  // N'apparaît que si au moins un document (hors photo d'identité, déjà en S1)
  // a été fourni — cf. describeAttachedDocuments ci-dessus pour le pourquoi
  // du "listing" plutôt qu'une fusion réelle des PDF.
  if (attachedDocs.length > 0) {
    section(7, 'Pieces jointes fournies a l\'inscription');
    p.setFont('F1', 5.2);
    p.text("Documents fournis a l'inscription, annexes en pages supplementaires a la suite de ce dossier.",
           ML/MM, y, { color: MUTED });
    y += 4;
    p.text("En cas d'indisponibilite, consultables depuis la fiche adherent - onglet Adherents de l'espace gestion.",
           ML/MM, y, { color: MUTED });
    y += 6;

    attachedDocs.forEach((doc) => {
      ensureSpace(9);
      p.setFillRgb(WHITE);
      p.setStrokeRgb(LINE);
      p.setLineWidth(0.2);
      p.roundedRect(ML/MM, y, CW/MM, 7.5, 1.2, 'B');
      p.setFont('F2', 6.2);
      p.text(doc.label, ML/MM + 3, y + 5, { color: INK });
      p.setFont('F1', 5.6);
      const detail = doc.size ? `${doc.name} - ${doc.size}` : doc.name;
      p.text(detail, ML/MM + 75, y + 5, { color: MUTED });
      y += 9;
    });
    y += 3;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PIED DE PAGE sur toutes les pages — partagé avec boutique/gestion
  // ══════════════════════════════════════════════════════════════════════════════

  const totalPageCount = p.pages.length;
  p.pages.forEach((_, idx) => {
    p.pageIndex = idx;
    drawFooter(p, { note: `Ref. ${ref} - Page ${idx + 1}/${totalPageCount}` });
  });

  return buildPdfDocument(p.getStreams(), p.images);
}
