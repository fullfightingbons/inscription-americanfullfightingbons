/**
 * cotisation-receipt.js — AFFBC (inscription)
 * ─────────────────────────────────────────────────────────────────────────
 * Reçu de cotisation joint à l'e-mail de confirmation d'inscription : cotisation,
 * Pass Région et ARTICLES COMMANDÉS À L'INSCRIPTION (t-shirt, pantalon, passeport
 * sportif, produits en option).
 *
 * ⚠️ Copie JS de gestion/src/lib/pdf/cotisation-receipt.ts — GARDER LES DEUX EN
 * PHASE (les deux repos ne partagent aucun module). C'est le même document que
 * celui du bouton « Reçu » de l'onglet Adhérents et du reçu de l'espace membre :
 * mêmes lignes, même total, même numéro (REC-<saison>-<id adhérent>). Les tests
 * de chaque repo portent les mêmes valeurs de référence.
 *
 * Pourquoi une pièce jointe séparée du dossier récapitulatif : le récapitulatif
 * contient le questionnaire de santé, les consentements et les pièces déposées
 * (certificat médical, photo d'identité) fusionnées dans le PDF. Un adhérent qui
 * doit justifier son paiement auprès d'un employeur, d'un comité d'entreprise ou
 * d'une mutuelle ne peut pas transmettre ce fichier tel quel ; le reçu, lui, ne
 * contient que ce qui est nécessaire.
 *
 * D'où viennent les données
 * ─────────────────────────
 *  - Cotisation et Pass Région : la fiche `adherents` (`cotisation`,
 *    `montant_pass_region`) — la même ligne que celle lue par gestion.
 *  - Articles : le dossier d'inscription (`clothingOrder` pour les tailles,
 *    `computedTotals` pour quantités, prix et produits en option). Mêmes lignes que
 *    la facture « Ventes liées à l'inscription web » (buildInscriptionSaleLines
 *    dans payment/helloasso/status.js).
 *  - État du paiement (comptant, en 2 ou 3 fois) : `dossier.payment`, ou la valeur
 *    fournie par l'appelant quand l'e-mail part juste après le paiement.
 *
 * Fonctions pures, sauf generateCotisationReceiptPdf (charge le logo via ASSETS).
 */

import { PdfBuilder } from './pdf-engine.js';
import { buildDocumentPdfBytes } from './document-template.js';
import { resolveLogoImage } from './pdf.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Saison sportive (juillet → juin) d'une date ISO. Même règle que
 * currentSeasonLabel() (helpers.js) et que seasonFromDate() côté gestion.
 */
export function seasonLabelFromIso(iso) {
  const m = ISO_DATE.exec(String(iso ?? ''));
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = month >= 7 ? year : year - 1;
  return `${start}-${start + 1}`;
}

function frDate(iso) {
  const m = ISO_DATE.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// Retour à la ligne par mots : 44 caractères en Helvetica 8,7 pt tiennent dans la
// colonne « Destinataire » avec une marge.
function wrapWords(text, maxChars, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= maxChars || !cur) { cur = candidate; continue; }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function slug(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const euros = (n) => Math.round(n * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const eur2 = (n) => n.toFixed(2).replace('.', ',');

// ── Inscription en ligne → articles commandés ───────────────────────────────

// Statuts d'une inscription NON aboutie (les statuts « payee » et « paiement_planifie »
// sont, eux, des inscriptions validées).
const NON_FINAL_STATUSES = new Set(['brouillon', 'paiement_en_attente', 'traitement_paiement', 'echec_creation', 'abandonnee']);

// dossier_json est une colonne TEXT : chaîne JSON brute (objet déjà parsé toléré).
function parseDossier(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Saison d'une inscription = saison de la date de fin de SON exercice (même source que
 * `adherents.date_fin_adhesion`), pas de sa date de dépôt : une inscription déposée en juin
 * pour la saison suivante appartient à la saison suivante. Sans exercice exploitable, repli
 * sur la date de dépôt.
 */
export function registrationSeason(r) {
  const fin = String(r?.exercice_date_fin ?? '');
  return seasonLabelFromIso(VALID_DATE.test(fin) ? fin : r?.submitted_at || r?.created_at);
}

/** Dossier de la plus récente inscription finalisée de la saison donnée, ou null. */
export function pickSeasonRegistration(rows, season) {
  let best = null;
  for (const r of rows || []) {
    if (!r || NON_FINAL_STATUSES.has(String(r.statut ?? ''))) continue;
    if (!season || registrationSeason(r) !== season) continue;
    const dossier = parseDossier(r.dossier_json);
    if (!dossier || !dossier.computedTotals || typeof dossier.computedTotals !== 'object') continue;
    const at = String(r.updated_at || r.created_at || '');
    if (!best || at.localeCompare(best.at) > 0) best = { at, dossier };
  }
  return best ? best.dossier : null;
}

/**
 * Lignes « articles » d'une inscription : passeport, t-shirt, pantalon, produits en option.
 * Miroir de buildInscriptionSaleLines() (status.js), avec des libellés lisibles pour
 * l'adhérent. Le « kit nouvel adhérent » n'est plus facturé depuis le 10/09/2026 mais les
 * inscriptions antérieures l'ont réellement payé : il est repris s'il figure dans leurs totaux.
 */
export function registrationGoodsLines(dossier) {
  const totals = dossier?.computedTotals;
  if (!totals || typeof totals !== 'object') return [];
  const clothing = dossier?.clothingOrder && typeof dossier.clothingOrder === 'object' ? dossier.clothingOrder : {};
  const lignes = [];

  const add = (designation, qte, pu) => {
    const total = euros(qte * pu);
    if (qte > 0 && total > 0) lignes.push({ designation, qte, pu: euros(pu), total });
  };
  const taille = (s) => {
    const t = String(s ?? '').trim();
    return t ? ` (taille ${t})` : '';
  };

  add('Kit nouvel adhérent', 1, num(totals.newMemberKit));
  add('Passeport sportif', 1, num(totals.passport));
  add(`T-shirt club AFFBC${taille(clothing.tshirtSize)}`, num(totals.tshirtQty), num(totals.pricingTshirt));
  add(`Pantalon club AFFBC${taille(clothing.pantalonSize)}`, num(totals.pantalonQty), num(totals.pricingPantalon));
  for (const item of Array.isArray(totals.orderItems) ? totals.orderItems : []) {
    add(`${String(item?.name || 'Article')}${taille(item?.size)}`, num(item?.quantity), num(item?.unitPrice));
  }

  // Garde-fou : tout ce qui a été facturé en plus de la cotisation doit figurer sur le reçu.
  // Si le détail est incomplet (ancien format de dossier, prix absent), le reste part sur
  // une ligne « Autres articles ».
  if (num(totals.total) > 0) {
    const factureHorsCotisation = euros(num(totals.total) - num(totals.cotisation));
    const detaille = euros(lignes.reduce((s, l) => s + l.total, 0));
    const reste = euros(factureHorsCotisation - detaille);
    if (reste >= 0.01) add('Autres articles', 1, reste);
  }
  return lignes;
}

// ── Mention de paiement (pied de page) ──────────────────────────────────────

/**
 * Ligne du pied de page. Le total du tableau est la VALEUR de l'adhésion et des articles ;
 * le pied précise ce qui a été réglé :
 *  - paiement unique : « Mode de paiement : HelloAsso » (+ part Pass Région le cas échéant) ;
 *  - paiement en 2 ou 3 fois : ce qui est réglé à ce jour et ce qui reste à prélever, pour
 *    qu'un reçu émis dès la 1re échéance ne laisse pas croire que tout est déjà encaissé.
 *
 * @param {string} paiement
 * @param {number} passRegion
 * @param {number} total
 * @param {{ installmentCount?: number, paidAmountCents?: number, remainingAmountCents?: number }} [payment]
 *        montants en CENTIMES, comme persistés dans dossier_json.payment
 * @returns {string | undefined}
 */
export function paymentNote(paiement, passRegion, total, payment) {
  const count = Math.max(1, Math.min(3, Math.round(num(payment?.installmentCount)) || 1));
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  if (count > 1) {
    const paid = payment?.paidAmountCents;
    const remaining = payment?.remainingAmountCents;
    const known = paid != null && remaining != null && Number.isFinite(Number(paid)) && Number.isFinite(Number(remaining));
    const etat = !known
      ? ''
      : Number(remaining) <= 0
        ? 'intégralement réglé'
        : `${eur2(Number(paid) / 100)} € réglés à ce jour, ${eur2(Number(remaining) / 100)} € à prélever`;
    const region = passRegion > 0 ? `dont Pass Région : ${eur2(passRegion)} €` : '';
    return [`Mode de paiement : ${paiement || 'Paiement'} en ${count} fois`, etat, region].filter(Boolean).join(' - ');
  }

  const partRegion = passRegion > 0 ? `dont Pass Région : ${eur2(passRegion)} €, soit ${eur2(euros(total - passRegion))} € réglés par l'adhérent` : '';
  if (paiement) return `Mode de paiement : ${paiement}${partRegion ? ` (${partRegion})` : ''}`;
  return partRegion ? cap(partRegion) : undefined;
}

// ── Contenu du reçu ─────────────────────────────────────────────────────────

/**
 * @param {Record<string, any>} adherent  ligne `adherents`
 * @param {object[]} [registrations]      lignes `inscriptions_publiques` (+ exercice_date_fin)
 * @param {Date} [now]
 * @param {{ payment?: object }} [options]
 * @returns {{ ok: true, season: string, lignes: object[], total: number, goodsCount: number,
 *             objet: string, footerNote?: string } | { ok: false, status: number, message: string }}
 */
export function buildReceiptContent(adherent, registrations = [], now = new Date(), options = {}) {
  const cotisation = euros(num(adherent.cotisation));
  const passRegion = euros(num(adherent.montant_pass_region));

  const season =
    seasonLabelFromIso(adherent.date_fin_adhesion) ||
    seasonLabelFromIso(adherent.date_inscription) ||
    seasonLabelFromIso(now.toISOString());

  const dossier = pickSeasonRegistration(registrations, season);
  const goods = registrationGoodsLines(dossier);
  // État du paiement : celui fourni par l'appelant (envoi juste après le paiement, avant la mise
  // à jour du dossier), sinon celui persisté dans l'inscription retenue.
  const payment = options.payment ?? dossier?.payment;

  const lignes = [];
  if (cotisation > 0) {
    lignes.push({ designation: `Cotisation ${String(adherent.discipline || 'Club')} — saison ${season}`, qte: 1, pu: cotisation, total: cotisation });
  }
  if (passRegion > 0) lignes.push({ designation: 'Pass Région', qte: 1, pu: passRegion, total: passRegion });
  lignes.push(...goods);

  const total = euros(lignes.reduce((s, l) => s + l.total, 0));
  if (!(total > 0)) {
    return { ok: false, status: 404, message: "Aucune cotisation enregistrée pour cet adhérent : il n'y a pas de reçu à émettre." };
  }

  const inscription = frDate(adherent.date_inscription);
  const suffixe = inscription ? ` (inscription du ${inscription})` : '';
  const objet = goods.length
    ? `Inscription saison ${season} : cotisation et articles commandés${suffixe}`
    : `Cotisation à l'association - saison ${season}${suffixe}`;

  const footerNote = paymentNote(String(adherent.paiement ?? '').trim(), passRegion, total, payment);

  return { ok: true, season, lignes, total, goodsCount: goods.length, objet, footerNote };
}

/**
 * @returns {{ ok: true, doc: object, filename: string } | { ok: false, status: number, message: string }}
 */
export function buildCotisationReceipt(adherent, now = new Date(), registrations = [], options = {}) {
  const content = buildReceiptContent(adherent, registrations, now, options);
  if (!content.ok) return content;

  const idShort = String(adherent.id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'XXXXXXXX';
  const nom = String(adherent.nom ?? '').trim().toLocaleUpperCase('fr-FR');
  const prenom = String(adherent.prenom ?? '').trim();
  const nomComplet = `${prenom} ${nom}`.trim() || 'Adhérent';

  const numero = `REC-${content.season}-${idShort}`;
  const emisLe = now.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });

  const adresse = String(adherent.adresse ?? '').trim();
  const cpVille = [adherent.code_postal, adherent.ville].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  const lignesDestinataire = [
    ...(adresse ? wrapWords(adresse, 44, 3) : []),
    ...(cpVille ? [cpVille] : []),
    `Adhérent n°${idShort}`,
    `Saison ${content.season}`,
  ];

  const doc = {
    type: 'cotisation',
    numero,
    dateLabel: `Émis le ${emisLe}`,
    destinataire: { nom: nomComplet, lignes: lignesDestinataire },
    objet: content.objet,
    lignes: content.lignes,
    total: content.total,
    tvaLabel: 'Association loi 1901 — non assujettie à la TVA',
    footerNote: content.footerNote,
    pdfTitle: `Reçu de cotisation ${numero} — ${nomComplet}`,
  };

  const filename = `Recu-cotisation-${slug(nomComplet) || 'adherent'}-${content.season}.pdf`;
  return { ok: true, doc, filename };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/**
 * Génère le PDF du reçu. Asynchrone : le logo du club est un PNG récupéré via le binding
 * ASSETS puis décodé par le moteur (comme pour le dossier récapitulatif). Sans `env.ASSETS`
 * (ou asset illisible), l'en-tête retombe sur le médaillon-texte, sans jamais lever.
 *
 * @param {Record<string, any>} adherent
 * @param {object[]} registrations
 * @param {object | null} env
 * @param {{ now?: Date, payment?: object }} [options]
 * @returns {Promise<{ bytes: Uint8Array, filename: string, numero: string, total: number } | null>}
 *          null quand il n'y a rien à recevoir (total nul : inscription gratuite).
 */
export async function generateCotisationReceiptPdf(adherent, registrations, env, options = {}) {
  const receipt = buildCotisationReceipt(adherent, options.now || new Date(), registrations, { payment: options.payment });
  if (!receipt.ok) return null;
  const p = new PdfBuilder();
  const logoImage = await resolveLogoImage(p, env);
  const bytes = buildDocumentPdfBytes({ ...receipt.doc, logoImage }, p);
  return { bytes, filename: receipt.filename, numero: receipt.doc.numero, total: receipt.doc.total };
}
