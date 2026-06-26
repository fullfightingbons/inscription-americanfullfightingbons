/**
 * AFFBC — Frontend JavaScript de la page d'inscription publique
 * Fichier : /assets/inscription.js   (servi depuis Cloudflare Pages)
 *
 * Fonctionnement :
 *  1. Charge la config du club depuis /inscription-config
 *  2. Gère les 8 étapes avec validation côté client
 *  3. Sauvegarde le brouillon en localStorage
 *  4. Soumet le formulaire → crée la session HelloAsso (backend inscription.js)
 *  5. Redirige vers l'URL HelloAsso pour le paiement
 *  6. Sur retour (?helloasso=success&ref=xxx), vérifie le statut via status.js
 *     et affiche la confirmation uniquement si paid === true
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const DRAFT_KEY = 'affbc_inscription_draft_v4';
const CONFIG_URL = '/inscription-config';
const ADHERENT_ELIGIBILITY_URL = '/api/public/adherent-eligibility';
const SUBMIT_URL = '/api/public/inscription/'; // POST — backend inscription.js
const STATUS_URL = '/api/public/payment/helloasso/status'; // GET — backend status.js
const TARIFS_URL = '/api/public/tarifs';
const QS_QUESTIONS = [
  { key: 'familyCardiacDeath', label: 'Un membre de ta famille est-il décédé subitement d\'une cause cardiaque avant 50 ans ?' },
  { key: 'chestPain', label: 'As-tu ressenti une douleur dans la poitrine à l\'effort ?' },
  { key: 'wheezing', label: 'As-tu eu des sifflements ou difficultés à respirer pendant l\'effort ?' },
  { key: 'fainting', label: 'As-tu perdu connaissance ou t\'es-tu évanoui(e) ?' },
  { key: 'sportStop', label: 'Un médecin t\'a-t-il déjà conseillé d\'arrêter le sport ?' },
  { key: 'longTermTreatment', label: 'Prends-tu un traitement médical de longue durée ?' },
  { key: 'bonePain', label: 'As-tu des douleurs articulaires ou osseuses en dehors des traumatismes ?' },
  { key: 'practiceInterrupted', label: 'As-tu dû interrompre un entraînement pour raison médicale au cours des 12 derniers mois ?' },
  { key: 'medicalAdviceNeeded', label: 'As-tu besoin d\'un avis médical ou d\'une surveillance particulière pour pratiquer un sport ?' },
];
const STEP_LABELS = [
  'Bienvenue', 'Identité', 'Coordonnées', 'Pratique',
  'Santé', 'Commandes', 'Engagements', 'Paiement',
];

// ─── État ─────────────────────────────────────────────────────────────────────

let CONFIG = null;
let currentStep = 0;
const TOTAL_STEPS = 8;
let bureauEligibility = { checked: false, renewalVerified: false, eligibleForBureauRate: false, reason: 'missing_fields' };
let bureauEligibilityTimer = null;

// ─── Utilitaires DOM ──────────────────────────────────────────────────────────

function g(id) { return document.getElementById(id); }
function val(id) { const el = g(id); return el ? el.value.trim() : ''; }
function checked(id) { const el = g(id); return el ? el.checked : false; }
function show(id, v = true) { const el = g(id); if (el) el.hidden = !v; }
function hide(id) { show(id, false); }

function getInstallmentCount() {
  const raw = parseInt(val('installmentCount') || '1', 10);
  return raw === 2 || raw === 3 ? raw : 1;
}

function getInstallmentLabel(count = getInstallmentCount()) {
  return `HelloAsso en ${count} fois`;
}

function splitInstallments(totalCents, count) {
  const safeCount = count > 1 ? count : 1;
  const base = Math.floor(totalCents / safeCount);
  let remainder = totalCents - (base * safeCount);
  return Array.from({ length: safeCount }, () => {
    const value = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return value;
  });
}

function formatInstallmentSchedule(totalAmount) {
  const count = getInstallmentCount();
  if (count <= 1) return 'Paiement comptant via HelloAsso.';
  const totalCents = Math.round(Number(totalAmount || 0) * 100);
  const installments = splitInstallments(totalCents, count).map((amount) => `${(amount / 100).toFixed(2)} €`);
  return `Débit immédiat de ${installments[0]}, puis ${installments.slice(1).join(' puis ')} les mois suivants.`;
}

function setAlert(msg, type = 'error') {
  const el = g('signup-alert');
  if (!el) return;
  el.textContent = msg;
  el.className = 'alert' + (type === 'info' ? ' alert-info' : '');
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Brouillon localStorage ───────────────────────────────────────────────────

function saveDraft() {
  try {
    const data = collectAllFields();
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ step: currentStep, data, ts: Date.now() }));
    const badge = g('draft-badge');
    if (badge) badge.textContent = 'Brouillon sauvegardé à ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { /* ignore */ }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
  const badge = g('draft-badge');
  if (badge) badge.textContent = 'Brouillon non enregistré';
}

function applyDraft(data) {
  if (!data) return;
  const set = (id, v) => {
    const el = g(id);
    if (!el || v === undefined || v === null) return;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (el.type === 'file') { /* ne pas remplir les fichiers */ }
    else el.value = v;
  };
  set('lastName', data.lastName); set('firstName', data.firstName);
  set('birthDate', data.birthDate); set('birthPlace', data.birthPlace);
  set('address1', data.address1); set('address2', data.address2);
  set('postalCode', data.postalCode); set('city', data.city);
  set('phonePrimary', data.phonePrimary); set('phoneSecondary', data.phoneSecondary);
  set('email', data.email);
  set('emergencyLastName', data.emergencyLastName); set('emergencyFirstName', data.emergencyFirstName);
  set('emergencyPhonePrimary', data.emergencyPhonePrimary); set('emergencyPhoneSecondary', data.emergencyPhoneSecondary);
  set('typeInscription', data.typeInscription); set('practiceType', data.practiceType);
  set('formulaCode', data.formulaCode); set('passportEnabled', data.passportEnabled);
  set('passRegionEnabled', data.passRegionEnabled);
  if (data.passRegionAmount) set('passRegionAmount', data.passRegionAmount);
  if (data.passRegionCode) set('passRegionCode', data.passRegionCode);
  if (data.passRegionDossierNumber) set('passRegionDossierNumber', data.passRegionDossierNumber);
  // Mineurs
  if (data.legalLastName) set('legalLastName', data.legalLastName);
  if (data.legalFirstName) set('legalFirstName', data.legalFirstName);
  if (data.legalRole) set('legalRole', data.legalRole);
  if (data.legalCity) set('legalCity', data.legalCity);
  if (data.legalSignedAt) set('legalSignedAt', data.legalSignedAt);
  if (data.legalSignatureName) set('legalSignatureName', data.legalSignatureName);
  // QS
  if (data.qsSport) {
    for (const key of Object.keys(data.qsSport)) {
      const radios = document.querySelectorAll(`input[name="qs_${key}"]`);
      radios.forEach(r => { if (r.value === data.qsSport[key]) r.checked = true; });
    }
  }
  // Commandes
  if (data.tshirtQty !== undefined) {
    const el = document.querySelector('#clothing-order input[data-item="tshirt"]');
    if (el) el.value = data.tshirtQty;
  }
  if (data.pantalonQty !== undefined) {
    const el = document.querySelector('#clothing-order input[data-item="pantalon"]');
    if (el) el.value = data.pantalonQty;
  }
  if (data.tshirtSize) {
    const el = document.querySelector('#clothing-order select[data-size-item="tshirt"]');
    if (el) el.value = data.tshirtSize;
  }
  if (data.pantalonSize) {
    const el = document.querySelector('#clothing-order select[data-size-item="pantalon"]');
    if (el) el.value = data.pantalonSize;
  }
  if (Array.isArray(data.extraOrderItems)) {
    data.extraOrderItems.forEach((item) => {
      const qtyEl = document.querySelector(`#clothing-order input[data-order-item="${item.id}"]`);
      const sizeEl = document.querySelector(`#clothing-order select[data-order-size-item="${item.id}"]`);
      if (qtyEl && item.quantity !== undefined) qtyEl.value = item.quantity;
      if (sizeEl && item.size) sizeEl.value = item.size;
    });
  }
  // Engagements
  set('rulesAccepted', data.rulesAccepted); set('insuranceAcknowledged', data.insuranceAcknowledged);
  set('imageRights', data.imageRights);
  set('consentSignedAt', data.consentSignedAt); set('applicantSignatureName', data.applicantSignatureName);
  if (data.legalConsentSignatureName) set('legalConsentSignatureName', data.legalConsentSignatureName);
  // Paiement
  set('payerFirstName', data.payerFirstName);
  set('payerLastName', data.payerLastName);
  set('installmentCount', data.installmentCount);
  // Mise à jour des affichages conditionnels
  updateConditionals();
  updateSummary();
}

// ─── Collecte des champs ──────────────────────────────────────────────────────

function collectQs() {
  const qs = {};
  for (const q of QS_QUESTIONS) {
    const r = document.querySelector(`input[name="qs_${q.key}"]:checked`);
    qs[q.key] = r ? r.value : '';
  }
  return qs;
}

function collectClothing() {
  const tEl = document.querySelector('#clothing-order input[data-item="tshirt"]');
  const pEl = document.querySelector('#clothing-order input[data-item="pantalon"]');
  const tshirtSizeEl = document.querySelector('#clothing-order select[data-size-item="tshirt"]');
  const pantalonSizeEl = document.querySelector('#clothing-order select[data-size-item="pantalon"]');
  return {
    tshirtQty: Math.max(0, parseInt(tEl?.value || '0', 10)),
    pantalonQty: Math.max(0, parseInt(pEl?.value || '0', 10)),
    tshirtSize: tshirtSizeEl?.value || '',
    pantalonSize: pantalonSizeEl?.value || '',
  };
}

function getOrderProducts() {
  return Array.isArray(CONFIG?.orderProducts) ? CONFIG.orderProducts : [];
}

function getOrderProductById(productId) {
  return getOrderProducts().find((product) => String(product.id) === String(productId)) || null;
}

function getOrderProductSizeStock(productId, size) {
  const product = getOrderProductById(productId);
  if (!product || !size) return null;
  return Number(product.stockBySize?.[String(size).toUpperCase()] ?? 0);
}

function collectExtraOrderItems() {
  return getOrderProducts().map((product) => {
    const qtyEl = document.querySelector(`#clothing-order input[data-order-item="${product.id}"]`);
    const sizeEl = document.querySelector(`#clothing-order select[data-order-size-item="${product.id}"]`);
    return {
      id: String(product.id),
      quantity: Math.max(0, parseInt(qtyEl?.value || '0', 10)),
      size: sizeEl?.value || '',
    };
  });
}

function getClothingStockEntry(kind) {
  return CONFIG?.clothingStock?.[kind] || null;
}

function getClothingSizeOptions(kind) {
  const entry = getClothingStockEntry(kind);
  if (entry?.sizes?.length) return entry.sizes;
  return ['XS', 'S', 'M', 'L', 'XL'];
}

function getClothingSizeStock(kind, size) {
  const entry = getClothingStockEntry(kind);
  if (!entry || !size) return null;
  return Number(entry.stockBySize?.[String(size).toUpperCase()] ?? 0);
}

function updateClothingAvailability() {
  const clothing = collectClothing();
  ['tshirt', 'pantalon'].forEach((kind) => {
    const qtyEl = document.querySelector(`#clothing-order input[data-item="${kind}"]`);
    const size = clothing[`${kind}Size`];
    const available = getClothingSizeStock(kind, size);
    const hint = g(`${kind}-stock-hint`);
    if (qtyEl) {
      const max = available == null ? 5 : Math.max(0, available);
      qtyEl.max = String(max);
      if (Number(qtyEl.value || 0) > max) qtyEl.value = String(max);
    }
    if (hint) {
      if (!size) hint.textContent = 'Choisissez une taille pour voir le stock.';
      else if (available == null) hint.textContent = 'Stock boutique indisponible pour le moment.';
      else if (available <= 0) hint.textContent = 'Rupture sur cette taille.';
      else hint.textContent = `Stock disponible: ${available}`;
    }
  });
  getOrderProducts().forEach((product) => {
    const qtyEl = document.querySelector(`#clothing-order input[data-order-item="${product.id}"]`);
    const sizeEl = document.querySelector(`#clothing-order select[data-order-size-item="${product.id}"]`);
    const hint = g(`order-stock-hint-${product.id}`);
    const size = sizeEl?.value || '';
    const available = product.requiresSize ? getOrderProductSizeStock(product.id, size) : (product.stock == null ? null : Number(product.stock));
    if (qtyEl) {
      const max = available == null ? 10 : Math.max(0, available);
      qtyEl.max = String(max);
      if (Number(qtyEl.value || 0) > max) qtyEl.value = String(max);
    }
    if (hint) {
      if (product.requiresSize && !size) hint.textContent = 'Choisissez une taille pour voir le stock.';
      else if (available == null) hint.textContent = product.source === 'boutique' ? 'Stock boutique indisponible pour le moment.' : 'Stock non limité.';
      else if (available <= 0) hint.textContent = product.requiresSize ? 'Rupture sur cette taille.' : 'Rupture de stock.';
      else hint.textContent = `Stock disponible: ${available}`;
    }
  });
}

function collectAllFields() {
  return {
    lastName: val('lastName'), firstName: val('firstName'),
    birthDate: val('birthDate'), birthPlace: val('birthPlace'),
    address1: val('address1'), address2: val('address2'),
    postalCode: val('postalCode'), city: val('city'),
    phonePrimary: val('phonePrimary'), phoneSecondary: val('phoneSecondary'),
    email: val('email'),
    emergencyLastName: val('emergencyLastName'), emergencyFirstName: val('emergencyFirstName'),
    emergencyPhonePrimary: val('emergencyPhonePrimary'), emergencyPhoneSecondary: val('emergencyPhoneSecondary'),
    typeInscription: val('typeInscription'), practiceType: val('practiceType'),
    formulaCode: val('formulaCode'), passportEnabled: val('passportEnabled'),
    passRegionEnabled: val('passRegionEnabled'), passRegionAmount: val('passRegionAmount'),
    passRegionCode: val('passRegionCode'),
    passRegionDossierNumber: val('passRegionDossierNumber'),
    legalLastName: val('legalLastName'), legalFirstName: val('legalFirstName'),
    legalRole: val('legalRole'), legalCity: val('legalCity'),
    legalSignedAt: val('legalSignedAt'), legalSignatureName: val('legalSignatureName'),
    qsSport: collectQs(),
    ...collectClothing(),
    extraOrderItems: collectExtraOrderItems(),
    rulesAccepted: checked('rulesAccepted'), insuranceAcknowledged: checked('insuranceAcknowledged'),
    imageRights: val('imageRights'),
    consentSignedAt: val('consentSignedAt'), applicantSignatureName: val('applicantSignatureName'),
    legalConsentSignatureName: val('legalConsentSignatureName'),
    payerFirstName: val('payerFirstName'),
    payerLastName: val('payerLastName'),
    installmentCount: getInstallmentCount(),
  };
}

// ─── Calcul du total ──────────────────────────────────────────────────────────

function isMinor(birthDate) {
  if (!birthDate) return false;
  const now = new Date();
  const birth = new Date(birthDate + 'T00:00:00');
  const age = now.getFullYear() - birth.getFullYear() -
    (now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate()) ? 1 : 0);
  return age < 18;
}

function calculateTotals() {
  if (!CONFIG) return null;
  const p = CONFIG.pricing;
  const formula = val('formulaCode');
  const typeInscription = val('typeInscription');
  const passRegionEnabled = val('passRegionEnabled') === 'true';
  const passportEnabled = val('passportEnabled') === 'true';
  const clothing = collectClothing();

  const baseMap = { base: p.base, family: p.family, pro: p.pro, cse_thales: p.cseThales, bureau: p.bureau || 0 };
  const baseCotisation = baseMap[formula];
  if (!Number.isFinite(baseCotisation)) return null;

  const passRegionAmount = passRegionEnabled ? Number(val('passRegionAmount') || 0) : 0;
  const cotisation = Math.max(0, baseCotisation - passRegionAmount);

  const tshirtQty = Math.max(clothing.tshirtQty, typeInscription === 'nouvelle' ? 1 : 0);
  const pantalonQty = Math.max(clothing.pantalonQty, typeInscription === 'nouvelle' ? 1 : 0);
  const passport = passportEnabled ? p.passport : 0;
  // Le kit tenue n'est facturé que pour les nouvelles adhésions.
  const newMemberKit = typeInscription === 'nouvelle' ? (p.newMemberKit || 0) : 0;
  const clothingTotal = tshirtQty * p.tshirt + pantalonQty * p.pantalon;
  const requestedItems = collectExtraOrderItems();
  const orderItems = getOrderProducts().map((product) => {
    const requested = requestedItems.find((item) => String(item.id) === String(product.id)) || {};
    const quantity = Math.max(
      Number(requested.quantity || 0),
      typeInscription === 'nouvelle' ? Number(product.defaultQtyNew || 0) : 0,
    );
    const unitPrice = Number(product.price || 0);
    return {
      id: String(product.id),
      source: String(product.source || 'gestion'),
      boutiqueProductId: product.boutiqueProductId ? Number(product.boutiqueProductId) : null,
      name: String(product.name || ''),
      description: String(product.description || ''),
      requiresSize: Boolean(product.requiresSize),
      quantity,
      size: String(requested.size || ''),
      unitPrice,
      total: quantity * unitPrice,
    };
  }).filter((item) => item.quantity > 0);
  const extraProductsTotal = orderItems.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const total = cotisation + passport + clothingTotal + newMemberKit + extraProductsTotal;

  return {
    cotisation,
    passRegionAmount,
    passport,
    clothingTotal,
    tshirtQty,
    pantalonQty,
    newMemberKit,
    extraProductsTotal,
    orderItems,
    total,
  };
}

function getBureauOptionLabel() {
  const amount = Number(CONFIG?.pricing?.bureau || 0).toFixed(2);
  return `Membres du Bureau (${amount} €)`;
}

function syncBureauFormulaOption() {
  const formulaSelect = g('formulaCode');
  const note = g('bureau-member-note');
  if (!formulaSelect) return;

  let bureauOption = formulaSelect.querySelector('option[value="bureau"]');
  if (bureauEligibility.eligibleForBureauRate) {
    if (!bureauOption) {
      bureauOption = document.createElement('option');
      bureauOption.value = 'bureau';
      formulaSelect.appendChild(bureauOption);
    }
    bureauOption.textContent = getBureauOptionLabel();
  } else if (bureauOption) {
    if (formulaSelect.value === 'bureau') {
      formulaSelect.value = '';
    }
    bureauOption.remove();
  }

  if (note) {
    if (bureauEligibility.eligibleForBureauRate) {
      note.textContent = 'Le renouvellement a été reconnu avec la discipline "membre du bureau" : l’option tarifaire à 0 € est disponible.';
    } else if (val('typeInscription') !== 'renouvellement') {
      note.textContent = 'L\'option Membres du Bureau apparaît automatiquement pour les renouvellements reconnus avec cette discipline dans le logiciel de gestion.';
    } else if (!bureauEligibility.checked) {
      note.textContent = 'Renseignez nom, prénom, date de naissance et email du dossier existant pour vérifier l\'éligibilité Membres du Bureau.';
    } else if (bureauEligibility.reason === 'discipline_missing') {
      note.textContent = 'Renouvellement reconnu, mais la discipline "membre du bureau" n\'est pas présente dans la fiche adhérent.';
    } else {
      note.textContent = 'L\'option Membres du Bureau n\'est affichée que si le renouvellement correspond à une fiche adhérent existante avec cette discipline.';
    }
  }
}

function getEligibilityParams() {
  return new URLSearchParams({
    typeInscription: val('typeInscription'),
    lastName: val('lastName'),
    firstName: val('firstName'),
    birthDate: val('birthDate'),
    email: val('email'),
  });
}

async function refreshBureauEligibility() {
  const typeInscription = val('typeInscription');
  if (typeInscription !== 'renouvellement') {
    bureauEligibility = { checked: true, renewalVerified: false, eligibleForBureauRate: false, reason: 'not_renewal' };
    syncBureauFormulaOption();
    return;
  }

  if (!val('lastName') || !val('firstName') || !val('birthDate') || !val('email')) {
    bureauEligibility = { checked: false, renewalVerified: false, eligibleForBureauRate: false, reason: 'missing_fields' };
    syncBureauFormulaOption();
    return;
  }

  try {
    const res = await fetch(`${ADHERENT_ELIGIBILITY_URL}?${getEligibilityParams().toString()}`, { cache: 'no-store' });
    const payload = await res.json().catch(() => null);
    bureauEligibility = payload?.data || { checked: true, renewalVerified: false, eligibleForBureauRate: false, reason: 'fetch_failed' };
  } catch (e) {
    bureauEligibility = { checked: true, renewalVerified: false, eligibleForBureauRate: false, reason: 'fetch_failed' };
  }

  syncBureauFormulaOption();
  updateSummary();
}

function scheduleBureauEligibilityRefresh() {
  if (bureauEligibilityTimer) window.clearTimeout(bureauEligibilityTimer);
  bureauEligibilityTimer = window.setTimeout(() => {
    refreshBureauEligibility();
  }, 250);
}

// ─── Affichages conditionnels ─────────────────────────────────────────────────

function updateConditionals() {
  const minor = isMinor(val('birthDate'));
  show('minor-block', minor);

  const passRegion = val('passRegionEnabled') === 'true';
  document.querySelectorAll('[data-show-when="passRegion"]').forEach(el => el.hidden = !passRegion);
  document.querySelectorAll('[data-show-when="noPassRegion"]').forEach(el => el.hidden = passRegion);

  const formula = val('formulaCode');
  const needProof = formula === 'pro' || formula === 'cse_thales';
  document.querySelectorAll('[data-show-when="proofNeeded"]').forEach(el => el.hidden = !needProof);

  const familyNote = document.getElementById('family-rate-note');
  if (familyNote) familyNote.hidden = formula !== 'family';

  // Certificat médical requis si mineur ou QS positif
  const qsSport = collectQs();
  const qsPositive = Object.values(qsSport).some(v => v === 'yes');
  const certRequired = minor || qsPositive;
  show('medical-upload-block', certRequired);
}

// ─── Récapitulatif (sidebar + paiement) ──────────────────────────────────────

function updateSummary() {
  const totals = calculateTotals();
  const qk = g('quick-summary');
  const fs = g('final-summary');
  const pi = g('online-payment-info');
  const clothing = collectClothing();
  const tshirtLabel = `${totals?.tshirtQty || 0} t-shirt${clothing.tshirtSize ? ` (${clothing.tshirtSize})` : ''}`;
  const pantalonLabel = `${totals?.pantalonQty || 0} pantalon${clothing.pantalonSize ? ` (${clothing.pantalonSize})` : ''}`;
  const extraItemsSummary = (totals?.orderItems || []).map((item) => {
    const sizeSuffix = item.size ? ` (${item.size})` : '';
    return `<div class="summary-line"><strong>${item.name}</strong><span>${item.total.toFixed(2)} € · ${item.quantity}${sizeSuffix}</span></div>`;
  }).join('');
  const extraItemsPayment = (totals?.orderItems || []).map((item) => {
    const sizeSuffix = item.size ? ` (${item.size})` : '';
    return `<div class="bank-line"><strong>${item.name}${sizeSuffix}</strong><code>${item.total.toFixed(2)} €</code></div>`;
  }).join('');

  if (!totals) {
    if (qk) qk.innerHTML = '<div class="summary-line"><span>Complétez les étapes pour voir le récapitulatif.</span></div>';
    if (fs) fs.innerHTML = '';
    return;
  }

  // Sidebar
  if (qk) {
    const nom = [val('lastName'), val('firstName')].filter(Boolean).join(' ');
    qk.innerHTML = `
      ${nom ? `<div class="summary-line"><strong>Adhérent</strong><span>${nom}</span></div>` : ''}
      <div class="summary-line"><strong>Cotisation</strong><span>${totals.cotisation.toFixed(2)} €</span></div>
      ${totals.passRegionAmount > 0 ? `<div class="summary-line"><strong>Remise Pass Région</strong><span>− ${totals.passRegionAmount.toFixed(2)} €</span></div>` : ''}
      ${totals.passport > 0 ? `<div class="summary-line"><strong>Passeport sportif</strong><span>${totals.passport.toFixed(2)} €</span></div>` : ''}
      ${totals.clothingTotal > 0 ? `<div class="summary-line"><strong>Tenue club</strong><span>${totals.clothingTotal.toFixed(2)} € · ${tshirtLabel} · ${pantalonLabel}</span></div>` : ''}
      ${extraItemsSummary}
      <div class="summary-line"><strong>Total</strong><span style="font-size:18px;color:var(--red-dark)"><strong>${totals.total.toFixed(2)} €</strong></span></div>
      <div class="summary-line"><strong>Paiement</strong><span>${getInstallmentLabel()}</span></div>
    `;
  }

  // Étape paiement
  if (fs) {
    fs.innerHTML = `
      <div class="bank-line"><strong>Cotisation</strong><code>${totals.cotisation.toFixed(2)} €</code></div>
      ${totals.passRegionAmount > 0 ? `<div class="bank-line"><strong>Remise Pass Région</strong><code>− ${totals.passRegionAmount.toFixed(2)} €</code></div>` : ''}
      ${totals.passport > 0 ? `<div class="bank-line"><strong>Passeport sportif</strong><code>${totals.passport.toFixed(2)} €</code></div>` : ''}
      ${totals.clothingTotal > 0 ? `<div class="bank-line"><strong>Tenue club (${tshirtLabel} · ${pantalonLabel})</strong><code>${totals.clothingTotal.toFixed(2)} €</code></div>` : ''}
      ${extraItemsPayment}
      <div class="bank-line" style="border-color:rgba(162,53,33,.35)"><strong>Total à régler</strong><code style="font-size:18px">${totals.total.toFixed(2)} €</code></div>
      <div class="bank-line"><strong>Paiement</strong><code>${getInstallmentLabel()}</code></div>
      <div class="bank-line"><strong>Échéancier</strong><code>${formatInstallmentSchedule(totals.total)}</code></div>
    `;
  }

  const installmentHelp = g('installment-help');
  if (installmentHelp) {
    installmentHelp.textContent = formatInstallmentSchedule(totals.total);
  }

  updateClothingSubtotals(totals);
  updateClothingAvailability();
  if (pi) show('online-payment-info', true);
}

// ─── Étapes ───────────────────────────────────────────────────────────────────

function renderStepList() {
  const el = g('step-list');
  if (!el) return;
  el.innerHTML = STEP_LABELS.map((label, i) => {
    const cls = i === currentStep ? 'step-item active' : i < currentStep ? 'step-item done' : 'step-item';
    return `<button type="button" class="${cls}" data-step-nav="${i}">
      <div class="step-eyebrow">${String(i + 1).padStart(2, '0')}</div>
      <strong>${label}</strong>
    </button>`;
  }).join('');
}

function renderProgress() {
  const pt = g('progress-text');
  const pf = g('progress-fill');
  if (pt) pt.textContent = `Étape ${currentStep + 1} sur ${TOTAL_STEPS}`;
  if (pf) pf.style.width = `${((currentStep + 1) / TOTAL_STEPS) * 100}%`;
}

function showStep(index) {
  document.querySelectorAll('.step-panel').forEach((panel, i) => {
    panel.classList.toggle('active', i === index);
  });
  currentStep = index;
  renderStepList();
  renderProgress();
  updateConditionals();
  updateSummary();
  setAlert('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function canNavigateToStep(targetStep) {
  if (targetStep <= currentStep) return null;
  for (let step = currentStep; step < targetStep; step += 1) {
    const err = validateStep(step);
    if (err) return err;
  }
  return null;
}

// ─── Validation par étape ─────────────────────────────────────────────────────

function validateStep(step) {
  setAlert('');
  switch (step) {
    case 1: { // Identité
      if (!val('lastName')) return 'Le nom est obligatoire.';
      if (!val('firstName')) return 'Le prénom est obligatoire.';
      if (!val('birthDate')) return 'La date de naissance est obligatoire.';
      if (!val('birthPlace')) return 'Le lieu de naissance est obligatoire.';
      const photo = g('photoIdentity');
      if (!photo || !photo.files?.length) return 'La photo d\'identité est obligatoire.';
      return null;
    }
    case 2: { // Coordonnées
      if (!val('address1')) return 'L\'adresse est obligatoire.';
      if (!val('address2')) return 'Le complément d\'adresse est obligatoire (indiquez Néant si aucun).';
      if (!val('postalCode')) return 'Le code postal est obligatoire.';
      if (!val('city')) return 'La ville est obligatoire.';
      if (!val('phonePrimary')) return 'Le téléphone principal est obligatoire.';
      if (!val('email')) return 'L\'email est obligatoire.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('email'))) return 'L\'email semble invalide.';
      if (!val('emergencyLastName')) return 'Le nom du contact d\'urgence est obligatoire.';
      if (!val('emergencyFirstName')) return 'Le prénom du contact d\'urgence est obligatoire.';
      if (!val('emergencyPhonePrimary')) return 'Le téléphone principal du contact d\'urgence est obligatoire.';
      return null;
    }
    case 3: { // Pratique
      if (!val('typeInscription')) return 'Le type d\'inscription est obligatoire.';
      if (!val('practiceType')) return 'Le type de pratique est obligatoire.';
      if (!val('formulaCode')) return 'La formule tarifaire est obligatoire.';
      if (!val('passportEnabled')) return 'Veuillez indiquer si vous souhaitez un passeport sportif.';
      if (!val('passRegionEnabled')) return 'Veuillez indiquer si vous utilisez le Pass Région.';
      if (val('passRegionEnabled') === 'true') {
        if (!val('passRegionAmount')) return 'Veuillez sélectionner le montant du Pass Région.';
        if (!/^\d{4}$/.test(val('passRegionCode'))) return 'Le code Pass Région doit contenir exactement 4 chiffres.';
        if (!val('passRegionDossierNumber')) return 'Le numéro de dossier Pass Région est obligatoire.';
        const doc = g('passRegionDocument');
        if (!doc?.files?.length) return 'Le justificatif Pass Région est obligatoire.';
      }
      const formula = val('formulaCode');
      if (formula === 'pro' || formula === 'cse_thales') {
        const proof = g('proProofDocument');
        if (!proof?.files?.length) return 'Le justificatif de tarif réduit est obligatoire.';
      }
      if (isMinor(val('birthDate'))) {
        if (!val('legalLastName')) return 'Le nom du représentant légal est obligatoire.';
        if (!val('legalFirstName')) return 'Le prénom du représentant légal est obligatoire.';
        if (!val('legalRole')) return 'La qualité du représentant légal est obligatoire.';
        if (!val('legalCity')) return 'La ville de signature est obligatoire.';
        if (!val('legalSignedAt')) return 'La date de signature est obligatoire.';
        if (!val('legalSignatureName')) return 'La signature du représentant légal est obligatoire.';
      }
      return null;
    }
    case 4: { // Santé
      const qs = collectQs();
      for (const q of QS_QUESTIONS) {
        if (qs[q.key] !== 'yes' && qs[q.key] !== 'no') {
          return 'Veuillez répondre à toutes les questions du questionnaire de santé.';
        }
      }
      const minor = isMinor(val('birthDate'));
      const qsPositive = Object.values(qs).some(v => v === 'yes');
      if (minor || qsPositive) {
        const cert = g('medicalCertificate');
        if (!cert?.files?.length) return 'Le certificat médical est obligatoire pour votre profil.';
      }
      return null;
    }
    case 5: { // Commandes
      const clothing = collectClothing();
      if (clothing.tshirtQty > 0 && !clothing.tshirtSize) return 'Veuillez sélectionner une taille de t-shirt.';
      if (clothing.pantalonQty > 0 && !clothing.pantalonSize) return 'Veuillez sélectionner une taille de pantalon.';
      const tshirtAvailable = getClothingSizeStock('tshirt', clothing.tshirtSize);
      const pantalonAvailable = getClothingSizeStock('pantalon', clothing.pantalonSize);
      if (tshirtAvailable != null && clothing.tshirtQty > tshirtAvailable) return `Stock insuffisant pour le t-shirt en taille ${clothing.tshirtSize}.`;
      if (pantalonAvailable != null && clothing.pantalonQty > pantalonAvailable) return `Stock insuffisant pour le pantalon en taille ${clothing.pantalonSize}.`;
      for (const item of collectExtraOrderItems()) {
        const product = getOrderProductById(item.id);
        if (!product || item.quantity <= 0) continue;
        if (product.requiresSize && !item.size) return `Veuillez sélectionner une taille pour ${product.name}.`;
        const available = product.requiresSize
          ? getOrderProductSizeStock(item.id, item.size)
          : (product.stock == null ? null : Number(product.stock));
        if (available != null && item.quantity > available) {
          return product.requiresSize
            ? `Stock insuffisant pour ${product.name} en taille ${item.size}.`
            : `Stock insuffisant pour ${product.name}.`;
        }
      }
      return null;
    }
    case 6: { // Engagements
      if (!checked('rulesAccepted')) return 'Vous devez accepter le règlement intérieur.';
      if (!checked('insuranceAcknowledged')) return 'Vous devez reconnaître avoir pris connaissance des modalités d\'assurance.';
      if (!val('imageRights')) return 'Veuillez faire votre choix concernant le droit à l\'image.';
      if (!val('consentSignedAt')) return 'La date de signature est obligatoire.';
      if (isMinor(val('birthDate'))) {
        if (!val('legalConsentSignatureName')) return 'La signature du représentant légal (droit à l\'image) est obligatoire pour un mineur.';
      } else {
        if (!val('applicantSignatureName')) return 'La signature du pratiquant est obligatoire.';
      }
      return null;
    }
    case 7:
      if (!val('payerFirstName')) return 'Le prénom du payeur est obligatoire.';
      if (!val('payerLastName')) return 'Le nom du payeur est obligatoire.';
      if (![1, 2, 3].includes(getInstallmentCount())) return 'Le nombre d’échéances est invalide.';
      return null;
    default:
      return null;
  }
}

// ─── QS dynamique ─────────────────────────────────────────────────────────────

function renderQsGrid() {
  const grid = g('qs-grid');
  if (!grid) return;
  grid.innerHTML = QS_QUESTIONS.map(q => `
    <div class="qs-row">
      <p>${q.label}</p>
      <div class="radio-set">
        <label class="radio-pill">
          <input type="radio" name="qs_${q.key}" value="yes">
          <span>Oui</span>
        </label>
        <label class="radio-pill">
          <input type="radio" name="qs_${q.key}" value="no">
          <span>Non</span>
        </label>
      </div>
    </div>
  `).join('');
  // Écouter les changements pour mettre à jour l'affichage du certif
  grid.addEventListener('change', () => { updateConditionals(); updateSummary(); });
}

// ─── Commandes tenue ──────────────────────────────────────────────────────────

function renderClothingOrder() {
  const el = g('clothing-order');
  if (!el || !CONFIG) return;
  const p = CONFIG.pricing;
  const typeInscription = val('typeInscription');
  const tshirtOptions = getClothingSizeOptions('tshirt').map(size => {
    const stock = getClothingSizeStock('tshirt', size);
    const disabled = stock != null && stock <= 0;
    const suffix = stock == null ? '' : ` · ${stock} dispo`;
    return `<option value="${size}" ${disabled ? 'disabled' : ''}>${size}${suffix}</option>`;
  }).join('');
  const pantalonOptions = getClothingSizeOptions('pantalon').map(size => {
    const stock = getClothingSizeStock('pantalon', size);
    const disabled = stock != null && stock <= 0;
    const suffix = stock == null ? '' : ` · ${stock} dispo`;
    return `<option value="${size}" ${disabled ? 'disabled' : ''}>${size}${suffix}</option>`;
  }).join('');
  const tshirtTotalStock = getClothingStockEntry('tshirt')?.stock;
  const pantalonTotalStock = getClothingStockEntry('pantalon')?.stock;
  const extraRows = getOrderProducts().map((product) => {
    const sizeOptions = (Array.isArray(product.sizes) ? product.sizes : []).map((size) => {
      const stock = getOrderProductSizeStock(product.id, size);
      const disabled = stock != null && stock <= 0;
      const suffix = stock == null ? '' : ` · ${stock} dispo`;
      return `<option value="${size}" ${disabled ? 'disabled' : ''}>${size}${suffix}</option>`;
    }).join('');
    const stockHint = product.source === 'boutique'
      ? (product.requiresSize
          ? 'Choisissez une taille pour voir le stock.'
          : (product.stock == null ? 'Stock boutique indisponible.' : `Stock total boutique: ${product.stock}`))
      : 'Produit ajouté depuis le logiciel de gestion.';
    const defaultQty = typeInscription === 'nouvelle' ? Number(product.defaultQtyNew || 0) : 0;
    return `
    <div class="order-row">
      <div>
        <strong>${product.name}</strong>
        <small>${product.description || (product.source === 'boutique' ? 'Produit synchronisé depuis la boutique.' : 'Produit ajouté par le club.')}</small>
        <small id="order-stock-hint-${product.id}">${stockHint}</small>
      </div>
      <div class="order-input" data-label="P.U."><span>${Number(product.price || 0).toFixed(2)} €</span></div>
      <div class="order-input" data-label="Taille">
        ${product.requiresSize ? `
        <select data-order-size-item="${product.id}">
          <option value="">Taille</option>
          ${sizeOptions}
        </select>
        ` : '<span style="color:var(--muted)">—</span>'}
      </div>
      <div class="order-input" data-label="Qté">
        <input type="number" min="0" max="10" value="${defaultQty}" data-order-item="${product.id}" style="width:60px" oninput="updateSummary()">
      </div>
      <div class="order-input" data-label="Sous-total" data-order-subtotal="${product.id}">—</div>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="order-head">
      <span>Article</span><span>P.U.</span><span>Taille</span><span>Qté</span><span>Sous-total</span>
    </div>
    <div class="order-row">
      <div>
        <strong>T-shirt club AFFBC</strong>
        <small>Tenue officielle noire validée</small>
        <small id="tshirt-stock-hint">${tshirtTotalStock == null ? 'Stock boutique indisponible.' : `Stock total boutique: ${tshirtTotalStock}`}</small>
      </div>
      <div class="order-input" data-label="P.U."><span>${p.tshirt.toFixed(2)} €</span></div>
      <div class="order-input" data-label="Taille">
        <select data-size-item="tshirt">
          <option value="">Taille</option>
          ${tshirtOptions}
        </select>
      </div>
      <div class="order-input" data-label="Qté">
        <input type="number" min="0" max="5" value="${typeInscription === 'nouvelle' ? 1 : 0}"
               data-item="tshirt" style="width:60px"
               oninput="updateSummary()">
      </div>
      <div class="order-input" data-label="Sous-total" id="tshirt-subtotal">—</div>
    </div>
    <div class="order-row">
      <div>
        <strong>Pantalon club AFFBC</strong>
        <small>Pantalon de boxe noir</small>
        <small id="pantalon-stock-hint">${pantalonTotalStock == null ? 'Stock boutique indisponible.' : `Stock total boutique: ${pantalonTotalStock}`}</small>
      </div>
      <div class="order-input" data-label="P.U."><span>${p.pantalon.toFixed(2)} €</span></div>
      <div class="order-input" data-label="Taille">
        <select data-size-item="pantalon">
          <option value="">Taille</option>
          ${pantalonOptions}
        </select>
      </div>
      <div class="order-input" data-label="Qté">
        <input type="number" min="0" max="5" value="${typeInscription === 'nouvelle' ? 1 : 0}"
               data-item="pantalon" style="width:60px"
               oninput="updateSummary()">
      </div>
      <div class="order-input" data-label="Sous-total" id="pantalon-subtotal">—</div>
    </div>
    ${extraRows}
  `;
  const tshirtSizeEl = el.querySelector('select[data-size-item="tshirt"]');
  const pantalonSizeEl = el.querySelector('select[data-size-item="pantalon"]');
  if (tshirtSizeEl) tshirtSizeEl.addEventListener('change', updateSummary);
  if (pantalonSizeEl) pantalonSizeEl.addEventListener('change', updateSummary);
  const tshirtQtyEl = el.querySelector('input[data-item="tshirt"]');
  const pantalonQtyEl = el.querySelector('input[data-item="pantalon"]');
  if (tshirtQtyEl) tshirtQtyEl.addEventListener('input', updateClothingAvailability);
  if (pantalonQtyEl) pantalonQtyEl.addEventListener('input', updateClothingAvailability);
  el.querySelectorAll('input[data-order-item]').forEach((input) => input.addEventListener('input', updateClothingAvailability));
  el.querySelectorAll('select[data-order-size-item]').forEach((select) => select.addEventListener('change', updateSummary));
  updateClothingAvailability();
  updateClothingSubtotals();
}

function updateClothingSubtotals(totals = calculateTotals()) {
  if (!totals || !CONFIG) return;
  const tshirtSubtotal = g('tshirt-subtotal');
  const pantalonSubtotal = g('pantalon-subtotal');
  if (tshirtSubtotal) tshirtSubtotal.textContent = `${(totals.tshirtQty * CONFIG.pricing.tshirt).toFixed(2)} €`;
  if (pantalonSubtotal) pantalonSubtotal.textContent = `${(totals.pantalonQty * CONFIG.pricing.pantalon).toFixed(2)} €`;
  (totals.orderItems || []).forEach((item) => {
    const el = document.querySelector(`[data-order-subtotal="${item.id}"]`);
    if (el) el.textContent = `${Number(item.total || 0).toFixed(2)} €`;
  });
  getOrderProducts()
    .filter((product) => !(totals.orderItems || []).some((item) => String(item.id) === String(product.id)))
    .forEach((product) => {
      const el = document.querySelector(`[data-order-subtotal="${product.id}"]`);
      if (el) el.textContent = '0.00 €';
    });
}

// ─── Config du club ───────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    CONFIG = payload.data;
    applyBranding();
  } catch (e) {
    // Config par défaut si l'API est indisponible
    CONFIG = {
      clubName: 'AMERICAN FULL FIGHTING BONS EN CHABLAIS',
      clubEmail: 'fullfightingbons@gmail.com',
      clubPhone: '06 99 95 81 77',
      clubLogo: '',
      dojoAddress: 'Centre Sportif Intercommunal des Voirons, 146 rue du Châtelard, 74890 Bons en Chablais',
      schedule: ['Lundi 19h–20h30', 'Mercredi 20h30–22h30', 'Vendredi 20h30–22h30'],
      pricing: { base: 250, family: 200, pro: 125, cseThales: 39, bureau: 0, newMemberKit: 40, passport: 25, passRegionMale: 30, passRegionFemale: 60, tshirt: 25, pantalon: 15 },
      bank: {},
      paymentProviders: { helloAssoEnabled: true },
      clothingStock: { tshirt: null, pantalon: null },
      orderProducts: [],
    };
    applyBranding();
  }
}

function applyBranding() {
  if (!CONFIG) return;
  const logo = g('club-logo');
  if (logo && CONFIG.clubLogo) logo.src = CONFIG.clubLogo;
  const name = g('club-name');
  if (name && CONFIG.clubName) name.textContent = CONFIG.clubName;
  const contact = g('club-contact');
  if (contact) contact.textContent = [CONFIG.clubPhone, CONFIG.clubEmail].filter(Boolean).join(' · ');
  const schedule = g('hero-schedule');
  if (schedule && CONFIG.schedule?.length) {
    schedule.innerHTML = CONFIG.schedule.map(s => `<li>${s}</li>`).join('');
  }
  const dojo = g('dojo-address');
  if (dojo && CONFIG.dojoAddress) dojo.textContent = CONFIG.dojoAddress;
  const stats = g('hero-stats');
  if (stats) {
    stats.innerHTML = `
      <div class="stat-card"><strong>${CONFIG.pricing.base} €</strong><span>Tarif de base</span></div>
      <div class="stat-card"><strong>${CONFIG.pricing.family} €</strong><span>Tarif famille</span><span style="font-size:11px;color:var(--muted);margin-top:4px;display:block">2 membres min. de la même famille</span></div>
      <div class="stat-card"><strong>${CONFIG.pricing.pro} €</strong><span>Tarif pro</span></div>
    `;
  }
  syncBureauFormulaOption();
}

// ─── Construction du payload JSON final ──────────────────────────────────────

function buildPayload() {
  const qs = collectQs();
  const minor = isMinor(val('birthDate'));
  const clothing = collectClothing();
  const extraOrderItems = collectExtraOrderItems();
  const typeInscription = val('typeInscription');
  const tshirtQty = Math.max(clothing.tshirtQty, typeInscription === 'nouvelle' ? 1 : 0);
  const pantalonQty = Math.max(clothing.pantalonQty, typeInscription === 'nouvelle' ? 1 : 0);

  return {
    identity: {
      lastName: val('lastName'),
      firstName: val('firstName'),
      birthDate: val('birthDate'),
      birthPlace: val('birthPlace'),
    },
    contact: {
      address1: val('address1'),
      address2: val('address2'),
      postalCode: val('postalCode'),
      city: val('city'),
      phonePrimary: val('phonePrimary'),
      phoneSecondary: val('phoneSecondary'),
      email: val('email'),
    },
    emergency: {
      lastName: val('emergencyLastName'),
      firstName: val('emergencyFirstName'),
      phonePrimary: val('emergencyPhonePrimary'),
      phoneSecondary: val('emergencyPhoneSecondary'),
    },
    legalRepresentative: minor ? {
      lastName: val('legalLastName'),
      firstName: val('legalFirstName'),
      role: val('legalRole'),
      city: val('legalCity'),
      signedAt: val('legalSignedAt'),
      signatureName: val('legalSignatureName'),
    } : {},
    practice: {
      typeInscription: val('typeInscription'),
      practiceType: val('practiceType'),
      formulaCode: val('formulaCode'),
      passportEnabled: val('passportEnabled') === 'true',
      passRegionEnabled: val('passRegionEnabled') === 'true',
      passRegionAmount: val('passRegionEnabled') === 'true' ? Number(val('passRegionAmount') || 0) : 0,
      passRegionCode: val('passRegionEnabled') === 'true' ? val('passRegionCode') : '',
      passRegionDossierNumber: val('passRegionEnabled') === 'true' ? val('passRegionDossierNumber') : '',
    },
    health: {
      qsSport: qs,
    },
    clothingOrder: {
      tshirtQty,
      pantalonQty,
      tshirtSize: clothing.tshirtSize,
      pantalonSize: clothing.pantalonSize,
    },
    extraOrderItems,
    consents: {
      rulesAccepted: checked('rulesAccepted'),
      insuranceAcknowledged: checked('insuranceAcknowledged'),
      imageRights: val('imageRights'),
      applicantSignatureName: val('applicantSignatureName'),
      legalConsentSignatureName: minor ? val('legalConsentSignatureName') : '',
      signedAt: val('consentSignedAt'),
    },
    payment: {
      method: 'helloasso',
      payerFirstName: val('payerFirstName'),
      payerLastName: val('payerLastName'),
      installmentCount: getInstallmentCount(),
    },
    pricing: CONFIG?.pricing || {},
  };
}

// ─── Soumission du formulaire ─────────────────────────────────────────────────

async function submitForm(event) {
  event.preventDefault();

  const error = validateStep(7);
  if (error) { setAlert(error); return; }

  const btn = g('submit-button');
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi en cours…'; }
  setAlert('');

  try {
    const payload = buildPayload();
    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));

    // Fichiers
    const photoFile = g('photoIdentity')?.files?.[0];
    if (photoFile) formData.append('photoIdentity', photoFile);

    const certFile = g('medicalCertificate')?.files?.[0];
    if (certFile) formData.append('medicalCertificate', certFile);

    const passRegionFile = g('passRegionDocument')?.files?.[0];
    if (passRegionFile) formData.append('passRegionDocument', passRegionFile);

    const proofFile = g('proProofDocument')?.files?.[0];
    if (proofFile) formData.append('proProofDocument', proofFile);

    // Honeypot
    formData.append('website', '');

    const res = await fetch(SUBMIT_URL, { method: 'POST', body: formData });
    const data = await res.json().catch(() => null);

    if (!res.ok || data?.error) {
      throw new Error(data?.error || `Erreur serveur (${res.status})`);
    }

    const { helloAssoUrl, registrationId } = data.data || {};

    if (!helloAssoUrl) {
      throw new Error('Lien de paiement HelloAsso non reçu. Veuillez réessayer ou contacter le club.');
    }

    // Enregistrer l'ID pour la vérification au retour
    try { sessionStorage.setItem('affbc_reg_id', registrationId); } catch (e) { /* ignore */ }
    clearDraft();

    // Redirection vers HelloAsso
    window.location.href = helloAssoUrl;

  } catch (err) {
    setAlert(err.message || 'Une erreur est survenue. Veuillez réessayer.');
    if (btn) { btn.disabled = false; btn.textContent = 'Envoyer l\'inscription'; }
  }
}

// ─── Retour depuis HelloAsso ──────────────────────────────────────────────────

async function handleHelloAssoReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('helloasso');
  const refFromUrl = params.get('ref');

  if (!status) return false;

  // Nettoyer l'URL
  history.replaceState({}, '', location.pathname);

  const form = g('signup-form');
  const successPanel = g('success-panel');

  if (status === 'cancel') {
    // L'utilisateur a annulé — rester sur le formulaire, étape paiement
    if (form) form.hidden = false;
    if (successPanel) successPanel.hidden = true;
    setAlert('Le paiement a été annulé. Vous pouvez relancer le paiement en bas de cette page.', 'info');
    showStep(7);
    return true;
  }

  if (status === 'success') {
    // Masquer le formulaire pendant la vérification
    if (form) form.hidden = true;
    if (successPanel) {
      successPanel.hidden = false;
      successPanel.innerHTML = `
        <div class="hero-pill">Vérification…</div>
        <h2>Vérification du paiement</h2>
        <p>Merci de patienter, nous vérifions la confirmation de votre paiement HelloAsso…</p>
      `;
    }

    // Récupérer l'ID d'inscription
    let registrationId = refFromUrl;
    if (!registrationId) {
      try { registrationId = sessionStorage.getItem('affbc_reg_id'); } catch (e) { /* ignore */ }
    }

    if (!registrationId) {
      showPaymentError(form, successPanel, 'Référence d\'inscription introuvable. Veuillez contacter le club en indiquant la date et l\'heure de votre paiement HelloAsso.');
      return true;
    }

    // Polling : jusqu'à 5 tentatives espacées de 2 secondes
    let paymentData = null;
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${STATUS_URL}?registrationId=${encodeURIComponent(registrationId)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (data?.data?.paid && !data?.data?.processing) {
          paymentData = data.data;
          break;
        }
        if (data?.data?.processing) {
          // Une autre requête (webhook ou autre onglet) est en train de finaliser
          // le dossier : on continue le polling plutôt que d'afficher un succès
          // prématuré, la fiche adhérent n'existe pas encore.
          paymentData = null;
        }
      } catch (e) { /* continuer */ }
      if (i < 4) await new Promise(r => setTimeout(r, 2000));
    }

    if (paymentData?.paid) {
      showPaymentSuccess(successPanel, paymentData);
    } else {
      // Paiement pas encore confirmé côté API — afficher message intermédiaire
      showPaymentPending(form, successPanel, registrationId, paymentData);
    }
    return true;
  }

  return false;
}

function showPaymentSuccess(panel, paymentData = null) {
  clearDraft();
  if (!panel) return;
  const installmentCount = Number(paymentData?.installmentCount || 1);
  const remainingInstallments = Math.max(0, Number(paymentData?.remainingInstallments || 0));
  const paymentDetail = installmentCount > 1 && remainingInstallments > 0
    ? `<p>La première échéance HelloAsso a bien été confirmée. Les ${remainingInstallments} échéance(s) restantes seront prélevées automatiquement selon l'échéancier prévu.</p>`
    : `<p>Votre inscription au club AFFBC a bien été enregistrée et votre paiement HelloAsso est confirmé.</p>`;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="hero-pill">✅ Dossier validé</div>
    <h2>Paiement confirmé !</h2>
    ${paymentDetail}
    <p>Votre fiche adhérent a été créée dans le logiciel de gestion du club. Vous recevrez votre licence FFK une fois le dossier complet vérifié par l'équipe dirigeante.</p>
    <div class="success-note">
      📧 Le club a été notifié par email. N'hésitez pas à les contacter si vous avez des questions.
    </div>
    <div class="success-actions" style="margin-top:18px">
      <button type="button" class="btn" onclick="window.location.reload()">Déposer une autre inscription</button>
    </div>
  `;
}

function showPaymentPending(form, panel, registrationId, paymentData = null) {
  if (form) form.hidden = true;
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="hero-pill" style="background:rgba(196,154,55,.2);color:#674b12">⏳ En attente</div>
    <h2>Paiement en cours de vérification</h2>
    <p>Votre paiement HelloAsso est en cours de traitement. La confirmation peut prendre quelques minutes.</p>
    <div class="success-note">
      📋 <strong>Référence de votre dossier :</strong> ${registrationId}<br>
      Conservez cette référence. Si votre fiche n'apparaît pas dans les 24h, contactez le club en indiquant cette référence.
    </div>
    <div class="success-actions" style="margin-top:18px">
      <button type="button" class="btn primary" onclick="recheckStatus('${registrationId}')">Vérifier à nouveau</button>
      <button type="button" class="btn" onclick="window.location.reload()">Nouvelle inscription</button>
    </div>
  `;
}

function showPaymentError(form, panel, message) {
  if (form) form.hidden = false;
  if (panel) panel.hidden = true;
  setAlert(message || 'Une erreur est survenue lors de la vérification du paiement.');
  showStep(7);
}

// Expose pour le bouton "Vérifier à nouveau"
window.recheckStatus = async function(registrationId) {
  const panel = g('success-panel');
  if (panel) panel.innerHTML = '<p>Vérification en cours…</p>';
  try {
    const res = await fetch(`${STATUS_URL}?registrationId=${encodeURIComponent(registrationId)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (data?.data?.paid && !data?.data?.processing) {
      showPaymentSuccess(panel, data?.data || null);
    } else {
      showPaymentPending(null, panel, registrationId, data?.data || null);
    }
  } catch (e) {
    if (panel) panel.innerHTML = `<p class="alert">Erreur de connexion. Veuillez réessayer. Référence : ${registrationId}</p>`;
  }
};

// ─── Initialisation ───────────────────────────────────────────────────────────

async function loadTarifs() {
  try {
    const res = await fetch(TARIFS_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const { pricing } = await res.json();
    if (!pricing || !CONFIG) return;
    // Fusionne par-dessus la config existante — les clés absentes restent inchangées
    CONFIG.pricing = { ...CONFIG.pricing, ...pricing };
    applyBranding(); // met à jour les stat-cards dans le header
  } catch (e) { /* si l'endpoint n'est pas encore déployé, on garde CONFIG tel quel */ }
}

async function init() {
  // 1. Charger la config
  await loadConfig();
  await loadTarifs();

  // 2. Vérifier si on revient de HelloAsso
  const handled = await handleHelloAssoReturn();
  if (handled) return;

  // 3. Rendre le QS et les commandes
  renderQsGrid();
  renderClothingOrder();

  // 4. Recharger le brouillon
  const draft = loadDraft();
  if (draft?.data) {
    applyDraft(draft.data);
    const alert = g('draft-alert');
    if (alert) {
      alert.hidden = false;
      alert.textContent = 'Un brouillon a été restauré. Vérifiez vos informations avant de continuer.';
    }
  }

  // 5. Afficher l'étape initiale
  showStep(draft?.step || 0);

  // 6. Navigation étape suivante / précédente
  document.addEventListener('click', e => {
    const nextBtn = e.target.closest('[data-next]');
    const prevBtn = e.target.closest('[data-prev]');
    const stepBtn = e.target.closest('[data-step-nav]');

    if (nextBtn) {
      const err = validateStep(currentStep);
      if (err) { setAlert(err); return; }
      saveDraft();
      showStep(Math.min(currentStep + 1, TOTAL_STEPS - 1));
      if (currentStep === 5) renderClothingOrder(); // Recalcul quantités tenue
    }

    if (prevBtn) {
      showStep(Math.max(currentStep - 1, 0));
    }

    if (stepBtn) {
      const targetStep = Number(stepBtn.dataset.stepNav);
      if (Number.isNaN(targetStep) || targetStep === currentStep) return;
      const err = canNavigateToStep(targetStep);
      if (err) { setAlert(err); return; }
      saveDraft();
      showStep(targetStep);
      if (currentStep === 5) renderClothingOrder(); // Recalcul quantités tenue
    }
  });

  // 7. Sauvegarde du brouillon à chaque modification
  document.addEventListener('input', () => { updateConditionals(); updateSummary(); });
  document.addEventListener('change', () => { updateConditionals(); updateSummary(); });
  document.addEventListener('input', scheduleBureauEligibilityRefresh);
  document.addEventListener('change', scheduleBureauEligibilityRefresh);

  // 8. Soumission du formulaire
  const form = g('signup-form');
  if (form) form.addEventListener('submit', submitForm);

  // 9. Bouton effacer le brouillon
  const clearBtn = g('clear-draft-button');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Effacer le brouillon et recommencer depuis le début ?')) {
        clearDraft();
        location.reload();
      }
    });
  }

  // 10. Mise à jour initiale
  updateConditionals();
  await refreshBureauEligibility();
  updateSummary();
}

document.addEventListener('DOMContentLoaded', init);
