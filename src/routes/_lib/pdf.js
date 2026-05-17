/**
 * src/_lib/pdf.js
 *
 * Générateur PDF natif pour Cloudflare Workers.
 * Reproduit fidèlement la mise en page de pdf.js (jsPDF) :
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
function rg(c)  { const [r,g,b] = rgb255(c); return `${r} ${g} ${b} rg`; }   // fill text
function RG(c)  { const [r,g,b] = rgb255(c); return `${r} ${g} ${b} RG`; }   // stroke
function sc(c)  { const [r,g,b] = rgb255(c); return `${r} ${g} ${b} sc`; }
function cs(c)  { const [r,g,b] = rgb255(c); return `${r} ${g} ${b} cs`; }

// ─── Encodage sécurisé (ASCII latin-1) ───────────────────────────────────────

function safe(v) {
    return String(v ?? '')
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

// ─── Conversion coordonnées (mm depuis haut → pt depuis bas) ─────────────────

function yPt(yMm) { return H_PT - yMm * MM; }

// ─── Constructeur de contenu PDF ──────────────────────────────────────────────

class PdfBuilder {
    constructor() {
        this.ops = [];   // opérateurs de flux de contenu
        this.font = null;
        this.fontSize = 10;
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

    // ── Formes ─────────────────────────────────────────────────────────────────

    rect(xMm, yMm, wMm, hMm, mode = 'f') {
        const x = xMm * MM;
        const y = yPt(yMm + hMm);
        const w = wMm * MM;
        const h = hMm * MM;
        this.push(`${+x.toFixed(2)} ${+y.toFixed(2)} ${+w.toFixed(2)} ${+h.toFixed(2)} re ${mode}`);
    }

    // Rect avec coins arrondis (approximation par courbes de Bézier)
    roundedRect(xMm, yMm, wMm, hMm, rMm, mode = 'f') {
        const x = xMm * MM, y = yPt(yMm + hMm);
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
        const x = xMm * MM, y = yPt(yMm), r = rMm * MM;
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
            `${+(x1Mm*MM).toFixed(2)} ${+(yPt(y1Mm)).toFixed(2)} m`,
                  `${+(x2Mm*MM).toFixed(2)} ${+(yPt(y2Mm)).toFixed(2)} l S`,
        );
    }

    // ── Texte ───────────────────────────────────────────────────────────────────

    text(txt, xMm, yMm, opts = {}) {
        const { align = 'left', fontName, fontSize, color } = opts;
        const str = esc(txt);
        if (!str) return;
        let px = xMm * MM;
        const py = yPt(yMm);
        const fn = fontName || this.font || 'F1';
        const fs = fontSize || this.fontSize;
        // Estimation largeur (Helvetica ≈ 0.5 × fontSize par car en pt)
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
        const lh = fs * 1.35 / MM; // line-height en mm
        lines.forEach((l, i) => {
            this.text(l, xMm, yMm + i * lh, { fontName, fontSize, color });
        });
        return lines.length;
    }

    // ── Export flux ─────────────────────────────────────────────────────────────

    getStream() { return this.ops.join('\n'); }
}

// ─── Construction du PDF ──────────────────────────────────────────────────────

/**
 * @param {object} registration  Données du dossier (format dossier JSON de status.js)
 * @returns {Uint8Array}
 */
export function generateAdherentPdf(registration) {
    // Normalisation des données (même structure que dossier dans status.js)
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

    // Données synthétiques pour bandeau doré
    const formulaLabel = totals.formulaLabel || pr.formulaCode || 'Tarif de base';
    const cotisation   = Number(totals.cotisation   || 0);
    const clothingTotal= Number(totals.clothingTotal || 0);
    const total        = Number(totals.total         || 0);
    const installments = Math.max(1, Math.min(3, Number(pay.installmentCount || 1)));
    const ref          = String(registration.id || 'AFFBC-XXXX').slice(0, 36);
    const submittedAt  = registration.submittedAt || new Date().toISOString().slice(0, 10);

    const p = new PdfBuilder();

    // ══════════════════════════════════════════════════════════════════════
    // HEADER ROUGE  (0 → 39.5 mm)
    // ══════════════════════════════════════════════════════════════════════

    // Bande top 1.5 mm + bloc 38 mm
    p.setFillRgb(RED);
    p.rect(0, 0, 210, 1.5, 'f');
    p.rect(0, 1.5, 210, 38, 'f');

    // Cercle logo blanc
    p.setFillRgb(WHITE);
    p.circle(ML/MM + 12, 20, 12, 'f');
    p.setStrokeRgb(RED);
    p.setLineWidth(0.5);
    p.circle(ML/MM + 12, 20, 12, 'S');

    // Texte logo
    p.text('FULL',              ML/MM + 12, 18, { fontSize: 5,   color: RED,  align: 'center' });
    p.text('FIGHTING',          ML/MM + 12, 22, { fontSize: 5,   color: RED,  align: 'center' });
    p.text('BONS EN CHABLAIS',  ML/MM + 12, 26, { fontSize: 4,   color: DARK, align: 'center' });

    // Texte header
    const fx = ML/MM + 28;
    p.text('American Full Fighting Bons en Chablais - FFK', fx, 10, { fontSize: 8, color: [255, 247, 237] });
    p.text("Dossier d'Adhesion",                            fx, 18, { fontSize: 16,color: [255, 247, 237] });
    p.text(`Saison 2025-2026  .  ${submittedAt}`,           fx, 24, { fontSize: 7, color: [220, 200, 180] });

    // Ref + badge vert
    p.text(`Ref. ${ref}`, 210 - ML/MM, 12, { fontSize: 6.5, color: [255, 247, 237], align: 'right' });
    p.setFillRgb(GREEN);
    p.roundedRect(210 - ML/MM - 28, 16, 28, 6, 3, 'f');
    p.text('DOSSIER VALIDE', 210 - ML/MM - 14, 20.2, { fontSize: 6, color: WHITE, align: 'center' });

    // ══════════════════════════════════════════════════════════════════════
    // BANDEAU DORÉ  (39.5 → 51 mm)
    // ══════════════════════════════════════════════════════════════════════

    let y = 39.5;
    p.setFillRgb(GOLD_BG);
    p.setStrokeRgb(GOLD);
    p.setLineWidth(0.3);
    p.rect(0, y, 210, 9, 'B');  // B = fill + stroke

    const summaryItems = [
        [formulaLabel,                    'Formule'],
        [`${cotisation.toFixed(2)} EUR`,  'Cotisation'],
        [`${clothingTotal.toFixed(2)} EUR`,'Tenue club'],
        [`${total.toFixed(2)} EUR total`, `HelloAsso ${installments}x`],
    ];
    const colW = 210 / summaryItems.length;
    summaryItems.forEach(([val, lbl], i) => {
        const cx = i * colW + colW / 2;
        p.text(val, cx, y + 4.5, { fontSize: 7, color: [61, 40, 0], align: 'center' });
        p.text(lbl, cx, y + 7.5, { fontSize: 5.5, color: [138, 105, 32], align: 'center' });
        if (i < summaryItems.length - 1) {
            p.setStrokeRgb(GOLD);
            p.setLineWidth(0.3);
            p.line(i * colW + colW, y + 1.5, i * colW + colW, y + 7.5);
        }
    });

    y += 12;

    // ══════════════════════════════════════════════════════════════════════
    // HELPERS SECTION / FIELD / QS
    // ══════════════════════════════════════════════════════════════════════

    function section(num, title) {
        p.setFillRgb(RED);
        p.circle(ML/MM + 3, y + 3, 3.5, 'f');
        p.text(String(num), ML/MM + 3, y + 4,   { fontSize: 7, color: WHITE, align: 'center' });
        p.text(title,       ML/MM + 10, y + 4.5, { fontSize: 12, color: INK });
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.3);
        p.line(ML/MM, y + 7, 210 - ML/MM, y + 7);
        y += 10;
    }

    function field(label, value, xMm, yMm, wMm) {
        p.setFillRgb(WHITE);
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.2);
        p.roundedRect(xMm, yMm, wMm, 8, 1.5, 'B');
        p.text(label.toUpperCase(), xMm + 2, yMm + 3.2, { fontSize: 5, color: MUTED });
        const val = safe(value);
        p.text(val || '-', xMm + 2, yMm + 6.5, { fontSize: 7.5, color: val ? INK : MUTED });
    }

    function qsRow(question, answer) {
        const positive = answer === 'yes';
        p.setFillRgb(WHITE);
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.2);
        p.roundedRect(ML/MM, y, CW/MM - 22, 6.5, 1.2, 'B');
        p.text(question, ML/MM + 2, y + 4.2, { fontSize: 6, color: INK });
        p.setFillRgb(positive ? WARN_BG : OK_BG);
        p.roundedRect(210 - ML/MM - 20, y, 20, 6.5, 3, 'f');
        p.text(positive ? 'OUI' : 'NON', 210 - ML/MM - 10, y + 4.2, {
            fontSize: 6, color: positive ? RED : GREEN, align: 'center',
        });
        y += 7.5;
    }

    // ══════════════════════════════════════════════════════════════════════
    // S1 — IDENTITÉ
    // ══════════════════════════════════════════════════════════════════════

    section(1, "Identite du pratiquant");

    // Emplacement photo (rectangle beige si pas de photo)
    p.setFillRgb([241, 236, 228]);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, 22, 28, 2, 'B');
    p.text("Photo",       ML/MM + 11, y + 14,   { fontSize: 5, color: MUTED, align: 'center' });
    p.text("d'identite",  ML/MM + 11, y + 17.5, { fontSize: 5, color: MUTED, align: 'center' });

    const fx2  = ML/MM + 25;
    const fw2  = (CW/MM - 27) / 2;
    field('Nom',               safe(id.lastName)?.toUpperCase(), fx2,        y,      fw2);
    field('Prenom',            safe(id.firstName),               fx2+fw2+2,  y,      fw2);
    field('Date de naissance', safe(id.birthDate),               fx2,        y + 10, fw2);
    field('Lieu de naissance', safe(id.birthPlace),              fx2+fw2+2,  y + 10, fw2);

    y += 32;

    // ══════════════════════════════════════════════════════════════════════
    // S2 — COORDONNÉES
    // ══════════════════════════════════════════════════════════════════════

    section(2, "Coordonnees");
    const hw = (CW/MM - 4) / 2;
    field('Adresse', `${safe(ct.address1)} ${safe(ct.address2)}`.trim(), ML/MM, y, CW/MM);
    y += 10;
    field('Code postal',          safe(ct.postalCode),    ML/MM,       y, hw);
    field('Ville',                safe(ct.city),          ML/MM+hw+4,  y, hw);
    y += 10;
    field('Telephone principal',  safe(ct.phonePrimary),  ML/MM,       y, hw);
    field('Telephone secondaire', safe(ct.phoneSecondary),ML/MM+hw+4,  y, hw);
    y += 10;
    field('Email', safe(ct.email), ML/MM, y, CW/MM);
    y += 12;

    // Urgence
    p.text("PERSONNE A CONTACTER EN CAS D'URGENCE", ML/MM, y, { fontSize: 6.5, color: MUTED });
    y += 5;
    const qw = (CW/MM - 6) / 4;
    field('Nom',              safe(em.lastName)?.toUpperCase(), ML/MM,              y, qw);
    field('Prenom',           safe(em.firstName),               ML/MM+qw+2,         y, qw);
    field('Tel. principal',   safe(em.phonePrimary),            ML/MM+2*(qw+2),     y, qw);
    field('Tel. secondaire',  safe(em.phoneSecondary),          ML/MM+3*(qw+2),     y, qw);
    y += 12;

    // ══════════════════════════════════════════════════════════════════════
    // S3 — PRATIQUE & FORMULE
    // ══════════════════════════════════════════════════════════════════════

    section(3, "Pratique & Formule tarifaire");
    const tw = (CW/MM - 8) / 3;
    field("Type d'inscription",  pr.typeInscription === 'nouvelle' ? 'Nouvelle adhesion' : 'Renouvellement', ML/MM,          y, tw);
    field('Type de pratique',    pr.practiceType === 'loisir' ? 'Loisir' : safe(pr.practiceType),           ML/MM+tw+2,     y, tw);
    field('Formule tarifaire',   formulaLabel,                                                               ML/MM+2*(tw+2), y, tw);
    y += 10;
    field('Passeport sportif', pr.passportEnabled ? 'Oui' : 'Non',                             ML/MM,          y, tw);
    field('Pass Region',       pr.passRegionEnabled ? `Oui - ${pr.passRegionAmount} EUR` : 'Non utilise', ML/MM+tw+2, y, tw);
    field('Paiement',          `HelloAsso - ${installments} fois`,                             ML/MM+2*(tw+2), y, tw);
    y += 12;

    // Formule box dorée
    p.setFillRgb(FORMULA_BG);
    p.setStrokeRgb(GOLD);
    p.setLineWidth(0.5);
    p.roundedRect(ML/MM, y, CW/MM, 16, 2, 'B');
    p.text(formulaLabel, ML/MM + 4, y + 6, { fontSize: 11, color: INK });
    p.text('Adhesion annuelle - Licence FFK - Assurance RC + IA - Saison 2025-2026', ML/MM + 4, y + 10.5, { fontSize: 6.5, color: MUTED });
    p.text(`${total.toFixed(2)} EUR`, 210 - ML/MM - 4, y + 8, { fontSize: 15, color: DARK, align: 'right' });
    p.text(
        `Cotis. ${cotisation.toFixed(2)} + Kit ${Number(totals.newMemberKit || 0).toFixed(2)} + Tenue ${clothingTotal.toFixed(2)}`,
           210 - ML/MM - 4, y + 12.5, { fontSize: 6, color: MUTED, align: 'right' },
    );
    y += 20;

    // Échéancier si > 1 fois
    if (installments > 1) {
        const base = Math.floor((total * 100) / installments);
        const rem  = Math.round(total * 100) - base * installments;
        const ecW  = (CW/MM - (installments - 1) * 3) / installments;
        for (let i = 0; i < installments; i++) {
            const amount = ((base + (i === 0 ? rem : 0)) / 100).toFixed(2);
            p.setFillRgb(WHITE);
            p.setStrokeRgb(LINE);
            p.setLineWidth(0.2);
            p.roundedRect(ML/MM + i * (ecW + 3), y, ecW, 10, 1.5, 'B');
            p.text(`${i + 1}${i === 0 ? 're' : 'e'} echeance`, ML/MM + i * (ecW + 3) + ecW / 2, y + 3.5, { fontSize: 5.5, color: MUTED, align: 'center' });
            p.text(`${amount} EUR`, ML/MM + i * (ecW + 3) + ecW / 2, y + 7.5, { fontSize: 8, color: INK, align: 'center' });
        }
        y += 14;
    }

    // ══════════════════════════════════════════════════════════════════════
    // S4 — TENUE
    // ══════════════════════════════════════════════════════════════════════

    section(4, "Commande tenue du club");
    const colXs = [ML/MM, ML/MM+65, ML/MM+90, ML/MM+110, ML/MM+135];
    ['Article', 'P.U.', 'Taille', 'Qte', 'Sous-total'].forEach((h, i) => {
        p.text(h, colXs[i], y, { fontSize: 5.5, color: MUTED });
    });
    y += 4;

    const tshirtQty   = Number(co.tshirtQty   || 0);
    const pantalonQty = Number(co.pantalonQty  || 0);
    const priceTshirt = Number(totals.pricingTshirt  || 25);
    const pricePantalon=Number(totals.pricingPantalon|| 10);

    const tenueRows = [
        ['T-shirt club AFFBC',  `${priceTshirt} EUR`,  safe(co.tshirtSize)  || '-', tshirtQty,   `${(tshirtQty   * priceTshirt).toFixed(2)} EUR`],
        ['Pantalon club AFFBC', `${pricePantalon} EUR`, safe(co.pantalonSize)|| '-', pantalonQty, `${(pantalonQty * pricePantalon).toFixed(2)} EUR`],
    ];
    tenueRows.forEach(row => {
        p.setFillRgb(WHITE);
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.2);
        p.roundedRect(ML/MM, y, CW/MM, 8, 1.2, 'B');
        row.forEach((cell, i) => {
            p.text(String(cell), colXs[i] + 2, y + 5.2, { fontSize: i === 0 ? 7 : 6.5, color: INK });
        });
        y += 10;
    });
    p.text(`Total tenue : ${clothingTotal.toFixed(2)} EUR`, 210 - ML/MM, y, { fontSize: 6.5, color: DARK, align: 'right' });
    y += 8;

    // ══════════════════════════════════════════════════════════════════════
    // S5 — QUESTIONNAIRE SANTÉ
    // ══════════════════════════════════════════════════════════════════════

    section(5, "Questionnaire de sante (art. L. 231-2-1 Code du sport)");
    const QS_LABELS = [
        ['familyCardiacDeath', 'Deces cardiaque soudain dans la famille avant 50 ans'],
        ['chestPain',          'Douleur thoracique a l effort'],
        ['wheezing',           'Sifflements / difficultes respiratoires pendant l effort'],
        ['fainting',           'Perte de connaissance ou syncope'],
        ['sportStop',          'Medecin ayant conseille l arret du sport'],
        ['longTermTreatment',  'Traitement medical de longue duree'],
        ['bonePain',           'Douleurs articulaires ou osseuses hors traumatismes'],
        ['practiceInterrupted','Interruption d entrainement pour raison medicale (12 mois)'],
        ['medicalAdviceNeeded','Avis medical ou surveillance particuliere requise'],
    ];
    const positives = [];
    QS_LABELS.forEach(([key, label]) => {
        const ans = qs[key] ?? 'no';
        if (ans === 'yes') positives.push(label);
        qsRow(label, ans);
    });
    if (positives.length > 0) {
        p.setFillRgb(WARN_BG);
        p.setStrokeRgb(RED);
        p.setLineWidth(0.3);
        p.roundedRect(ML/MM, y, CW/MM, 10, 1.5, 'B');
        p.text('! Reponse(s) affirmative(s) - un certificat medical est joint au dossier', ML/MM + 3, y + 5, { fontSize: 6, color: DARK });
        p.text(`Questions : ${positives.join(', ')}`, ML/MM + 3, y + 8.5, { fontSize: 5.5, color: MUTED });
        y += 13;
    }
    y += 3;

    // ══════════════════════════════════════════════════════════════════════
    // S6 — ENGAGEMENTS & SIGNATURE
    // ══════════════════════════════════════════════════════════════════════

    section(6, "Engagements, consentements & signature");
    const engagements = [
        [cs.rulesAccepted,           "J'ai lu et j'accepte sans reserve le reglement interieur du club AFFBC."],
        [cs.insuranceAcknowledged,   "J'ai pris connaissance des modalites d'assurance FFK (WTW DGPL Federations)."],
        [cs.imageRights === 'yes',   `Droit a l'image : ${cs.imageRights === 'yes' ? 'Autorise' : 'Non autorise'} — utilisation a but non commercial.`],
    ];
    engagements.forEach(([ok, text]) => {
        p.setFillRgb(ok ? OK_BG : [248, 245, 242]);
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.2);
        p.roundedRect(ML/MM, y, CW/MM, 8, 1.2, 'B');
        p.setFillRgb(ok ? GREEN : MUTED);
        p.circle(ML/MM + 5, y + 4, 3, 'f');
        p.text(ok ? 'v' : '-', ML/MM + 5, y + 4.8, { fontSize: 7, color: WHITE, align: 'center' });
        p.text(text, ML/MM + 11, y + 4.8, { fontSize: 6, color: INK });
        y += 10;
    });

    y += 3;
    // Blocs lieu / date
    const sw = (CW/MM - 4) / 2;
    [['Fait a', safe(cs.city) || 'Thonon-les-Bains'], ['Le', safe(cs.signedAt)]].forEach(([lbl, val], i) => {
        p.setFillRgb(WHITE);
        p.setStrokeRgb(LINE);
        p.setLineWidth(0.2);
        p.roundedRect(ML/MM + i * (sw + 4), y, sw, 12, 1.5, 'B');
        p.text(lbl.toUpperCase(), ML/MM + i * (sw + 4) + 2, y + 3.5, { fontSize: 5, color: MUTED });
        p.text(val || '-',        ML/MM + i * (sw + 4) + 2, y + 8,   { fontSize: 7, color: INK });
    });
    y += 15;

    // Bloc signature
    p.setFillRgb(WHITE);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM, 14, 1.5, 'B');
    p.text("SIGNATURE DE L'ADHERENT(E) - nom saisi valant signature electronique", ML/MM + 2, y + 3.5, { fontSize: 5, color: MUTED });
    // Signature en Times italic
    p.text(safe(cs.applicantSignatureName) || '', ML/MM + 3, y + 10, { fontSize: 10, color: INK });
    y += 18;

    // Bloc réservé club
    p.setFillRgb(BEIGE_BG);
    p.setStrokeRgb(LINE);
    p.setLineWidth(0.2);
    p.roundedRect(ML/MM, y, CW/MM, 10, 1.5, 'B');
    p.text('RESERVE AU CLUB', ML/MM + 2, y + 4, { fontSize: 5.5, color: INK });
    p.text('Verifie par : _______________________  .  N° adherent : ___________  .  Licence FFK emise le : ___________  .  Visa : _______',
           ML/MM + 2, y + 8, { fontSize: 5.5, color: MUTED });
    y += 14;

    // ══════════════════════════════════════════════════════════════════════
    // FOOTER
    // ══════════════════════════════════════════════════════════════════════

    const footerY = 282;
    p.setFillRgb(NAVY);
    p.rect(0, footerY, 210, 15, 'f');
    p.text('AFFBC - American Full Fighting Bons en Chablais', ML/MM, footerY + 6, { fontSize: 7, color: WHITE });
    p.text('fullfightingbons@gmail.com  .  06 99 95 81 77  .  inscription.americanfullfightingbons.fr',
           ML/MM, footerY + 10.5, { fontSize: 6.5, color: [180, 180, 180] });
    p.text(`Ref. ${ref}  .  Page 1/1`, 210 - ML/MM, footerY + 8, { fontSize: 6.5, color: [130, 130, 130], align: 'right' });

    // ══════════════════════════════════════════════════════════════════════
    // ASSEMBLAGE PDF (structure PDF 1.4)
    // ══════════════════════════════════════════════════════════════════════

    return buildPdfDocument(p.getStream());
}

// ─── Assemblage bas niveau PDF 1.4 ───────────────────────────────────────────

function buildPdfDocument(contentStream) {
    // Deux polices : F1 = Helvetica, F2 = Times-Italic
    const objs = [];
    objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
    objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj');
    objs.push(
        `3 0 obj\n<< /Type /Page /Parent 2 0 R\n` +
        `/MediaBox [0 0 ${W_PT.toFixed(2)} ${H_PT.toFixed(2)}]\n` +
        `/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >>\n` +
        `/Contents 4 0 R >>\nendobj`,
    );
    const stream = contentStream;
    objs.push(
        `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
    );
    objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj');
    objs.push('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>\nendobj');

    // Assemblage + xref
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (const obj of objs) {
        offsets.push(pdf.length);
        pdf += obj + '\n';
    }
    const xrefOffset = pdf.length;
    const n = objs.length + 1;
    pdf += `xref\n0 ${n}\n`;
    pdf += '0000000000 65535 f \n';
    for (const off of offsets) {
        pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    // Conversion string → Uint8Array (latin-1 pour préserver les bytes PDF)
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) {
        bytes[i] = pdf.charCodeAt(i) & 0xff;
    }
    return bytes;
}
