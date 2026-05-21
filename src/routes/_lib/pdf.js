/**
 * src/_lib/pdf.js
 *
 * Générateur PDF natif pour Cloudflare Workers.
 * Reproduit fidèlement la mise en page :
 *   – Bandeau rouge header + badge vert "DOSSIER VALIDÉ"
 *   – Bandeau doré récapitulatif (formule / cotisation / tenue / total)
 *   – S1 Identité  S2 Coordonnées  S3 Pratique  S4 Tenue
 *   – S5 Questionnaire santé  S6 Engagements & signature
 *   – Footer bleu marine
 *
 * Contraintes Workers :
 *   – Pas de DOM, pas de canvas, pas de require() Node
 *   – Uniquement fetch, crypto, TextEncoder disponibles
 *   – Polices : Helvetica (intégrée PDF Type1), Times-Italic pour la signature
 *
 * Utilisation :
 *   import { generateAdherentPdf } from '../_lib/pdf.js';
 *   const pdfBytes = await generateAdherentPdf(registration);   // Uint8Array
 */

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

const RED  = [162, 53, 33];
const DARK = [111, 33, 23];
const GOLD = [196, 154, 55];
const INK  = [32, 20, 15];
const MUTED= [110, 95, 85];
const LINE = [216, 200, 184];
const WHITE= [255, 255, 255];
const GREEN= [31, 107, 71];
const NAVY = [36, 49, 63];
const CREAM= [252, 250, 246];
const GOLD_BG  = [239, 227, 190];
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
    .replace(/[^\x20-\x7E]/g, ' ')
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

// ─── Constructeur de contenu PDF multi-pages ──────────────────────────────────

class PdfBuilder {
    constructor() {
        this.pages      = [[]];   // tableau de pages, chacune = tableau d'opérateurs
        this.pageIndex  = 0;
        this.font       = null;
        this.fontSize   = 10;
    }

    // Page courante
    get ops() { return this.pages[this.pageIndex]; }

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
        const estW = str.length * fs * 0.48;
        if (align === 'center') px -= estW / 2;
        if (align === 'right')  px -= estW;
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
        const fs = fontSize || this.fontSize;
        const maxPt = maxWMm * MM;
        const charW = fs * 0.48;
        const maxChars = Math.max(1, Math.floor(maxPt / charW));
        const words = safe(txt).split(' ');
        const lines = [];
        let cur = '';
        for (const w of words) {
            const candidate = cur ? `${cur} ${w}` : w;
            if (candidate.length <= maxChars) { cur = candidate; continue; }
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

/**
 * @param {object} registration  Données du dossier (format dossier JSON de status.js)
 * @returns {Uint8Array}
 */
export function generateAdherentPdf(registration) {
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

    const p = new PdfBuilder();

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
        p.text(val || '-',          xMm + 2, yMm + 6.2, { fontSize: 7,   color: val ? INK : MUTED });
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
    p.text(`Saison 2025-2026  .  ${submittedAt}`,           fx, 23,   { fontSize: 6.5, color: [220, 200, 180] });

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
    p.text("Photo",      ML/MM + 11, y + 13,   { fontSize: 5, color: MUTED, align: 'center' });
    p.text("d'identite", ML/MM + 11, y + 16.5, { fontSize: 5, color: MUTED, align: 'center' });

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
    p.text('Adhesion annuelle - Licence FFK - Assurance RC + IA - Saison 2025-2026',
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

    return buildPdfDocument(p.getStreams());
}

// ─── Assemblage bas niveau PDF 1.4 multi-pages ───────────────────────────────

function buildPdfDocument(contentStreams) {
    const pageCount = contentStreams.length;

    // Numéros d'objets :
    //  1 = Catalog
    //  2 = Pages
    //  3..3+pageCount-1 = Page objects
    //  3+pageCount..   = Content streams
    //  puis F1 (Helvetica) et F2 (Times-Italic)

    const pageObjStart    = 3;
    const streamObjStart  = pageObjStart + pageCount;
    const font1ObjNum     = streamObjStart + pageCount;
    const font2ObjNum     = font1ObjNum + 1;
    const totalObjCount   = font2ObjNum + 1;  // dernier numéro + 1

    const objs = new Array(totalObjCount - 1); // index 0 = objet 1

    // 1 — Catalog
    objs[0] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`;

    // 2 — Pages node
    const kidsRef = Array.from({ length: pageCount }, (_, i) => `${pageObjStart + i} 0 R`).join(' ');
    objs[1] = `2 0 obj\n<< /Type /Pages /Kids [${kidsRef}] /Count ${pageCount} >>\nendobj`;

    // Page objects
    for (let i = 0; i < pageCount; i++) {
        const pageNum   = pageObjStart + i;
        const streamNum = streamObjStart + i;
        objs[pageNum - 1] =
            `${pageNum} 0 obj\n` +
            `<< /Type /Page /Parent 2 0 R\n` +
            `/MediaBox [0 0 ${W_PT.toFixed(2)} ${H_PT.toFixed(2)}]\n` +
            `/Resources << /Font << /F1 ${font1ObjNum} 0 R /F2 ${font2ObjNum} 0 R >> >>\n` +
            `/Contents ${streamNum} 0 R >>\nendobj`;
    }

    // Content streams
    for (let i = 0; i < pageCount; i++) {
        const streamNum = streamObjStart + i;
        const stream = contentStreams[i];
        objs[streamNum - 1] =
            `${streamNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`;
    }

    // Polices
    objs[font1ObjNum - 1] =
        `${font1ObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`;
    objs[font2ObjNum - 1] =
        `${font2ObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>\nendobj`;

    // Assemblage final + xref
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (const obj of objs) {
        offsets.push(pdf.length);
        pdf += obj + '\n';
    }
    const xrefOffset = pdf.length;
    const n = totalObjCount;
    pdf += `xref\n0 ${n}\n`;
    pdf += '0000000000 65535 f \n';
    for (const off of offsets) {
        pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) {
        bytes[i] = pdf.charCodeAt(i) & 0xff;
    }
    return bytes;
}
