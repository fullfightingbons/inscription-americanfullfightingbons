/**
 * src/_lib/pdf.js
 *
 * Générateur PDF natif pour Cloudflare Workers.
 * Reproduit fidèlement la mise en page :
 *   – Bandeau rouge header + badge vert "DOSSIER VALIDÉ"
 *   – Bandeau doré récapitulatif (formule / cotisation / tenue / total)
 *   – S1 Identité (avec photo d'identité embarquée si disponible)
 *   – S2 Coordonnées  S3 Pratique  S4 Tenue
 *   – S5 Questionnaire santé  S6 Engagements & signature
 *   – Footer bleu marine
 *
 * Contraintes Workers :
 *   – Pas de DOM, pas de canvas, pas de require() Node
 *   – Uniquement fetch, crypto, TextEncoder, CompressionStream/DecompressionStream
 *   – Polices : Helvetica (intégrée PDF Type1), Times-Italic pour la signature
 *
 * Intégration de la photo d'identité :
 *   Le PDF est écrit "à la main" (assemblage bas niveau des objets PDF), sans
 *   bibliothèque tierce. Pour embarquer une vraie image (et non plus un simple
 *   cadre vide), on décode :
 *     – JPEG : on ne fait QUE lire les dimensions (marqueur SOFn) — les octets
 *       JPEG bruts sont ensuite embarqués tels quels via le filtre PDF
 *       /DCTDecode (le format JPEG est justement ce que /DCTDecode attend).
 *     – PNG  : décodage maison (chunks IHDR/IDAT, inflate via
 *       DecompressionStream('deflate') — le flux DEFLATE zlib d'un PNG est le
 *       même format que celui attendu par le filtre PDF /FlateDecode),
 *       dé-filtrage des scanlines (None/Sub/Up/Average/Paeth), aplatissement
 *       de la transparence sur fond blanc, puis ré-encodage en RGB via
 *       CompressionStream('deflate').
 *   Seuls les PNG en 8 bits/canal, non entrelacés, sont supportés (largement
 *   suffisant pour une photo d'identité) ; tout autre cas retombe silencieux-
 *   ement sur le cadre vide d'origine (comportement pré-existant).
 *
 * Utilisation :
 *   import { generateAdherentPdf, fetchPhotoDocument } from '../_lib/pdf.js';
 *   const photo = await fetchPhotoDocument(env, registration.documents_json);
 *   const pdfBytes = await generateAdherentPdf(registration, photo);   // Uint8Array
 */

import { currentSeasonLabel } from './helpers.js';

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

// ─── Utilitaires bas niveau octets ────────────────────────────────────────────

function strToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function inflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ─── Décodage JPEG (dimensions uniquement — octets réutilisés tels quels) ───

function parseJpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xFF) { offset++; continue; }
    const marker = bytes[offset + 1];
    // Marqueurs sans segment de longueur (bourrage, RSTn, SOI)
    if (marker === 0xFF) { offset++; continue; }
    if ((marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) { offset += 2; continue; }
    if (offset + 3 >= bytes.length) break;
    const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const isSOF = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF) {
      const p = offset + 4;
      if (p + 5 >= bytes.length) return null;
      const height = (bytes[p + 1] << 8) | bytes[p + 2];
      const width  = (bytes[p + 3] << 8) | bytes[p + 4];
      const numComponents = bytes[p + 5];
      if (!width || !height) return null;
      return { width, height, numComponents };
    }
    if (marker === 0xDA) break; // début du scan : plus la peine de chercher
    offset += 2 + segLen;
  }
  return null;
}

// ─── Décodage PNG maison (8 bits/canal, non entrelacé) ───────────────────────

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterPngScanlines(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset++] || 0;
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevRowStart + x] : 0;
      const c = (y > 0 && x >= bpp) ? out[prevRowStart + x - bpp] : 0;
      let val;
      switch (filterType) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paethPredictor(a, b, c); break;
        default: val = rawByte;
      }
      out[rowStart + x] = val & 0xff;
    }
  }
  return out;
}

function parsePngChunks(bytes) {
  const chunks = [];
  let offset = 8; // signature PNG (8 octets)
  while (offset + 8 <= bytes.length) {
    const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    if (dataStart + length + 4 > bytes.length) break;
    chunks.push({ type, data: bytes.slice(dataStart, dataStart + length) });
    offset = dataStart + length + 4; // + CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

// Décode un PNG en pixels RGB 8 bits (alpha aplati sur fond blanc).
// Retourne null si le PNG utilise une variante non supportée (palette,
// 16 bits/canal, entrelacement Adam7...) — le PDF gardera alors le cadre vide.
async function decodePngToRgb(bytes) {
  const chunks = parsePngChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) return null;
  const d = ihdr.data;
  const width  = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  const height = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;
  const bitDepth = d[8];
  const colorType = d[9];
  const interlace = d[12];
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  if (![0, 2, 6].includes(colorType)) return null; // gris / RGB / RGBA uniquement

  const idatChunks = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (!idatChunks.length) return null;

  let inflated;
  try {
    inflated = await inflateZlib(concatBytes(idatChunks));
  } catch (e) {
    return null;
  }

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const raw = unfilterPngScanlines(inflated, width, height, channels);

  const rgb = new Uint8Array(width * height * 3);
  const pixelCount = width * height;
  for (let px = 0, i = 0; px < pixelCount; px++, i += channels) {
    let r, g, b;
    if (channels === 1) {
      r = g = b = raw[i];
    } else if (channels === 3) {
      r = raw[i]; g = raw[i + 1]; b = raw[i + 2];
    } else {
      const alpha = raw[i + 3] / 255;
      r = Math.round(raw[i]     * alpha + 255 * (1 - alpha));
      g = Math.round(raw[i + 1] * alpha + 255 * (1 - alpha));
      b = Math.round(raw[i + 2] * alpha + 255 * (1 - alpha));
    }
    const o = px * 3;
    rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
  }
  return { width, height, rgb };
}

// ─── Constantes page ──────────────────────────────────────────────────────────

const W_PT = 595.28;   // A4 largeur en points
const H_PT = 841.89;   // A4 hauteur en points
const MM   = 2.8346;   // 1 mm en points

// Marges (mm → pt)
const ML = 14 * MM;    // marge gauche
const MR = 14 * MM;    // marge droite
const CW = W_PT - ML - MR; // largeur utile

// Zone utile : le footer occupe les 15 derniers mm de chaque page
// → on réserve 18 mm de marge basse pour ne jamais déborder dessus
const PAGE_H_MM   = H_PT / MM;          // ≈ 297 mm
const FOOTER_H_MM = 15;
const CONTENT_MAX = PAGE_H_MM - FOOTER_H_MM - 3; // ~279 mm — limite avant footer

// ─── Palette (RGB 0–255) ──────────────────────────────────────────────────────

// Charte recolorée le 18/07/2026 pour s'harmoniser avec les autres documents
// du club (factures, reçus, attestations — cf. document-template.js) : noir
// + doré partout, au lieu du rouge/marine d'origine. Les noms de constantes
// (RED, DARK, NAVY...) sont conservés tels quels pour ne pas devoir toucher
// aux ~20 points d'usage plus bas dans ce fichier — seules les valeurs
// changent.
const RED  = [17, 17, 17];      // ex-rouge #A23521 -> noir #111111
const DARK = [34, 34, 34];      // ex-brun foncé #6F2117 -> gris très foncé #222222
const GOLD = [212, 172, 13];    // aligné sur DORE_CLAIR des autres documents (#D4AC0D)
const INK  = [32, 20, 15];
const MUTED= [110, 95, 85];
const LINE = [216, 200, 184];
const WHITE= [255, 255, 255];
const GREEN= [31, 107, 71];
const NAVY = [17, 17, 17];      // ex-marine #24313F -> noir #111111 (unifié avec RED)
const CREAM= [252, 250, 246];
const GOLD_BG  = [250, 243, 220];  // aligné sur DORE_BG des autres documents
const WARN_BG  = [253, 236, 234];
const OK_BG    = [230, 243, 237];
const BEIGE_BG = [241, 236, 228];
const FORMULA_BG=[252, 248, 238];

// ─── Helpers couleur ──────────────────────────────────────────────────────────

function rgb255(c) { return c.map(v => +(v / 255).toFixed(4)); }
function rg(c)  { const [r,g,b] = rgb255(c); return `${r} ${g} ${b} rg`; }
function RG(c)  { const [r,g,b] = rgb255(c); return `${r} ${g} ${b} RG`; }

// ─── Encodage sécurisé (ASCII latin-1) ───────────────────────────────────────

function safe(v) {
    return String(v ?? '')
    // Remplacer les tirets cadratins et apostrophes typographiques avant NFD
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // \u00B0 (°) est conservé : même code point en Latin-1/WinAnsi, donc un
    // octet unique — strToBytes ci-dessus l'encode déjà correctement (cf.
    // bug "N " au lieu de "N°" corrigé dans boutique/gestion, qui utilisaient
    // TextEncoder/UTF-8 et devaient donc stripper ce caractère).
    .replace(/[^\x20-\x7E\u00B0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function esc(v) {
    return safe(v)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// ─── Conversion coordonnées : mm depuis haut de page → pt depuis bas ─────────

function yPt(yMm, pageIndex = 0) {
    // chaque page décale la coordonnée d'une hauteur de page
    const pageOffsetPt = pageIndex * H_PT;
    return H_PT - yMm * MM - pageOffsetPt;
}

// ─── Largeurs de caractères Helvetica / Helvetica-Bold ────────────────────
// Métriques AFM Adobe standard (en 1/1000 em). Remplace l'ancienne
// estimation grossière `str.length * fs * 0.48` qui sous-estimait fortement
// les majuscules et les chiffres (très présents : titres en .toUpperCase(),
// en-têtes de tableau, montants) et faisait déborder tout texte aligné à
// droite/centré au-delà de sa position calculée — parfois au-delà de la
// page elle-même.
const HELV_WIDTHS = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
    ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
    'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722, 'I': 278, 'J': 500,
    'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778, 'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611,
    'U': 722, 'V': 667, 'W': 944, 'X': 667, 'Y': 667, 'Z': 611,
    '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
    'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556, 'h': 556, 'i': 222, 'j': 222,
    'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556, 'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278,
    'u': 556, 'v': 500, 'w': 722, 'x': 500, 'y': 500, 'z': 500,
    '{': 334, '|': 260, '}': 334, '~': 584, '°': 400,
};
const HELV_BOLD_WIDTHS = {
    ' ': 278, '!': 333, '"': 474, '#': 556, '$': 556, '%': 889, '&': 722, "'": 238,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
    ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975,
    'A': 722, 'B': 722, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722, 'I': 278, 'J': 556,
    'K': 722, 'L': 611, 'M': 833, 'N': 722, 'O': 778, 'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611,
    'U': 722, 'V': 667, 'W': 944, 'X': 667, 'Y': 667, 'Z': 611,
    '[': 333, '\\': 278, ']': 333, '^': 584, '_': 556, '`': 333,
    'a': 556, 'b': 611, 'c': 556, 'd': 611, 'e': 556, 'f': 333, 'g': 611, 'h': 611, 'i': 278, 'j': 278,
    'k': 556, 'l': 278, 'm': 889, 'n': 611, 'o': 611, 'p': 611, 'q': 611, 'r': 389, 's': 556, 't': 333,
    'u': 611, 'v': 556, 'w': 778, 'x': 556, 'y': 556, 'z': 500,
    '{': 389, '|': 280, '}': 389, '~': 584, '°': 400,
};

// F2 = Helvetica-Bold ; tout le reste (F1 Helvetica, F3 Times-Italic sans
// table dédiée) utilise les largeurs Helvetica normales comme approximation
// raisonnable — F3 n'est jamais aligné à droite/centré dans les gabarits.
function measureTextWidth(str, fontName, fontSize) {
    const table = fontName === 'F2' ? HELV_BOLD_WIDTHS : HELV_WIDTHS;
    let units = 0;
    for (const ch of str) units += table[ch] ?? 556;
    return (units / 1000) * fontSize;
}

// ─── Constructeur de contenu PDF multi-pages ──────────────────────────────────

class PdfBuilder {
    constructor() {
        this.pages      = [[]];   // tableau de pages, chacune = tableau d'opérateurs
        this.pageIndex  = 0;
        this.font       = null;
        this.fontSize   = 10;
        this.images     = [];     // { id, bytes, filter, colorSpace, bpc, width, height }
    }

    // Page courante
    get ops() { return this.pages[this.pageIndex]; }

    // ── Images intégrées (XObject) ──────────────────────────────────────────────
    // bytes : octets prêts à embarquer tels quels (JPEG brut pour /DCTDecode,
    // ou flux deflate pour /FlateDecode) — le décodage/ré-encodage se fait en
    // amont (cf. decodePngToRgb / deflateZlib plus haut).
    addImage(bytes, { filter, colorSpace = 'DeviceRGB', bpc = 8, width, height }) {
        const id = `Im${this.images.length + 1}`;
        this.images.push({ id, bytes, filter, colorSpace, bpc, width, height });
        return { id, width, height };
    }

    // Dessine une image XObject dans un rectangle précis (mm, coin haut-gauche).
    drawImage(imageId, xMm, yMm, wMm, hMm) {
        const x = xMm * MM;
        const y = H_PT - (yMm + hMm) * MM;
        const w = wMm * MM;
        const h = hMm * MM;
        this.push(
            'q',
            `${+w.toFixed(2)} 0 0 ${+h.toFixed(2)} ${+x.toFixed(2)} ${+y.toFixed(2)} cm`,
            `/${imageId} Do`,
            'Q',
        );
    }

    // Dessine une image en la faisant tenir dans une boîte (mm) SANS la
    // déformer (letterbox centré) — évite d'étirer le portrait/paysage.
    drawImageContain(imageId, boxXMm, boxYMm, boxWMm, boxHMm, imgWidthPx, imgHeightPx) {
        const boxRatio = boxWMm / boxHMm;
        const imgRatio = imgWidthPx / imgHeightPx;
        let drawW, drawH;
        if (imgRatio > boxRatio) {
            drawW = boxWMm;
            drawH = boxWMm / imgRatio;
        } else {
            drawH = boxHMm;
            drawW = boxHMm * imgRatio;
        }
        const offX = boxXMm + (boxWMm - drawW) / 2;
        const offY = boxYMm + (boxHMm - drawH) / 2;
        this.drawImage(imageId, offX, offY, drawW, drawH);
    }

    // ── Nouvelle page ───────────────────────────────────────────────────────────
    newPage() {
        this.pages.push([]);
        this.pageIndex++;
    }

    // ── Utilitaires opérateurs ──────────────────────────────────────────────────

    push(...lines) { this.ops.push(...lines); }

    saveState()    { this.push('q'); }
    restoreState() { this.push('Q'); }

    setLineWidth(w) { this.push(`${+w.toFixed(3)} w`); }
    setFillRgb(c)   { this.push(rg(c)); }
    setStrokeRgb(c) { this.push(RG(c)); }

    setFont(name, size) {
        this.font = name;
        this.fontSize = size;
        this.push(`/${name} ${size} Tf`);
    }

    // ── Formes (coordonnées toujours relatives au haut de la page courante) ─────

    rect(xMm, yMm, wMm, hMm, mode = 'f') {
        const x = xMm * MM;
        const y = H_PT - (yMm + hMm) * MM;
        const w = wMm * MM;
        const h = hMm * MM;
        this.push(`${+x.toFixed(2)} ${+y.toFixed(2)} ${+w.toFixed(2)} ${+h.toFixed(2)} re ${mode}`);
    }

    roundedRect(xMm, yMm, wMm, hMm, rMm, mode = 'f') {
        const x = xMm * MM, y = H_PT - (yMm + hMm) * MM;
        const w = wMm * MM, h = hMm * MM, r = rMm * MM;
        const k = 0.5523;
        this.push(
            `${+(x+r).toFixed(2)} ${+(y).toFixed(2)} m`,
            `${+(x+w-r).toFixed(2)} ${+(y).toFixed(2)} l`,
            `${+(x+w-r+k*r).toFixed(2)} ${+(y).toFixed(2)} ${+(x+w).toFixed(2)} ${+(y+r-k*r).toFixed(2)} ${+(x+w).toFixed(2)} ${+(y+r).toFixed(2)} c`,
            `${+(x+w).toFixed(2)} ${+(y+h-r).toFixed(2)} l`,
            `${+(x+w).toFixed(2)} ${+(y+h-r+k*r).toFixed(2)} ${+(x+w-r+k*r).toFixed(2)} ${+(y+h).toFixed(2)} ${+(x+w-r).toFixed(2)} ${+(y+h).toFixed(2)} c`,
            `${+(x+r).toFixed(2)} ${+(y+h).toFixed(2)} l`,
            `${+(x+r-k*r).toFixed(2)} ${+(y+h).toFixed(2)} ${+(x).toFixed(2)} ${+(y+h-r+k*r).toFixed(2)} ${+(x).toFixed(2)} ${+(y+h-r).toFixed(2)} c`,
            `${+(x).toFixed(2)} ${+(y+r).toFixed(2)} l`,
            `${+(x).toFixed(2)} ${+(y+r-k*r).toFixed(2)} ${+(x+r-k*r).toFixed(2)} ${+(y).toFixed(2)} ${+(x+r).toFixed(2)} ${+(y).toFixed(2)} c`,
            mode,
        );
    }

    circle(xMm, yMm, rMm, mode = 'f') {
        const x = xMm * MM, y = H_PT - yMm * MM, r = rMm * MM;
        const k = 0.5523 * r;
        this.push(
            `${+(x).toFixed(2)} ${+(y+r).toFixed(2)} m`,
            `${+(x+k).toFixed(2)} ${+(y+r).toFixed(2)} ${+(x+r).toFixed(2)} ${+(y+k).toFixed(2)} ${+(x+r).toFixed(2)} ${+(y).toFixed(2)} c`,
            `${+(x+r).toFixed(2)} ${+(y-k).toFixed(2)} ${+(x+k).toFixed(2)} ${+(y-r).toFixed(2)} ${+(x).toFixed(2)} ${+(y-r).toFixed(2)} c`,
            `${+(x-k).toFixed(2)} ${+(y-r).toFixed(2)} ${+(x-r).toFixed(2)} ${+(y-k).toFixed(2)} ${+(x-r).toFixed(2)} ${+(y).toFixed(2)} c`,
            `${+(x-r).toFixed(2)} ${+(y+k).toFixed(2)} ${+(x-k).toFixed(2)} ${+(y+r).toFixed(2)} ${+(x).toFixed(2)} ${+(y+r).toFixed(2)} c`,
            mode,
        );
    }

    line(x1Mm, y1Mm, x2Mm, y2Mm) {
        this.push(
            `${+(x1Mm*MM).toFixed(2)} ${+(H_PT - y1Mm*MM).toFixed(2)} m`,
            `${+(x2Mm*MM).toFixed(2)} ${+(H_PT - y2Mm*MM).toFixed(2)} l S`,
        );
    }

    // ── Texte ───────────────────────────────────────────────────────────────────

    text(txt, xMm, yMm, opts = {}) {
        const { align = 'left', fontName, fontSize, color } = opts;
        const str = esc(txt);
        if (!str) return;
        let px = xMm * MM;
        const py = H_PT - yMm * MM;
        const fn = fontName || this.font || 'F1';
        const fs = fontSize || this.fontSize;
        const w = measureTextWidth(str, fn, fs);
        if (align === 'center') px -= w / 2;
        if (align === 'right')  px -= w;
        this.push('BT');
        if (color) this.push(rg(color));
        this.push(`/${fn} ${fs} Tf`);
        this.push(`${+px.toFixed(2)} ${+py.toFixed(2)} Td`);
        this.push(`(${str}) Tj`);
        this.push('ET');
    }

    // Texte multi-ligne avec retour auto
    textWrapped(txt, xMm, yMm, maxWMm, opts = {}) {
        const { fontName, fontSize, color } = opts;
        const fn = fontName || this.font || 'F1';
        const fs = fontSize || this.fontSize;
        const maxPt = maxWMm * MM;
        const words = safe(txt).split(' ');
        const lines = [];
        let cur = '';
        for (const w of words) {
            const candidate = cur ? `${cur} ${w}` : w;
            if (measureTextWidth(candidate, fn, fs) <= maxPt) { cur = candidate; continue; }
            if (cur) lines.push(cur);
            cur = w;
        }
        if (cur) lines.push(cur);
        const lh = fs * 1.35 / MM;
        lines.forEach((l, i) => {
            this.text(l, xMm, yMm + i * lh, { fontName, fontSize, color });
        });
        return lines.length;
    }

    // ── Export flux par page ────────────────────────────────────────────────────
    getStreams() { return this.pages.map(ops => ops.join('\n')); }

    // Compat single-page
    getStream() { return this.getStreams()[0]; }
}

// ─── Construction du PDF ──────────────────────────────────────────────────────

// ─── Résolution de l'image photo (JPEG direct / PNG décodé) ──────────────────
// Retourne { id, width, height } prêt pour drawImageContain(), ou null si la
// photo est absente/illisible/dans un format non supporté — dans ce cas le
// cadre "Photo d'identite" pré-existant reste affiché (comportement inchangé).
async function resolvePhotoImage(p, photo) {
    if (!photo?.bytes?.length) return null;
    const bytes = photo.bytes;
    try {
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
            const info = parseJpegInfo(bytes);
            if (!info) return null;
            const colorSpace = info.numComponents === 1 ? 'DeviceGray' : 'DeviceRGB';
            return p.addImage(bytes, { filter: 'DCTDecode', colorSpace, bpc: 8, width: info.width, height: info.height });
        }
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
            const decoded = await decodePngToRgb(bytes);
            if (!decoded) return null;
            const flate = await deflateZlib(decoded.rgb);
            return p.addImage(flate, { filter: 'FlateDecode', colorSpace: 'DeviceRGB', bpc: 8, width: decoded.width, height: decoded.height });
        }
    } catch (e) {
        return null; // tout souci de décodage : on retombe sur le cadre vide
    }
    return null;
}

/**
 * @param {object} registration  Données du dossier (format dossier JSON de status.js)
 * @param {{bytes: Uint8Array, contentType: string}|null} [photo]
 *        Photo d'identité déjà récupérée via fetchPhotoDocument(). Optionnel :
 *        si absente, le PDF affiche le cadre "Photo d'identite" comme avant.
 * @returns {Promise<Uint8Array>}
 */
export async function generateAdherentPdf(registration, photo = null) {
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
    const photoImage = await resolvePhotoImage(p, photo);

    // ── Curseur vertical courant (mm depuis le haut de la page courante) ────────
    let y = 0;

    // ── Numéro de page affiché (pour le footer) ─────────────────────────────────
    let totalPages = 1; // sera recalculé après le premier rendu

    // ══════════════════════════════════════════════════════════════════════════════
    // HELPERS RÉUTILISABLES (section, field, qsRow, footer, saut de page)
    // ══════════════════════════════════════════════════════════════════════════════

    function drawFooter(pageNum, pageTotal) {
        const fy = PAGE_H_MM - FOOTER_H_MM;
        p.setFillRgb(NAVY);
        p.rect(0, fy, 210, FOOTER_H_MM, 'f');
        p.text('AMERICAN FULL FIGHTING BONS EN CHABLAIS',
               ML/MM, fy + 5.5, { fontSize: 7, color: WHITE });
        p.text('fullfightingbons@gmail.com  .  06 99 95 81 77  .  inscription.americanfullfightingbons.fr',
               ML/MM, fy + 10, { fontSize: 6, color: [180, 180, 180] });
        p.text(`Ref. ${ref}  .  Page ${pageNum}/${pageTotal}`,
               210 - ML/MM, fy + 7.5, { fontSize: 6.5, color: [130, 130, 130], align: 'right' });
    }

    // Vérifie si le prochain bloc de hauteur `neededMm` tient encore sur la page
    // et effectue un saut de page si nécessaire.
    // Les footers sont dessinés tous ensemble à la fin (une fois le nombre de
    // pages connu) — on ne les dessine pas ici pour éviter les doublons.
    function ensureSpace(neededMm) {
        if (y + neededMm > CONTENT_MAX) {
            p.newPage();
            y = 8; // marge haute des pages suivantes
        }
    }

    function section(num, title) {
        ensureSpace(10);
        p.setFillRgb(RED);
        p.circle(ML/MM + 3, y + 3, 3.5, 'f');
        p.text(String(num), ML/MM + 3, y + 4,    { fontSize: 7, color: WHITE, align: 'center' });
        p.text(title,       ML/MM + 10, y + 4.5, { fontSize: 11, color: INK });
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
        p.text(label.toUpperCase(), xMm + 2, yMm + 3,   { fontSize: 4.8, color: MUTED });
        const val = safe(value);
        // Valeurs saisies par l'utilisateur (nom compose, intitule de
        // formule...) sans longueur garantie : on reduit legerement la
        // police si besoin plutot que de laisser deborder du cadre, comme
        // pour le numero de facture (meme categorie de bug).
        let fs = 7;
        const maxPt = (wMm - 4) * MM;
        while (fs > 5 && val && measureTextWidth(val, 'F1', fs) > maxPt) fs -= 0.5;
        p.text(val || '-',          xMm + 2, yMm + 6.2, { fontSize: fs,   color: val ? INK : MUTED });
    }

    function qsRow(question, answer) {
        ensureSpace(7);
        const positive = answer === 'yes';
        p.setFillRgb(WHITE);
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.2);
        p.roundedRect(ML/MM, y, CW/MM - 22, 6, 1.2, 'B');
        p.text(question, ML/MM + 2, y + 3.9, { fontSize: 5.8, color: INK });
        p.setFillRgb(positive ? WARN_BG : OK_BG);
        p.roundedRect(210 - ML/MM - 20, y, 20, 6, 3, 'f');
        p.text(positive ? 'OUI' : 'NON', 210 - ML/MM - 10, y + 3.9, {
            fontSize: 6, color: positive ? RED : GREEN, align: 'center',
        });
        y += 7;
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // HEADER ROUGE  (0 → 39.5 mm) — page 1 uniquement
    // ══════════════════════════════════════════════════════════════════════════════

    p.setFillRgb(RED);
    p.rect(0, 0, 210, 1.5, 'f');
    p.rect(0, 1.5, 210, 36, 'f');

    // Logo : cercle blanc avec contour rouge, texte stylise du club
    const LOGO_CX  = ML/MM + 17;   // centre X du logo (mm)
    const LOGO_CY  = 19.5;         // centre Y du logo (mm)
    const LOGO_R   = 16;           // rayon (mm) — était 11

    // Cercle de fond blanc
    p.setFillRgb(WHITE);
    p.circle(LOGO_CX, LOGO_CY, LOGO_R, 'f');
    // Anneau de contour rouge (double trait pour l'effet)
    p.setStrokeRgb(RED);
    p.setLineWidth(1.2);
    p.circle(LOGO_CX, LOGO_CY, LOGO_R, 'S');
    p.setLineWidth(0.3);
    p.circle(LOGO_CX, LOGO_CY, LOGO_R - 1.5, 'S');

    // Texte centré dans le cercle
    p.text('FULL',             LOGO_CX, LOGO_CY - 4.5, { fontSize: 7.5, color: RED,  align: 'center' });
    p.text('FIGHTING',         LOGO_CX, LOGO_CY + 1.5, { fontSize: 7.5, color: RED,  align: 'center' });
    p.text('BONS EN CHABLAIS', LOGO_CX, LOGO_CY + 6.5, { fontSize: 5,   color: DARK, align: 'center' });

    const fx = ML/MM + LOGO_R * 2 + 5;   // texte header décalé après le logo
    p.text('AMERICAN FULL FIGHTING BONS EN CHABLAIS',      fx, 9,    { fontSize: 7.1, color: [255, 247, 237] });
    p.text("Dossier d'adhesion",                            fx, 17,   { fontSize: 15,  color: [255, 247, 237] });
    p.text(`Saison ${season}  .  ${submittedAt}`,           fx, 23,   { fontSize: 6.5, color: [220, 200, 180] });

    p.text(`Ref. ${ref}`, 210 - ML/MM, 11, { fontSize: 6, color: [255, 247, 237], align: 'right' });
    p.setFillRgb(GREEN);
    p.roundedRect(210 - ML/MM - 28, 16, 28, 6, 3, 'f');
    p.text('DOSSIER VALIDE', 210 - ML/MM - 14, 20, { fontSize: 6, color: WHITE, align: 'center' });

    // ══════════════════════════════════════════════════════════════════════════════
    // BANDEAU DORÉ  (37.5 → 47 mm)
    // ══════════════════════════════════════════════════════════════════════════════

    y = 37.5;
    p.setFillRgb(GOLD_BG);
    p.setStrokeRgb(GOLD);
    p.setLineWidth(0.3);
    p.rect(0, y, 210, 8, 'B');

    const summaryItems = [
        [formulaLabel,                    'Formule'],
        [`${cotisation.toFixed(2)} EUR`,  'Cotisation'],
        [`${(clothingTotal + extraProductsTotal).toFixed(2)} EUR`,'Commandes club'],
        [`${total.toFixed(2)} EUR total`, `HelloAsso ${installments}x`],
    ];
    const colW = 210 / summaryItems.length;
    summaryItems.forEach(([val, lbl], i) => {
        const cx = i * colW + colW / 2;
        p.text(val, cx, y + 4,   { fontSize: 7,   color: [61, 40, 0],     align: 'center' });
        p.text(lbl, cx, y + 6.8, { fontSize: 5.2, color: [138, 105, 32],  align: 'center' });
        if (i < summaryItems.length - 1) {
            p.setStrokeRgb(GOLD);
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
        p.text("Photo",      ML/MM + 11, y + 13,   { fontSize: 5, color: MUTED, align: 'center' });
        p.text("d'identite", ML/MM + 11, y + 16.5, { fontSize: 5, color: MUTED, align: 'center' });
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

    p.text("PERSONNE A CONTACTER EN CAS D'URGENCE", ML/MM, y, { fontSize: 6, color: MUTED });
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
    p.setStrokeRgb(GOLD);
    p.setLineWidth(0.5);
    p.roundedRect(ML/MM, y, CW/MM, 15, 2, 'B');
    p.text(formulaLabel, ML/MM + 4, y + 5.5, { fontSize: 11, color: INK });
    p.text(`Adhesion annuelle - Licence FFK - Assurance RC + IA - Saison ${season}`,
           ML/MM + 4, y + 10, { fontSize: 6.2, color: MUTED });
    p.text(`${total.toFixed(2)} EUR`, 210 - ML/MM - 4, y + 7.5, { fontSize: 14, color: DARK, align: 'right' });
    p.text(
        `Cotis. ${cotisation.toFixed(2)} + Kit ${Number(totals.newMemberKit || 0).toFixed(2)} + Commandes ${(clothingTotal + extraProductsTotal).toFixed(2)}`,
        210 - ML/MM - 4, y + 12, { fontSize: 5.8, color: MUTED, align: 'right' },
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
            p.text(`${i + 1}${i === 0 ? 're' : 'e'} echeance`,
                   ML/MM + i * (ecW + 3) + ecW / 2, y + 3.2, { fontSize: 5.2, color: MUTED, align: 'center' });
            p.text(`${amount} EUR`,
                   ML/MM + i * (ecW + 3) + ecW / 2, y + 7,   { fontSize: 8,   color: INK,   align: 'center' });
        }
        y += 12;
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // S4 — TENUE
    // ══════════════════════════════════════════════════════════════════════════════

    section(4, "Commande tenue du club");

    const colXs = [ML/MM, ML/MM+65, ML/MM+90, ML/MM+110, ML/MM+135];
    ['Article', 'P.U.', 'Taille', 'Qte', 'Sous-total'].forEach((h, i) => {
        p.text(h, colXs[i], y, { fontSize: 5.2, color: MUTED });
    });
    y += 4;

    const tshirtQty    = Number(co.tshirtQty    || 0);
    const pantalonQty  = Number(co.pantalonQty  || 0);
    const priceTshirt  = Number(totals.pricingTshirt   || 25);
    const pricePantalon= Number(totals.pricingPantalon || 15);

    const tenueRows = [
        ['T-shirt club AFFBC',  `${priceTshirt} EUR`,  safe(co.tshirtSize)   || '-', tshirtQty,   `${(tshirtQty   * priceTshirt  ).toFixed(2)} EUR`],
        ['Pantalon club AFFBC', `${pricePantalon} EUR`, safe(co.pantalonSize) || '-', pantalonQty, `${(pantalonQty * pricePantalon).toFixed(2)} EUR`],
    ];
    tenueRows.forEach(row => {
        ensureSpace(9);
        p.setFillRgb(WHITE);
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.2);
        p.roundedRect(ML/MM, y, CW/MM, 7.5, 1.2, 'B');
        row.forEach((cell, i) => {
            p.text(String(cell), colXs[i] + 2, y + 5, { fontSize: i === 0 ? 6.5 : 6, color: INK });
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
            p.text(String(cell), colXs[i] + 2, y + 5, { fontSize: i === 0 ? 6.5 : 6, color: INK });
        });
        y += 9;
    });
    p.text(`Total commandes : ${(clothingTotal + extraProductsTotal).toFixed(2)} EUR`, 210 - ML/MM, y, { fontSize: 6.2, color: DARK, align: 'right' });
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
        p.setStrokeRgb(RED);
        p.setLineWidth(0.3);
        p.roundedRect(ML/MM, y, CW/MM, 10, 1.5, 'B');
        p.text('! Reponse(s) affirmative(s) - un certificat medical est joint au dossier',
               ML/MM + 3, y + 4.5, { fontSize: 6, color: DARK });
        p.text(`Questions : ${positives.join(', ')}`,
               ML/MM + 3, y + 8, { fontSize: 5.2, color: MUTED });
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
        p.text(ok ? 'v' : '-', ML/MM + 4.5, y + 4.5, { fontSize: 6.5, color: WHITE, align: 'center' });
        p.text(text, ML/MM + 10, y + 4.5, { fontSize: 5.8, color: INK });
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
        p.text(lbl.toUpperCase(), ML/MM + i * (sw + 4) + 2, y + 3.2, { fontSize: 5,   color: MUTED });
        p.text(val || '-',        ML/MM + i * (sw + 4) + 2, y + 7.5, { fontSize: 7,   color: INK   });
    });
    y += 14;

    // Bloc signature
    ensureSpace(14);
    p.setFillRgb(WHITE);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM, 13, 1.5, 'B');
    p.text("SIGNATURE DE L'ADHERENT(E) - nom saisi valant signature electronique",
           ML/MM + 2, y + 3.5, { fontSize: 5, color: MUTED });
    p.text(safe(cs.applicantSignatureName) || '', ML/MM + 3, y + 10, { fontSize: 10, color: INK });
    y += 16;

    // Bloc réservé club
    ensureSpace(11);
    p.setFillRgb(BEIGE_BG);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM, 10, 1.5, 'B');
    p.text('RESERVE AU CLUB', ML/MM + 2, y + 4, { fontSize: 5.5, color: INK });
    p.text('Verifie par : _______________________  .  N deg. adherent : ___________  .  Licence FFK emise le : ___________  .  Visa : _______',
           ML/MM + 2, y + 8, { fontSize: 5.2, color: MUTED });
    y += 13;

    // ══════════════════════════════════════════════════════════════════════════════
    // FOOTER sur toutes les pages
    // ══════════════════════════════════════════════════════════════════════════════

    const totalPageCount = p.pages.length;
    // Redessiner les footers maintenant qu'on connaît le total de pages
    p.pages.forEach((_, idx) => {
        p.pageIndex = idx;
        drawFooter(idx + 1, totalPageCount);
    });

    return buildPdfDocument(p.getStreams(), p.images);
}

// ─── Assemblage bas niveau PDF 1.4 multi-pages ───────────────────────────────

function buildPdfDocument(contentStreams, images = []) {
    const pageCount = contentStreams.length;

    // Numéros d'objets :
    //  1 = Catalog
    //  2 = Pages
    //  3..3+pageCount-1 = Page objects
    //  3+pageCount..   = Content streams
    //  puis F1 (Helvetica), F2 (Times-Italic)
    //  puis un objet XObject /Image par photo embarquée (0 ou 1 aujourd'hui)

    const pageObjStart    = 3;
    const streamObjStart  = pageObjStart + pageCount;
    const font1ObjNum     = streamObjStart + pageCount;
    const font2ObjNum     = font1ObjNum + 1;
    const imageObjStart   = font2ObjNum + 1;
    const imageObjNums    = images.map((_, i) => imageObjStart + i);
    const lastObjNum      = imageObjStart + images.length - 1; // dernier numéro d'objet utilisé

    // Chaque entrée = tableau de morceaux Uint8Array constituant l'objet PDF
    // complet (texte + éventuel flux binaire). On travaille en octets plutôt
    // qu'en concaténation de chaînes JS pour pouvoir embarquer des données
    // binaires (JPEG/PNG) sans risquer de corrompre les octets > 127.
    const objChunks = new Array(lastObjNum);

    // 1 — Catalog
    objChunks[0] = [strToBytes(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`)];

    // 2 — Pages node
    const kidsRef = Array.from({ length: pageCount }, (_, i) => `${pageObjStart + i} 0 R`).join(' ');
    objChunks[1] = [strToBytes(`2 0 obj\n<< /Type /Pages /Kids [${kidsRef}] /Count ${pageCount} >>\nendobj\n`)];

    // Ressource /XObject partagée par toutes les pages (inoffensive si non
    // référencée sur une page qui ne dessine pas d'image).
    const xobjectDict = images.length
        ? ` /XObject << ${images.map((img, i) => `/${img.id} ${imageObjNums[i]} 0 R`).join(' ')} >>`
        : '';

    // Page objects
    for (let i = 0; i < pageCount; i++) {
        const pageNum   = pageObjStart + i;
        const streamNum = streamObjStart + i;
        objChunks[pageNum - 1] = [strToBytes(
            `${pageNum} 0 obj\n` +
            `<< /Type /Page /Parent 2 0 R\n` +
            `/MediaBox [0 0 ${W_PT.toFixed(2)} ${H_PT.toFixed(2)}]\n` +
            `/Resources << /Font << /F1 ${font1ObjNum} 0 R /F2 ${font2ObjNum} 0 R >>${xobjectDict} >>\n` +
            `/Contents ${streamNum} 0 R >>\nendobj\n`,
        )];
    }

    // Content streams (texte ASCII pur — cf. safe()/esc() partout ailleurs)
    for (let i = 0; i < pageCount; i++) {
        const streamNum = streamObjStart + i;
        const streamBytes = strToBytes(contentStreams[i]);
        objChunks[streamNum - 1] = [
            strToBytes(`${streamNum} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`),
            streamBytes,
            strToBytes(`\nendstream\nendobj\n`),
        ];
    }

    // Polices
    objChunks[font1ObjNum - 1] = [strToBytes(`${font1ObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`)];
    objChunks[font2ObjNum - 1] = [strToBytes(`${font2ObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>\nendobj\n`)];

    // Images (XObject binaires — JPEG brut /DCTDecode ou RGB deflate /FlateDecode)
    images.forEach((img, i) => {
        const objNum = imageObjNums[i];
        const header = strToBytes(
            `${objNum} 0 obj\n` +
            `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
            `/ColorSpace /${img.colorSpace} /BitsPerComponent ${img.bpc} /Filter /${img.filter} ` +
            `/Length ${img.bytes.length} >>\nstream\n`,
        );
        objChunks[objNum - 1] = [header, img.bytes, strToBytes(`\nendstream\nendobj\n`)];
    });

    // Assemblage final + xref (tout en octets pour rester correct avec le binaire)
    const header = strToBytes('%PDF-1.4\n');
    const offsets = [];
    const allChunks = [header];
    let cursor = header.length;
    for (const chunkList of objChunks) {
        offsets.push(cursor);
        for (const chunk of chunkList) {
            allChunks.push(chunk);
            cursor += chunk.length;
        }
    }
    const xrefOffset = cursor;
    const n = lastObjNum + 1; // +1 pour l'entrée libre 0
    let xrefStr = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (const off of offsets) {
        xrefStr += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    xrefStr += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    allChunks.push(strToBytes(xrefStr));

    return concatBytes(allChunks);
}
