/**
 * pdf-engine.js — AFFBC
 * ─────────────────────────────────────────────────────────────────────────
 * Moteur PDF générique, sans dépendance, réutilisable dans n'importe quel
 * Worker Cloudflare (aucun accès disque/Node requis — uniquement Uint8Array
 * et TextEncoder, disponibles dans l'environnement Workers).
 *
 * Origine : généralisé à partir de `inscription/src/routes/_lib/pdf.js`
 * (classe PdfBuilder + buildPdfDocument), qui était jusqu'ici le seul des
 * générateurs PDF "maison" du club à supporter proprement la mise en page
 * riche (formes, texte positionné, images). Ce fichier isole cette partie
 * générique (aucune logique métier "fiche adhérent" ici) pour qu'elle soit
 * copiable telle quelle dans boutique/gestion/espace-membre/inscription.
 *
 * Ce fichier est volontairement un simple copier-coller entre projets
 * (chaque Worker Cloudflare se déployant indépendamment, il n'y a pas de
 * package npm partagé pratique ici) — le garder identique partout est une
 * discipline à maintenir manuellement lors de futures évolutions.
 *
 * ⚠️ Écart assumé par rapport aux copies boutique/gestion : cette copie-ci
 * ajoute le support PNG (parsePngChunks/decodePngToRgb/addPngImage), requis
 * pour la photo d'identité et le logo du club côté inscription. boutique et
 * gestion n'embarquent que des JPEG (logo fixe via club-logo.js) et n'ont
 * pas besoin de cette section — elle est ajoutée ici plutôt que retirée des
 * autres pour ne pas casser le principe "copier-coller identique" par une
 * suppression, seulement par un ajout inoffensif tant qu'il n'est pas
 * appelé. Si boutique/gestion ont un jour besoin d'embarquer un PNG
 * variable, reporter ce bloc chez eux à l'identique.
 */

// ─── Constantes de page ───────────────────────────────────────────────────
export const W_PT = 595.28;   // A4 largeur en points
export const H_PT = 841.89;   // A4 hauteur en points
export const MM   = 2.8346;   // 1 mm en points
export const ML   = 14 * MM;  // marge gauche par défaut
export const MR   = 14 * MM;  // marge droite par défaut
export const CW   = W_PT - ML - MR;

// ─── Helpers couleur ───────────────────────────────────────────────────────
function rgb255(c) { return c.map(v => +(v / 255).toFixed(4)); }
function rg(c) { const [r, g, b] = rgb255(c); return `${r} ${g} ${b} rg`; }
function RG(c) { const [r, g, b] = rgb255(c); return `${r} ${g} ${b} RG`; }

// ─── Encodage sécurisé pour les polices standard PDF ────────────────────────
// La police du document est déclarée en /WinAnsiEncoding (cf. buildPdfDocument) :
// les lettres accentuées du français (Latin-1, U+00A0–U+00FF) et l'euro sont donc
// affichables telles quelles, à condition d'écrire l'octet WinAnsi correspondant.
// strToBytes() écrit un octet par caractère (charCode & 0xFF), ce qui est exact
// pour tout le Latin-1 ; seuls €, Œ et œ n'ont pas le même point de code en
// WinAnsi (0x80, 0x8C, 0x9C) : ils sont remplacés ici par le caractère de
// contrôle C1 portant cet octet. Ce remplacement est idempotent
// (safe(safe(x)) === safe(x)) : textWrapped() puis text() repassent chacun le
// texte dans safe().
//
// Avant cette correction, safe() supprimait TOUS les accents (« Mickaël » →
// « Mickael ») et remplaçait € par une espace : les montants sortaient sans
// devise et les noms/adresses des adhérents étaient altérés, sur le dossier
// d'inscription comme sur les reçus. (Même correctif que la copie du moteur de
// gestion — garder les deux en phase.)
const WINANSI_BYTE = {
  '\u20AC': '\u0080', // €
  '\u0152': '\u008C', // Œ
  '\u0153': '\u009C', // œ
};

export function safe(v) {
  const src = String(v ?? '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .normalize('NFC');
  let out = '';
  for (const ch of src) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF)) out += ch; // ASCII + Latin-1 (= WinAnsi)
    else if (WINANSI_BYTE[ch]) out += WINANSI_BYTE[ch];
    else if (cp === 0x80 || cp === 0x8C || cp === 0x9C) out += ch; // déjà converti (idempotence)
    else {
      // Hors WinAnsi : on garde la lettre de base si elle existe (ő → o), sinon une espace.
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += /^[\x20-\x7E]+$/.test(base) ? base : ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function esc(v) {
  return safe(v).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function strToBytes(str) {
  // Encodage octet-par-caractere (Latin-1/WinAnsi), PAS TextEncoder/UTF-8 :
  // les chaines PDF (Tj) sont en 1 octet par caractere, pas en UTF-8. Avec
  // TextEncoder, tout caractere hors ASCII (ex. \u00B0 degre) partait en 2
  // octets UTF-8 et s'affichait mal — d'où le strip ASCII strict qui
  // existait dans `safe()` jusqu'ici. Meme approche que inscription/_lib/pdf.js.
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

function concatBytes(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// ─── Lecture des dimensions JPEG (nécessaire pour embarquer un logo/photo
// en /DCTDecode sans zlib ni décodage complet) ─────────────────────────────
export function parseJpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xFF) { offset++; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xFF) { offset++; continue; }
    if ((marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) { offset += 2; continue; }
    if (offset + 3 >= bytes.length) break;
    const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const isSOF = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF) {
      const p = offset + 4;
      if (p + 5 >= bytes.length) return null;
      const height = (bytes[p + 1] << 8) | bytes[p + 2];
      const width = (bytes[p + 3] << 8) | bytes[p + 4];
      const numComponents = bytes[p + 5];
      if (!width || !height) return null;
      return { width, height, numComponents };
    }
    if (marker === 0xDA) break;
    offset += 2 + segLen;
  }
  return null;
}

// Décode une chaîne base64 (disponible nativement dans les Workers via atob).
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Encode des octets en base64 sans passer par atob/btoa (qui butent sur les
// gros tableaux binaires dans certains runtimes) — utilisé pour les pièces
// jointes Brevo (attachment.content attend du base64 pur, sans préfixe data:).
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(bytes) {
  let result = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    result += B64_CHARS[b0 >> 2];
    result += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < len ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < len ? B64_CHARS[b2 & 63] : '=';
  }
  return result;
}

// Ajoute une image JPEG (bytes bruts) au document et retourne son descripteur,
// prêt pour drawImage()/drawImageContain(). Aucun décodage pixel requis :
// le JPEG est embarqué tel quel (/DCTDecode), seule l'en-tête est lue.
export function addJpegImage(builder, jpegBytes) {
  const info = parseJpegInfo(jpegBytes);
  if (!info) return null;
  const colorSpace = info.numComponents === 1 ? 'DeviceGray' : 'DeviceRGB';
  return builder.addImage(jpegBytes, { filter: 'DCTDecode', colorSpace, bpc: 8, width: info.width, height: info.height });
}

// ─── Décodage PNG maison (8 bits/canal, non entrelacé) ────────────────────
// Seuls les PNG en 8 bits/canal, non entrelacés, sont supportés (largement
// suffisant pour une photo d'identité ou un logo) ; tout autre cas retourne
// null — à l'appelant de retomber sur un repli (cadre vide, médaillon...).

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

async function inflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Décode un PNG en pixels RGB 8 bits (alpha aplati sur fond blanc).
// Retourne null si le PNG utilise une variante non supportée (palette,
// 16 bits/canal, entrelacement Adam7...).
export async function decodePngToRgb(bytes) {
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

  const rgbBytes = new Uint8Array(width * height * 3);
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
    rgbBytes[o] = r; rgbBytes[o + 1] = g; rgbBytes[o + 2] = b;
  }
  return { width, height, rgb: rgbBytes };
}

// Ajoute une image PNG (décodée puis ré-encodée en RGB /FlateDecode) au
// document et retourne son descripteur, prêt pour drawImage()/
// drawImageContain() — même contrat que addJpegImage. Retourne null si le
// PNG n'est pas dans une variante supportée (cf. decodePngToRgb).
export async function addPngImage(builder, pngBytes) {
  if (!(pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4E && pngBytes[3] === 0x47)) return null;
  const decoded = await decodePngToRgb(pngBytes);
  if (!decoded) return null;
  const flate = await deflateZlib(decoded.rgb);
  return builder.addImage(flate, { filter: 'FlateDecode', colorSpace: 'DeviceRGB', bpc: 8, width: decoded.width, height: decoded.height });
}

// Détecte le format (JPEG ou PNG) et délègue à addJpegImage/addPngImage —
// pratique pour la photo d'identité, dont le format n'est pas connu à
// l'avance (l'utilisateur peut téléverser l'un ou l'autre).
export async function addAutoImage(builder, bytes) {
  if (!bytes || !bytes.length) return null;
  try {
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return addJpegImage(builder, bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return await addPngImage(builder, bytes);
  } catch (e) {
    return null; // tout souci de décodage : au repli habituel (cadre vide, médaillon)
  }
  return null;
}


// ─── Constructeur de contenu PDF multi-pages ──────────────────────────────
// Largeurs de caracteres Helvetica / Helvetica-Bold (metriques AFM Adobe
// standard, en 1/1000 em). Remplace l'ancienne estimation grossiere
// `str.length * fs * 0.48` qui sous-estimait fortement les majuscules et
// les chiffres (tres presents : titres en .toUpperCase(), en-tetes de
// tableau, montants) et faisait deborder tout texte aligne a droite/centre
// au-dela de sa position calculee — parfois au-dela de la page elle-meme.
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
  '\u0080': 556, '\u008C': 1000, '\u009C': 944, // € Œ œ
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
  '\u0080': 556, '\u008C': 1000, '\u009C': 944, // € Œ œ
};

// F2 = Helvetica-Bold ; tout le reste (F1 Helvetica, F3 Times-Italic sans
// table dediee) utilise les largeurs Helvetica normales comme approximation
// raisonnable — F3 n'est jamais aligne a droite/centre dans les gabarits.
export function measureTextWidth(str, fontName, fontSize) {
  const table = fontName === 'F2' ? HELV_BOLD_WIDTHS : HELV_WIDTHS;
  let units = 0;
  // Lettre accentuée (é, ç, Ê…) : même chasse que sa lettre de base.
  for (const ch of str) units += table[ch] ?? table[ch.normalize('NFD').charAt(0)] ?? 556;
  return (units / 1000) * fontSize;
}

export class PdfBuilder {
  constructor() {
    this.pages = [[]];
    this.pageIndex = 0;
    this.font = null;
    this.fontSize = 10;
    this.images = []; // { id, bytes, filter, colorSpace, bpc, width, height }
  }

  get ops() { return this.pages[this.pageIndex]; }

  addImage(bytes, { filter, colorSpace = 'DeviceRGB', bpc = 8, width, height }) {
    const id = `Im${this.images.length + 1}`;
    this.images.push({ id, bytes, filter, colorSpace, bpc, width, height });
    return { id, width, height };
  }

  drawImage(imageId, xMm, yMm, wMm, hMm) {
    const x = xMm * MM;
    const y = H_PT - (yMm + hMm) * MM;
    const w = wMm * MM;
    const h = hMm * MM;
    this.push('q', `${+w.toFixed(2)} 0 0 ${+h.toFixed(2)} ${+x.toFixed(2)} ${+y.toFixed(2)} cm`, `/${imageId} Do`, 'Q');
  }

  drawImageContain(imageId, boxXMm, boxYMm, boxWMm, boxHMm, imgWidthPx, imgHeightPx) {
    const boxRatio = boxWMm / boxHMm;
    const imgRatio = imgWidthPx / imgHeightPx;
    let drawW, drawH;
    if (imgRatio > boxRatio) { drawW = boxWMm; drawH = boxWMm / imgRatio; }
    else { drawH = boxHMm; drawW = boxHMm * imgRatio; }
    const offX = boxXMm + (boxWMm - drawW) / 2;
    const offY = boxYMm + (boxHMm - drawH) / 2;
    this.drawImage(imageId, offX, offY, drawW, drawH);
  }

  newPage() { this.pages.push([]); this.pageIndex++; }

  push(...lines) { this.ops.push(...lines); }

  saveState() { this.push('q'); }
  restoreState() { this.push('Q'); }

  setLineWidth(w) { this.push(`${+w.toFixed(3)} w`); }
  setFillRgb(c) { this.push(rg(c)); }
  setStrokeRgb(c) { this.push(RG(c)); }

  setFont(name, size) { this.font = name; this.fontSize = size; this.push(`/${name} ${size} Tf`); }

  rect(xMm, yMm, wMm, hMm, mode = 'f') {
    const x = xMm * MM, y = H_PT - (yMm + hMm) * MM, w = wMm * MM, h = hMm * MM;
    this.push(`${+x.toFixed(2)} ${+y.toFixed(2)} ${+w.toFixed(2)} ${+h.toFixed(2)} re ${mode}`);
  }

  roundedRect(xMm, yMm, wMm, hMm, rMm, mode = 'f') {
    const x = xMm * MM, y = H_PT - (yMm + hMm) * MM, w = wMm * MM, h = hMm * MM, r = rMm * MM, k = 0.5523;
    this.push(
      `${+(x + r).toFixed(2)} ${+(y).toFixed(2)} m`,
      `${+(x + w - r).toFixed(2)} ${+(y).toFixed(2)} l`,
      `${+(x + w - r + k * r).toFixed(2)} ${+(y).toFixed(2)} ${+(x + w).toFixed(2)} ${+(y + r - k * r).toFixed(2)} ${+(x + w).toFixed(2)} ${+(y + r).toFixed(2)} c`,
      `${+(x + w).toFixed(2)} ${+(y + h - r).toFixed(2)} l`,
      `${+(x + w).toFixed(2)} ${+(y + h - r + k * r).toFixed(2)} ${+(x + w - r + k * r).toFixed(2)} ${+(y + h).toFixed(2)} ${+(x + w - r).toFixed(2)} ${+(y + h).toFixed(2)} c`,
      `${+(x + r).toFixed(2)} ${+(y + h).toFixed(2)} l`,
      `${+(x + r - k * r).toFixed(2)} ${+(y + h).toFixed(2)} ${+(x).toFixed(2)} ${+(y + h - r + k * r).toFixed(2)} ${+(x).toFixed(2)} ${+(y + h - r).toFixed(2)} c`,
      `${+(x).toFixed(2)} ${+(y + r).toFixed(2)} l`,
      `${+(x).toFixed(2)} ${+(y + r - k * r).toFixed(2)} ${+(x + r - k * r).toFixed(2)} ${+(y).toFixed(2)} ${+(x + r).toFixed(2)} ${+(y).toFixed(2)} c`,
      mode,
    );
  }

  circle(xMm, yMm, rMm, mode = 'f') {
    const x = xMm * MM, y = H_PT - yMm * MM, r = rMm * MM, k = 0.5523 * r;
    this.push(
      `${+(x).toFixed(2)} ${+(y + r).toFixed(2)} m`,
      `${+(x + k).toFixed(2)} ${+(y + r).toFixed(2)} ${+(x + r).toFixed(2)} ${+(y + k).toFixed(2)} ${+(x + r).toFixed(2)} ${+(y).toFixed(2)} c`,
      `${+(x + r).toFixed(2)} ${+(y - k).toFixed(2)} ${+(x + k).toFixed(2)} ${+(y - r).toFixed(2)} ${+(x).toFixed(2)} ${+(y - r).toFixed(2)} c`,
      `${+(x - k).toFixed(2)} ${+(y - r).toFixed(2)} ${+(x - r).toFixed(2)} ${+(y - k).toFixed(2)} ${+(x - r).toFixed(2)} ${+(y).toFixed(2)} c`,
      `${+(x - r).toFixed(2)} ${+(y + k).toFixed(2)} ${+(x - k).toFixed(2)} ${+(y + r).toFixed(2)} ${+(x).toFixed(2)} ${+(y + r).toFixed(2)} c`,
      mode,
    );
  }

  line(x1Mm, y1Mm, x2Mm, y2Mm) {
    this.push(`${+(x1Mm * MM).toFixed(2)} ${+(H_PT - y1Mm * MM).toFixed(2)} m`, `${+(x2Mm * MM).toFixed(2)} ${+(H_PT - y2Mm * MM).toFixed(2)} l S`);
  }

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
    if (align === 'right') px -= w;
    this.push('BT');
    if (color) this.push(rg(color));
    this.push(`/${fn} ${fs} Tf`);
    this.push(`${+px.toFixed(2)} ${+py.toFixed(2)} Td`);
    this.push(`(${str}) Tj`);
    this.push('ET');
  }

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
    lines.forEach((l, i) => this.text(l, xMm, yMm + i * lh, { fontName, fontSize, color }));
    return lines.length;
  }

  getStreams() { return this.pages.map(ops => ops.join('\n')); }
  getStream() { return this.getStreams()[0]; }
}

// ─── Assemblage du fichier PDF final (xref, polices, images) ─────────────
// Chaîne texte PDF en UTF-16BE (BOM + code units) : valable pour tout caractère,
// sans dépendre de PDFDocEncoding (qui diffère de WinAnsi pour € par exemple).
function pdfTextString(text) {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/**
 * @param {string[]} contentStreams  un flux de contenu par page
 * @param {object[]} images
 * @param {{ title?: string, author?: string }} [meta]  métadonnées du document (onglet du
 *        navigateur, propriétés du fichier). Facultatif : sans lui, aucun bloc /Info.
 */
export function buildPdfDocument(contentStreams, images = [], meta) {
  const pageCount = contentStreams.length;
  const pageObjStart = 3;
  const streamObjStart = pageObjStart + pageCount;
  const font1ObjNum = streamObjStart + pageCount;   // Helvetica
  const font2ObjNum = font1ObjNum + 1;               // Helvetica-Bold
  const font3ObjNum = font2ObjNum + 1;               // Times-Italic
  const imageObjStart = font3ObjNum + 1;
  const imageObjNums = images.map((_, i) => imageObjStart + i);
  const lastImageObjNum = imageObjStart + images.length - 1;
  const hasMeta = !!(meta && (meta.title || meta.author));
  const infoObjNum = hasMeta ? lastImageObjNum + 1 : 0;
  const lastObjNum = infoObjNum || lastImageObjNum;

  const objChunks = new Array(lastObjNum);

  objChunks[0] = [strToBytes(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`)];

  const kidsRef = Array.from({ length: pageCount }, (_, i) => `${pageObjStart + i} 0 R`).join(' ');
  objChunks[1] = [strToBytes(`2 0 obj\n<< /Type /Pages /Kids [${kidsRef}] /Count ${pageCount} >>\nendobj\n`)];

  const xobjectDict = images.length
    ? ` /XObject << ${images.map((img, i) => `/${img.id} ${imageObjNums[i]} 0 R`).join(' ')} >>`
    : '';

  for (let i = 0; i < pageCount; i++) {
    const pageNum = pageObjStart + i;
    const streamNum = streamObjStart + i;
    objChunks[pageNum - 1] = [strToBytes(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R\n` +
      `/MediaBox [0 0 ${W_PT.toFixed(2)} ${H_PT.toFixed(2)}]\n` +
      `/Resources << /Font << /F1 ${font1ObjNum} 0 R /F2 ${font2ObjNum} 0 R /F3 ${font3ObjNum} 0 R >>${xobjectDict} >>\n` +
      `/Contents ${streamNum} 0 R >>\nendobj\n`,
    )];
  }

  for (let i = 0; i < pageCount; i++) {
    const streamNum = streamObjStart + i;
    const streamBytes = strToBytes(contentStreams[i]);
    objChunks[streamNum - 1] = [
      strToBytes(`${streamNum} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`),
      streamBytes,
      strToBytes(`\nendstream\nendobj\n`),
    ];
  }

  objChunks[font1ObjNum - 1] = [strToBytes(`${font1ObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`)];
  objChunks[font2ObjNum - 1] = [strToBytes(`${font2ObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`)];
  objChunks[font3ObjNum - 1] = [strToBytes(`${font3ObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>\nendobj\n`)];

  images.forEach((img, i) => {
    const objNum = imageObjNums[i];
    const header = strToBytes(
      `${objNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
      `/ColorSpace /${img.colorSpace} /BitsPerComponent ${img.bpc} /Filter /${img.filter} /Length ${img.bytes.length} >>\nstream\n`,
    );
    objChunks[objNum - 1] = [header, img.bytes, strToBytes(`\nendstream\nendobj\n`)];
  });

  if (infoObjNum) {
    const fields = [
      meta.title ? `/Title ${pdfTextString(meta.title)}` : '',
      meta.author ? `/Author ${pdfTextString(meta.author)}` : '',
      '/Producer (AFFBC inscription)',
    ].filter(Boolean).join(' ');
    objChunks[infoObjNum - 1] = [strToBytes(`${infoObjNum} 0 obj\n<< ${fields} >>\nendobj\n`)];
  }

  const header = strToBytes('%PDF-1.4\n');
  const offsets = [];
  const allChunks = [header];
  let cursor = header.length;
  for (const chunkList of objChunks) {
    offsets.push(cursor);
    for (const chunk of chunkList) { allChunks.push(chunk); cursor += chunk.length; }
  }
  const xrefOffset = cursor;
  const n = lastObjNum + 1;
  let xrefStr = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (const off of offsets) xrefStr += `${String(off).padStart(10, '0')} 00000 n \n`;
  xrefStr += `trailer\n<< /Size ${n} /Root 1 0 R${infoObjNum ? ` /Info ${infoObjNum} 0 R` : ''} >>\nstartxref\n${xrefOffset}\n%%EOF`;
  allChunks.push(strToBytes(xrefStr));

  return concatBytes(allChunks);
}
