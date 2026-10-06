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
const COMMUNE_URL = '/api/public/commune'; // GET ?cp=XXXXX — backend commune.js
const RESUME_URL = '/api/public/payment/helloasso/resume'; // POST — backend resume.js
const CSE_ACCESS_URL = '/api/public/cse-access'; // POST — backend cse-access.js
const CSE_ACCESS_HEADER = 'X-CSE-Access-Code';
// Code CSE Thalès validé dans cet onglet (sessionStorage : effacé à la fermeture de l'onglet).
const CSE_ACCESS_STORAGE_KEY = 'affbc_cse_access_code';
const CSE_ACCESS_FORMULA = 'cse_thales';
// Dossier envoyé mais dont le paiement n'est pas confirmé : mémorisé dans ce
// navigateur pour proposer de reprendre le paiement (les dossiers non payés
// sont conservés 48 h côté serveur, puis purgés par le cron).
const PENDING_KEY = 'affbc_pending_payment';
const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const REGISTRATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

// ─── Appareil tactile (téléphone / tablette) ──────────────────────────────────
// Certaines aides ne s'activent QUE lorsque le pointeur principal est tactile
// (téléphone, tablette) : le parcours sur ordinateur n'est pas modifié.
const IS_TOUCH_DEVICE = (() => {
  try { return Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  catch (e) { return false; }
})();

// Même plafond que le serveur (MAX_FILE_SIZE dans src/routes/api/public/inscription.js).
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// ─── État ─────────────────────────────────────────────────────────────────────

let CONFIG = null;
let currentStep = 0;
const TOTAL_STEPS = 8;
let bureauEligibility = { checked: false, renewalVerified: false, eligibleForBureauRate: false, reason: 'missing_fields' };
let bureauEligibilityTimer = null;

// Renouvellement dont l'identité est vérifiée (nom, prénom, naissance, e-mail) ET dont un certificat médical
// déjà validé reste dans sa durée de validité (3 ans) : on ne le redemande pas. Exception : une réponse
// « oui » au questionnaire de santé impose un nouveau certificat (l'état de santé a pu évoluer). Le serveur
// refait ce calcul à l'envoi, ceci n'est que l'affichage.
function certificateReusable() {
  return bureauEligibility.renewalVerified === true
    && bureauEligibility.certificateReusable === true
    && !Object.values(collectQs()).some(v => v === 'yes');
}

function formatIsoDateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}
// Non vide = inscriptions fermées au public, mais accès CSE Thalès validé (formule verrouillée sur cse_thales).
let cseAccessCode = '';

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

// Enregistrement automatique du brouillon (appareils tactiles uniquement, cf. init()).
// Désactivé dès que le brouillon est effacé volontairement (dossier validé,
// bouton « Effacer ») pour qu'il ne soit jamais recréé par l'enregistrement
// déclenché au changement de page.
let draftAutosaveEnabled = true;

function autosaveDraftIfNeeded() {
  if (!IS_TOUCH_DEVICE || !draftAutosaveEnabled) return;
  const form = g('signup-form');
  if (!form || form.hidden) return;
  // Rien de saisi : on ne crée pas de brouillon vide.
  if (!(val('lastName') || val('firstName') || val('email') || val('phonePrimary'))) return;
  saveDraft();
}

function clearDraft() {
  draftAutosaveEnabled = false;
  localStorage.removeItem(DRAFT_KEY);
  const badge = g('draft-badge');
  if (badge) badge.textContent = 'Brouillon non enregistré';
}

// ─── Préremplissage depuis l'espace membre ────────────────────────────────────
// Le bouton "Renouveler mon adhésion" de l'espace membre encode les infos
// déjà connues du membre dans ?prefill=<base64url(JSON)>. Réutilise le même
// mécanisme que le brouillon (applyDraft) pour remplir le formulaire.
function readPrefillFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const token = params.get('prefill');
    if (!token) return null;
    // Nettoyer l'URL tout de suite : évite de garder des infos
    // personnelles dans l'historique du navigateur après le premier chargement.
    history.replaceState({}, '', location.pathname);
    const padded = token.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
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
  set('sexe', data.sexe);
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
  // Engagement à fournir le certificat médical (case de l'étape Santé)
  set('certificateCommitment', data.certificateCommitment);
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
  if (data.decathlonLinkOpened) markDecathlonLinkOpened();
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
  updateDateFieldErrors();
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

// Choix propose quand l'adherent ne trouve pas sa taille dans la liste, pour
// ne pas bloquer l'inscription a l'etape Commandes. Doit rester synchronise
// avec SIZE_UNAVAILABLE dans src/routes/_lib/pdf.js (affichage PDF) et
// src/routes/_lib/boutique-stock.js (validation + sync stock cote serveur —
// celui-ci compare en majuscules via normalizeSize, donc la casse ici n'a
// pas besoin de correspondre exactement, seul le texte compte).
const SIZE_UNAVAILABLE = "Ma taille n'est pas disponible";

function getClothingSizeOptions(kind) {
  const entry = getClothingStockEntry(kind);
  if (entry?.sizes?.length) return entry.sizes;
  return ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];
}

function getClothingSizeStock(kind, size) {
  if (size === SIZE_UNAVAILABLE) return null; // pas une vraie taille : pas de contrainte de stock
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
      else if (size === SIZE_UNAVAILABLE) hint.textContent = 'Pas de souci : le club vous recontactera pour convenir de la taille avant de preparer la commande.';
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
    sexe: val('sexe'),
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
    certificateCommitment: checked('certificateCommitment'),
    ...collectClothing(),
    extraOrderItems: collectExtraOrderItems(),
    decathlonLinkOpened,
    rulesAccepted: checked('rulesAccepted'), insuranceAcknowledged: checked('insuranceAcknowledged'),
    imageRights: val('imageRights'),
    consentSignedAt: val('consentSignedAt'), applicantSignatureName: val('applicantSignatureName'),
    legalConsentSignatureName: val('legalConsentSignatureName'),
    payerFirstName: val('payerFirstName'),
    payerLastName: val('payerLastName'),
    installmentCount: getInstallmentCount(),
  };
}

// ─── Cohérence des dates ────────────────────────────────────────────────────
// Détecte les incohérences de saisie (date de naissance dans le futur, date de
// naissance improbable, signatures antidatées ou postérieures à leur ordre
// logique...) pour un retour immédiat sous le champ concerné pendant la
// saisie. Miroir des vérifications faites côté serveur dans validatePayload()
// (assertBirthDateCoherence / assertSignatureDatesCoherence côté Worker,
// src/routes/api/public/inscription.js) — dupliqué ici faute de module
// partagé entre ce script classique et le Worker (mêmes limites que isMinor()
// ci-dessous, déjà dupliqué pour la même raison).

function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function computeDateFieldErrors() {
  const today = todayISO();
  const birthDate = val('birthDate');
  const legalSignedAt = val('legalSignedAt');
  const consentSignedAt = val('consentSignedAt');
  const errors = {};

  if (birthDate) {
    if (birthDate > today) errors.birthDate = 'La date de naissance ne peut pas être dans le futur.';
    else if (birthDate < '1920-01-01') errors.birthDate = 'La date de naissance semble incorrecte.';
  }

  if (legalSignedAt) {
    if (legalSignedAt > today) errors.legalSignedAt = 'La date de signature ne peut pas être dans le futur.';
    else if (birthDate && legalSignedAt < birthDate) errors.legalSignedAt = 'La date de signature ne peut pas être antérieure à la date de naissance.';
  }

  if (consentSignedAt) {
    if (consentSignedAt > today) errors.consentSignedAt = 'La date de signature ne peut pas être dans le futur.';
    else if (birthDate && consentSignedAt < birthDate) errors.consentSignedAt = 'La date de signature ne peut pas être antérieure à la date de naissance.';
    else if (legalSignedAt && consentSignedAt < legalSignedAt) errors.consentSignedAt = 'La date de signature ne peut pas être antérieure à la date de l\'autorisation parentale.';
  }

  return errors;
}

// Affiche/efface le message d'erreur d'un champ, en conservant le texte
// d'origine du <small> (indice statique ou vide) pour le restaurer une fois
// l'erreur corrigée.
function setFieldError(inputId, message) {
  const input = g(inputId);
  if (!input) return;
  const wrapper = input.closest('.field');
  const hint = g(inputId + '-hint');
  if (message) {
    if (wrapper) wrapper.classList.add('field-invalid');
    input.setAttribute('aria-invalid', 'true');
    if (hint) {
      if (hint.dataset.defaultText === undefined) hint.dataset.defaultText = hint.textContent;
      hint.textContent = message;
      hint.classList.add('field-error-text');
    }
  } else {
    if (wrapper) wrapper.classList.remove('field-invalid');
    input.removeAttribute('aria-invalid');
    if (hint) {
      hint.classList.remove('field-error-text');
      hint.textContent = hint.dataset.defaultText || '';
    }
  }
}

function updateDateFieldErrors() {
  const errors = computeDateFieldErrors();
  setFieldError('birthDate', errors.birthDate || null);
  setFieldError('legalSignedAt', errors.legalSignedAt || null);
  setFieldError('consentSignedAt', errors.consentSignedAt || null);
}

// Empêche déjà la sélection d'une date future via le sélecteur natif (en plus
// du contrôle JS ci-dessus, qui reste nécessaire pour une saisie manuelle au
// clavier selon les navigateurs).
function applyDateBounds() {
  const today = todayISO();
  const birthDateEl = g('birthDate');
  if (birthDateEl) birthDateEl.max = today;
  const legalEl = g('legalSignedAt');
  if (legalEl) legalEl.max = today;
  const consentEl = g('consentSignedAt');
  if (consentEl) consentEl.max = today;
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

  const tshirtQty   = Math.max(0, clothing.tshirtQty);
  const pantalonQty = Math.max(0, clothing.pantalonQty);
  const passport = passportEnabled ? p.passport : 0;
  // Tenue offerte aux Membres du Bureau : l'option 'bureau' n'apparaît que si le
  // renouvellement est reconnu avec la discipline "membre du bureau" (cf.
  // refreshBureauEligibility) et le serveur revérifie de son côté — ce calcul
  // n'est qu'un affichage, jamais une source de vérité.
  const clothingFree = formula === 'bureau';
  const unitTshirt   = clothingFree ? 0 : p.tshirt;
  const unitPantalon = clothingFree ? 0 : p.pantalon;
  const clothingTotal = tshirtQty * unitTshirt + pantalonQty * unitPantalon;
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
  const total = cotisation + passport + clothingTotal + extraProductsTotal;

  return {
    cotisation,
    passRegionAmount,
    passport,
    clothingTotal,
    clothingFree,
    unitTshirt,
    unitPantalon,
    tshirtQty,
    pantalonQty,
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
  // Accès CSE Thalès hors période d'ouverture : une seule formule possible.
  if (cseAccessCode) { enforceCseFormula(); return; }

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
    updateConditionals();
    return;
  }

  if (!val('lastName') || !val('firstName') || !val('birthDate') || !val('email')) {
    bureauEligibility = { checked: false, renewalVerified: false, eligibleForBureauRate: false, reason: 'missing_fields' };
    syncBureauFormulaOption();
    updateConditionals();
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
  updateConditionals();
  updateSummary();
}

function scheduleBureauEligibilityRefresh() {
  if (bureauEligibilityTimer) window.clearTimeout(bureauEligibilityTimer);
  bureauEligibilityTimer = window.setTimeout(() => {
    refreshBureauEligibility();
  }, 250);
}

let postalCodeLookupTimer = null;
let lastPostalCodeLookup = '';

// Suggestion de ville à partir du code postal (cf. commune.js côté serveur —
// jamais d'appel direct à une API tierce depuis le navigateur, la CSP du
// site l'interdit). Ne se déclenche qu'une fois les 5 chiffres saisis.
function schedulePostalCodeLookup() {
  const postalCode = val('postalCode');
  if (!/^\d{5}$/.test(postalCode)) return;
  if (postalCodeLookupTimer) window.clearTimeout(postalCodeLookupTimer);
  postalCodeLookupTimer = window.setTimeout(() => refreshCityFromPostalCode(postalCode), 300);
}

async function refreshCityFromPostalCode(postalCode) {
  if (postalCode === lastPostalCodeLookup) return; // évite un aller-retour identique en boucle
  lastPostalCodeLookup = postalCode;

  const datalist = g('city-suggestions');
  if (!datalist) return;

  let communes = [];
  try {
    const res = await fetch(`${COMMUNE_URL}?cp=${encodeURIComponent(postalCode)}`, { cache: 'no-store' });
    const payload = await res.json().catch(() => null);
    communes = Array.isArray(payload?.data?.communes) ? payload.data.communes : [];
  } catch (e) {
    // Hors-ligne, requête interrompue... : la ville reste une saisie libre,
    // aucune information n'est perdue.
    return;
  }

  // Constructions DOM directes (pas d'innerHTML) : évite tout risque
  // d'injection depuis un nom de commune, même si la source est fiable.
  datalist.textContent = '';
  for (const nom of communes) {
    const option = document.createElement('option');
    option.value = nom;
    datalist.appendChild(option);
  }

  // Ne préremplit que si le champ Ville est encore vide et qu'une seule
  // commune correspond : ne jamais écraser une saisie ou un choix déjà fait,
  // y compris si la personne revient modifier le code postal après coup.
  const cityField = g('city');
  if (cityField && !cityField.value.trim() && communes.length === 1) {
    cityField.value = communes[0];
  }
}


// ─── Affichages conditionnels ─────────────────────────────────────────────────

function updateConditionals() {
  const minor = isMinor(val('birthDate'));
  show('minor-block', minor);

  // Signature du consentement "droit à l'image" (étape Engagements) : le
  // pratiquant signe lui-même, sauf s'il est mineur, où c'est le représentant
  // légal qui signe. Rejoué ici (donc après restauration de brouillon,
  // préremplissage espace membre, ou toute saisie) pour rester synchronisé
  // avec la vraie valeur de birthDate, plutôt que de dépendre d'un event
  // 'change' qui ne se déclenche pas lors d'une écriture programmatique.
  show('applicant-signature-field', !minor);
  show('legal-consent-signature-field', minor);
  const applicantSignatureInput = g('applicantSignatureName');
  const legalConsentSignatureInput = g('legalConsentSignatureName');
  if (applicantSignatureInput) applicantSignatureInput.toggleAttribute('required', !minor);
  if (legalConsentSignatureInput) legalConsentSignatureInput.toggleAttribute('required', minor);

  const passRegion = val('passRegionEnabled') === 'true';
  document.querySelectorAll('[data-show-when="passRegion"]').forEach(el => el.hidden = !passRegion);
  document.querySelectorAll('[data-show-when="noPassRegion"]').forEach(el => el.hidden = passRegion);

  enforceCseFormula();
  const formula = val('formulaCode');
  const needProof = formula === 'pro' || formula === 'cse_thales';
  document.querySelectorAll('[data-show-when="proofNeeded"]').forEach(el => el.hidden = !needProof);
  // Aide contextuelle sur les justificatifs acceptés : liste différente selon
  // qu'on est sur le tarif pro (plusieurs types de justificatifs possibles)
  // ou le tarif CSE Thalès (un seul document précis, l'attestation employeur).
  document.querySelectorAll('[data-show-when="proofPro"]').forEach(el => el.hidden = formula !== 'pro');
  document.querySelectorAll('[data-show-when="proofCseThales"]').forEach(el => el.hidden = formula !== 'cse_thales');

  const familyNote = document.getElementById('family-rate-note');
  if (familyNote) familyNote.hidden = formula !== 'family';

  // Certificat médical requis si mineur ou QS positif
  const qsSport = collectQs();
  const qsPositive = Object.values(qsSport).some(v => v === 'yes');
  const certRequired = minor || qsPositive;
  show('medical-upload-block', certRequired);

  // Certificat déjà validé et encore valable : bandeau « rien à fournir », sans case d'engagement.
  const reusable = certRequired && certificateReusable();
  show('certificate-reuse-note', reusable);
  show('certificate-commitment-block', !reusable);
  const reuseUntil = g('certificate-reuse-until');
  if (reuseUntil) {
    const until = formatIsoDateFr(bureauEligibility.certificateValidUntil);
    reuseUntil.textContent = until ? ` (jusqu'au ${until})` : '';
  }
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
      ${totals.clothingFree && (totals.tshirtQty > 0 || totals.pantalonQty > 0) ? `<div class="summary-line"><strong>Tenue club</strong><span>Offerte · ${tshirtLabel} · ${pantalonLabel}</span></div>` : ''}
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
      ${totals.clothingFree && (totals.tshirtQty > 0 || totals.pantalonQty > 0) ? `<div class="bank-line"><strong>Tenue club (${tshirtLabel} · ${pantalonLabel})</strong><code>Offerte</code></div>` : ''}
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
  if (index === 7) prefillPayerIfEmpty();
  renderStepList();
  renderProgress();
  updateConditionals();
  updateSummary();
  setAlert('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  focusStepHeading(index);
}

// Étape "Paiement" (data-step="7") : le nom du payeur est presque toujours
// celui de l'adhérent (ou de son représentant légal si mineur — c'est en
// pratique le parent qui paie), pourtant il fallait le retaper à chaque
// fois. On ne préremplit QUE si les deux champs sont encore vides, pour ne
// jamais écraser une saisie déjà faite (retour en arrière depuis l'étape
// suivante, ou payeur volontairement différent de l'adhérent — un tiers qui
// règle pour quelqu'un d'autre, par exemple).
function prefillPayerIfEmpty() {
  if (val('payerFirstName') || val('payerLastName')) return;
  const minor = isMinor(val('birthDate'));
  const firstName = minor ? val('legalFirstName') : val('firstName');
  const lastName = minor ? val('legalLastName') : val('lastName');
  const firstNameEl = g('payerFirstName');
  const lastNameEl = g('payerLastName');
  if (firstName && firstNameEl) firstNameEl.value = firstName;
  if (lastName && lastNameEl) lastNameEl.value = lastName;
}

// Déplace le focus clavier/lecteur d'écran vers le titre de l'étape affichée.
// Sans ça, après un clic sur "Suivant"/"Précédent", le focus reste sur le
// bouton (parfois masqué juste après) : un utilisateur clavier ou lecteur
// d'écran ne "voit" jamais qu'il vient de changer d'étape. tabindex="-1"
// rend le titre focusable par script sans l'ajouter à la navigation Tab
// normale (pattern standard pour les vues qui changent en SPA).
// preventScroll évite un conflit avec le window.scrollTo() juste au-dessus.
function focusStepHeading(index) {
  const heading = document.querySelector(`.step-panel[data-step="${index}"] h2`);
  if (!heading) return;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
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
      if (!val('sexe')) return 'Le sexe est obligatoire.';
      if (!val('birthDate')) return 'La date de naissance est obligatoire.';
      const birthDateError = computeDateFieldErrors().birthDate;
      if (birthDateError) return birthDateError;
      if (!val('birthPlace')) return 'Le lieu de naissance est obligatoire.';
      const photo = g('photoIdentity');
      if (!photo || !photo.files?.length) return 'La photo d\'identité est obligatoire.';
      return null;
    }
    case 2: { // Coordonnées
      if (!val('address1')) return 'L\'adresse est obligatoire.';
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
        const legalSignedAtError = computeDateFieldErrors().legalSignedAt;
        if (legalSignedAtError) return legalSignedAtError;
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
        // Certificat obligatoire : pièce jointe, OU certificat déjà validé réutilisable (renouvellement),
        // OU case d'engagement à le fournir au plus vite.
        const cert = g('medicalCertificate');
        if (!cert?.files?.length && !checked('certificateCommitment') && !certificateReusable()) {
          return 'Le certificat médical est obligatoire pour votre profil : joignez-le, ou cochez la case d\'engagement à le fournir au plus vite.';
        }
      }
      return null;
    }
    case 5: { // Commandes
      const clothing = collectClothing();
      if (val('typeInscription') === 'nouvelle') {
        if (clothing.tshirtQty < 1) return 'Pour une nouvelle adhésion, au moins 1 t-shirt est obligatoire.';
        if (clothing.pantalonQty < 1) return 'Pour une nouvelle adhésion, au moins 1 pantalon est obligatoire.';
      }
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
      if (!decathlonLinkOpened) return 'Merci de cliquer sur « Créer mon compte Decathlon » ci-dessus avant de continuer.';
      return null;
    }
    case 6: { // Engagements
      if (!checked('rulesAccepted')) return 'Vous devez accepter le règlement intérieur.';
      if (!checked('insuranceAcknowledged')) return 'Vous devez reconnaître avoir pris connaissance des modalités d\'assurance.';
      if (!val('imageRights')) return 'Veuillez faire votre choix concernant le droit à l\'image.';
      if (!val('consentSignedAt')) return 'La date de signature est obligatoire.';
      const consentSignedAtError = computeDateFieldErrors().consentSignedAt;
      if (consentSignedAtError) return consentSignedAtError;
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
  }).join('') + `<option value="${SIZE_UNAVAILABLE}">${SIZE_UNAVAILABLE}</option>`;
  const pantalonOptions = getClothingSizeOptions('pantalon').map(size => {
    const stock = getClothingSizeStock('pantalon', size);
    const disabled = stock != null && stock <= 0;
    const suffix = stock == null ? '' : ` · ${stock} dispo`;
    return `<option value="${size}" ${disabled ? 'disabled' : ''}>${size}${suffix}</option>`;
  }).join('') + `<option value="${SIZE_UNAVAILABLE}">${SIZE_UNAVAILABLE}</option>`;
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

        <details class="size-guide">
          <summary>
            <span class="sg-icon">📏</span>
            <span class="sg-label">Guide des tailles — T-shirt unisexe</span>
            <span class="sg-chevron">▸</span>
          </summary>
          <div class="size-guide-body">
            <p class="size-guide-note">Mesurez votre <strong>tour de poitrine</strong> (sous les aisselles) avec un mètre ruban et choisissez une taille dont le tour de poitrine est supérieur au vôtre. Les cotes ci-dessous sont celles du <strong>t-shirt</strong> (et non du corps).</p>
            <table class="size-guide-table">
              <thead><tr><th>Taille</th><th>Tour de poitrine du t-shirt (cm)</th><th>Longueur (cm)</th></tr></thead>
              <tbody>
                <tr><td><span class="sz-badge">XS</span></td><td>94</td><td>68</td></tr>
                <tr><td><span class="sz-badge">S</span></td><td>100</td><td>70</td></tr>
                <tr><td><span class="sz-badge">M</span></td><td>106</td><td>72</td></tr>
                <tr><td><span class="sz-badge">L</span></td><td>112</td><td>74</td></tr>
                <tr><td><span class="sz-badge">XL</span></td><td>118</td><td>76</td></tr>
                <tr><td><span class="sz-badge">XXL</span></td><td>124</td><td>78</td></tr>
                <tr><td><span class="sz-badge">XXXL</span></td><td>130</td><td>80</td></tr>
                <tr><td><span class="sz-badge">XXXXL</span></td><td>140</td><td>82</td></tr>
              </tbody>
            </table>
            <p class="size-guide-src">Tolérance ± 2 cm. En cas de doute, choisissez la taille supérieure. Source : <a href="https://www.decathlonpro.fr/tee-shirt-mixte-190-noir-id-8568037.html" target="_blank" rel="noopener">Decathlon Pro – Tee shirt mixte B&amp;C 190 Noir</a> (fiche B&amp;C #E190)</p>
          </div>
        </details>
      </div>
      <div class="order-input" data-label="P.U."><span id="tshirt-unit">${p.tshirt.toFixed(2)} €</span></div>
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
        <small>Pantalon budo noir unisexe</small>
        <small id="pantalon-stock-hint">${pantalonTotalStock == null ? 'Stock boutique indisponible.' : `Stock total boutique: ${pantalonTotalStock}`}</small>

        <details class="size-guide">
          <summary>
            <span class="sg-icon">📏</span>
            <span class="sg-label">Guide des tailles — Pantalon budo unisexe</span>
            <span class="sg-chevron">▸</span>
          </summary>
          <div class="size-guide-body">
            <p class="size-guide-note">Mesurez votre <strong>tour de taille</strong> (au-dessus du nombril) et votre <strong>tour de hanches</strong> avec un mètre ruban.</p>
            <table class="size-guide-table">
              <thead><tr><th>Taille</th><th>Tour de taille (cm)</th><th>Tour de hanches (cm)</th></tr></thead>
              <tbody>
                <tr><td><span class="sz-badge">XS</span></td><td>80 – 85</td><td>66 – 71</td></tr>
                <tr><td><span class="sz-badge">S</span></td><td>86 – 91</td><td>72 – 77</td></tr>
                <tr><td><span class="sz-badge">M</span></td><td>92 – 97</td><td>78 – 83</td></tr>
                <tr><td><span class="sz-badge">L</span></td><td>98 – 104</td><td>84 – 89</td></tr>
                <tr><td><span class="sz-badge">XL</span></td><td>105 – 111</td><td>90 – 97</td></tr>
              </tbody>
            </table>
            <p class="size-guide-src">Source : <a href="https://www.decathlonpro.fr/pantalon-budo-noir-500-id-8558691.html" target="_blank" rel="noopener">Decathlon Pro – Pantalon budo Noir 500</a></p>
          </div>
        </details>
      </div>
      <div class="order-input" data-label="P.U."><span id="pantalon-unit">${p.pantalon.toFixed(2)} €</span></div>
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
  const tshirtUnit = g('tshirt-unit');
  const pantalonUnit = g('pantalon-unit');
  if (tshirtUnit) tshirtUnit.textContent = totals.clothingFree ? 'Offert' : `${Number(CONFIG.pricing.tshirt).toFixed(2)} €`;
  if (pantalonUnit) pantalonUnit.textContent = totals.clothingFree ? 'Offert' : `${Number(CONFIG.pricing.pantalon).toFixed(2)} €`;
  if (tshirtSubtotal) tshirtSubtotal.textContent = `${(totals.tshirtQty * totals.unitTshirt).toFixed(2)} €`;
  if (pantalonSubtotal) pantalonSubtotal.textContent = `${(totals.pantalonQty * totals.unitPantalon).toFixed(2)} €`;
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

// ─── Bannière partenaire Decathlon (étape Commandes) ──────────────────────────
// Rendre le clic obligatoire avant de valider l'étape (validateStep, case 5)
// sans ralentir l'inscription : on se contente de constater le clic sur le lien
// partenaire (ouverture immédiate d'un nouvel onglet), sans attendre ni essayer
// de vérifier la création réelle du compte côté Decathlon — impossible à
// constater depuis ce domaine (lien cross-origin). Le drapeau est inclus dans
// le brouillon (saveDraft / applyDraft) pour ne pas redemander le clic si la
// page est rechargée ou le brouillon restauré plus tard.
let decathlonLinkOpened = false;

function markDecathlonLinkOpened() {
  if (decathlonLinkOpened) return;
  decathlonLinkOpened = true;
  const banner = g('partnerBanner');
  const status = g('decathlonCtaStatus');
  if (banner) banner.classList.add('is-confirmed');
  if (status) status.hidden = false;
}

function initDecathlonPartnerBanner() {
  const cta = g('decathlonCta');
  if (cta) cta.addEventListener('click', markDecathlonLinkOpened);
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
      clubEmail: 'club@americanfullfightingbons.fr',
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

function applyClosedState() {
  const banner = g('inscription-closed');
  const main = g('signup-main');
  if (main) main.hidden = true;
  if (banner) {
    banner.hidden = false;
    const msgEl = g('inscription-closed-message');
    if (msgEl && CONFIG?.closedMessage) msgEl.textContent = CONFIG.closedMessage;
    const contactEl = g('closed-club-contact');
    if (contactEl) {
      contactEl.textContent = [CONFIG?.clubPhone, CONFIG?.clubEmail].filter(Boolean).join(' · ');
    }
  }
  initCseAccessPrompt();
}

// ─── Accès CSE Thalès hors période d'ouverture ───────────────────────────────
// Quand les inscriptions sont fermées, les membres du CSE Thalès peuvent saisir
// un code (défini dans le logiciel de gestion) pour débloquer le formulaire,
// limité au tarif « CSE Thalès ». Le code est vérifié côté serveur, à la saisie
// puis à chaque soumission du dossier (en-tête X-CSE-Access-Code).

async function checkCseAccessCode(code) {
  try {
    const res = await fetch(CSE_ACCESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) return { ok: true, message: '' };
    const data = await res.json().catch(() => null);
    return {
      ok: false,
      message: res.status === 403
        ? 'Code invalide. Vérifiez le code communiqué par le CSE Thalès.'
        : (data?.error || 'Vérification impossible pour le moment. Réessayez dans un instant.'),
    };
  } catch (e) {
    return { ok: false, message: 'Erreur de connexion. Réessayez dans un instant.' };
  }
}

// Reprend un accès CSE déjà validé dans cet onglet (rechargement de page,
// retour de HelloAsso…) — revérifié auprès du serveur à chaque fois.
async function restoreCseAccess() {
  if (!CONFIG?.cseAccessEnabled) return false;
  let stored = '';
  try { stored = sessionStorage.getItem(CSE_ACCESS_STORAGE_KEY) || ''; } catch (e) { /* ignore */ }
  if (!stored) return false;
  const check = await checkCseAccessCode(stored);
  if (check.ok) { cseAccessCode = stored; return true; }
  try { sessionStorage.removeItem(CSE_ACCESS_STORAGE_KEY); } catch (e) { /* ignore */ }
  return false;
}

function initCseAccessPrompt() {
  const wrapper = g('cse-access');
  if (!wrapper || !CONFIG?.cseAccessEnabled) return; // fonctionnalité désactivée : aucun bouton
  wrapper.hidden = false;

  const toggle = g('cse-access-toggle');
  const form = g('cse-access-form');
  const input = g('cse-access-code');
  const submit = g('cse-access-submit');
  const errorEl = g('cse-access-error');
  if (!toggle || !form || !input || !submit) return;

  const showError = (msg) => { if (errorEl) { errorEl.textContent = msg; errorEl.hidden = !msg; } };

  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) input.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (!code) { showError('Saisissez votre code d\'accès.'); return; }
    submit.disabled = true;
    submit.textContent = 'Vérification…';
    showError('');
    const check = await checkCseAccessCode(code);
    if (check.ok) {
      try { sessionStorage.setItem(CSE_ACCESS_STORAGE_KEY, code); } catch (e) { /* ignore */ }
      // Recharge : init() reprend le code validé et affiche le formulaire.
      window.location.reload();
      return;
    }
    showError(check.message);
    submit.disabled = false;
    submit.textContent = 'Accéder';
    input.select();
  });
}

// Verrouille la formule tarifaire sur « CSE Thalès » (mode accès CSE uniquement).
// Le serveur impose la même règle : ceci n'est que le reflet dans l'interface.
function enforceCseFormula() {
  if (!cseAccessCode) return;
  const select = g('formulaCode');
  if (!select) return;
  Array.from(select.options).forEach((option) => {
    if (option.value !== CSE_ACCESS_FORMULA) option.remove();
  });
  if (select.value !== CSE_ACCESS_FORMULA) select.value = CSE_ACCESS_FORMULA;
  const note = g('bureau-member-note');
  if (note) note.textContent = 'Inscription réservée aux membres du CSE Thalès : le tarif CSE Thalès est appliqué.';
  const familyNote = g('family-rate-note');
  if (familyNote) familyNote.hidden = true;
}

// ─── Construction du payload JSON final ──────────────────────────────────────

function buildPayload() {
  const qs = collectQs();
  const minor = isMinor(val('birthDate'));
  const clothing = collectClothing();
  const extraOrderItems = collectExtraOrderItems();
  const typeInscription = val('typeInscription');
  return {
    identity: {
      lastName: val('lastName'),
      firstName: val('firstName'),
      sexe: val('sexe'),
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
      // Engagement à fournir le certificat plus tard : n'a de sens que si le certificat est
      // exigé ET qu'aucune pièce n'est jointe (le serveur revérifie les deux).
      certificateCommitment: (minor || Object.values(qs).some(v => v === 'yes'))
        && !g('medicalCertificate')?.files?.length
        && !certificateReusable()
        && checked('certificateCommitment'),
    },
    clothingOrder: {
      tshirtQty: clothing.tshirtQty,
      pantalonQty: clothing.pantalonQty,
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

// ─── Compression de la photo d'identité avant envoi ──────────────────────────
// Les photos prises au téléphone font souvent plusieurs Mo (ex: 2448×3264px)
// pour un usage final où elles s'affichent en tout petit (cadre "Photo
// d'identité" du PDF, ~30×35mm). On les redimensionne et recompresse côté
// client avant l'envoi : upload plus rapide sur réseau mobile, moins de
// stockage R2, PDF plus léger — sans rien changer côté serveur (qui reçoit
// toujours un File JPEG/PNG classique, comme avant).
// `imageOrientation: 'from-image'` applique la rotation EXIF (photos prises
// en portrait) avant de dessiner sur le canvas : sans ça, certaines photos
// ressortiraient couchées. Toute erreur (format non décodable, mémoire...)
// fait retomber sur le fichier original tel quel — la compression est un
// bonus, jamais une condition bloquante pour l'inscription.
const PHOTO_MAX_DIMENSION    = 800;         // px, plus grand côté
const PHOTO_JPEG_QUALITY     = 0.8;
const PHOTO_SKIP_UNDER_BYTES = 400 * 1024;  // déjà assez léger : on ne retouche pas

// Justificatifs (certificat médical, Pass Région, tarif réduit) envoyés en
// PHOTO depuis un téléphone : réduits pour rester lisibles mais légers.
// (Le serveur les convertit ensuite en PDF — cf. image-to-pdf.js.)
const DOCUMENT_MAX_DIMENSION = 2200;        // px, plus grand côté : un A4 reste lisible
const DOCUMENT_JPEG_QUALITY  = 0.85;

// Pièces jointes du formulaire : libellé affiché dans les messages + étape où elles se choisissent.
const FILE_RULES = {
  photoIdentity:      { id: 'photoIdentity',      label: 'la photo d\'identité',             step: 1, photo: true },
  passRegionDocument: { id: 'passRegionDocument', label: 'le justificatif Pass Région',      step: 3 },
  proProofDocument:   { id: 'proProofDocument',   label: 'le justificatif de tarif réduit',  step: 3 },
  medicalCertificate: { id: 'medicalCertificate', label: 'le certificat médical',            step: 4 },
};
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Le `type` d'un fichier choisi depuis un téléphone est parfois vide : on se
// rabat alors sur l'extension (le serveur vérifie de toute façon le contenu réel).
function isPdfFile(file) {
  return Boolean(file) && (file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name || '')));
}
function looksLikeImage(file) {
  return Boolean(file) && ((file.type || '').startsWith('image/')
    || (!file.type && /\.(jpe?g|png|heic|heif|webp)$/i.test(file.name || '')));
}

// Décode une image pour la dessiner sur un canvas.
// 1) createImageBitmap (rapide, applique la rotation EXIF) ;
// 2) repli pour les navigateurs mobiles anciens : <img> alimentée par une URL
//    data: (la CSP du site n'autorise pas blob: pour les images).
async function decodeImageForCanvas(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => { bitmap.close?.(); } };
    } catch (e) { /* repli ci-dessous */ }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('lecture impossible'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image non décodable'));
    el.src = dataUrl;
  });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} };
}

// Redimensionne + recompresse en JPEG. Renvoie un File, ou null au moindre souci
// (format non décodable, mémoire…) : l'appelant retombe alors sur l'original.
// `flatten` peint un fond blanc avant le dessin (PNG transparent → JPEG sans
// fond noir) ; utilisé pour les documents, pas pour la photo d'identité.
async function reencodeImageAsJpeg(file, { maxDimension, quality, flatten }) {
  let decoded = null;
  try {
    decoded = await decodeImageForCanvas(file);
    const { source, width, height } = decoded;
    if (!width || !height) return null;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (flatten) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, targetW, targetH); }
    ctx.drawImage(source, 0, 0, targetW, targetH);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return null;
    return new File(
      [blob],
      (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg',
      { type: 'image/jpeg' },
    );
  } catch (e) {
    return null;
  } finally {
    try { decoded?.release(); } catch (e) { /* ignore */ }
  }
}

async function compressPhotoFile(file) {
  if (!file || !(file instanceof File)) return file;
  if (!looksLikeImage(file)) return file;
  if (file.size <= PHOTO_SKIP_UNDER_BYTES) return file;

  const compressed = await reencodeImageAsJpeg(file, {
    maxDimension: PHOTO_MAX_DIMENSION,
    quality: PHOTO_JPEG_QUALITY,
    flatten: false,
  });
  if (!compressed) return file; // n'importe quel souci : on envoie le fichier original
  // Garde-fou : dans le rare cas où la version « compressée » ressort plus
  // lourde que l'originale, on garde l'originale.
  return compressed.size < file.size ? compressed : file;
}

// Justificatif : un PDF part TEL QUEL (comportement inchangé). Une photo est
// toujours ré-encodée en JPEG : ça applique la rotation EXIF (sinon la page
// PDF produite par le serveur serait couchée), convertit HEIC/WebP quand le
// navigateur sait les lire, et ramène le poids sous le plafond d'envoi.
async function prepareDocumentFile(file) {
  if (!file || !(file instanceof File)) return file;
  if (isPdfFile(file)) return file;
  if (!looksLikeImage(file)) return file;
  const converted = await reencodeImageAsJpeg(file, {
    maxDimension: DOCUMENT_MAX_DIMENSION,
    quality: DOCUMENT_JPEG_QUALITY,
    flatten: true,
  });
  return converted || file;
}

// Contrôle immédiat à la sélection d'un fichier (volontairement indulgent : on
// ne bloque que ce que le serveur refuserait de toute façon — le vrai contrôle
// de contenu reste côté serveur).
let lastFileChoiceAlert = ''; // dernier message affiché par checkChosenFile (pour ne pas laisser une erreur périmée)
function checkChosenFile(rule) {
  const input = g(rule.id);
  const file = input?.files?.[0];
  if (!file) return;
  let message = '';
  if (rule.photo) {
    if (file.type && !looksLikeImage(file)) {
      message = `Ce fichier n'est pas une image : ${rule.label} doit être une photo JPEG ou PNG.`;
    }
  } else if (isPdfFile(file)) {
    if (file.size > MAX_UPLOAD_BYTES) message = `Ce PDF est trop volumineux (8 Mo maximum) pour ${rule.label}.`;
  } else if (file.type && !looksLikeImage(file)) {
    message = `Format non pris en charge pour ${rule.label} : joignez un PDF ou une photo (JPEG ou PNG).`;
  }
  if (message) {
    input.value = '';
    lastFileChoiceAlert = message;
    setAlert(message);
  } else if (lastFileChoiceAlert && (g('signup-alert')?.textContent || '').trim() === lastFileChoiceAlert) {
    // Un fichier valide remplace celui qui avait été refusé : on retire l'ancien message.
    lastFileChoiceAlert = '';
    setAlert('');
  }
}

// Contrôle final, sur les fichiers tels qu'ils vont réellement partir (après
// compression) : message clair + retour à l'étape concernée, au lieu d'une
// erreur technique du serveur à la toute dernière étape.
function findFileProblem(entries) {
  const okImageTypes = ['image/jpeg', 'image/png'];
  const iosTip = ' Sur iPhone : Réglages > Appareil photo > Formats > « Le plus compatible ».';
  for (const { rule, file } of entries) {
    const Label = capitalize(rule.label);
    if (file.size > MAX_UPLOAD_BYTES) {
      return { step: rule.step, message: `${Label} est trop volumineux (8 Mo maximum). Choisissez un fichier plus léger${rule.photo ? '' : ' ou une photo'}.` };
    }
    if (rule.photo) {
      if (file.type && !okImageTypes.includes(file.type)) {
        return { step: rule.step, message: `${Label} doit être une image JPEG ou PNG : ce format n'est pas pris en charge.${iosTip}` };
      }
    } else if (!isPdfFile(file) && file.type && !okImageTypes.includes(file.type)) {
      return { step: rule.step, message: `${Label} : format non pris en charge (PDF, JPEG ou PNG acceptés).${iosTip}` };
    }
  }
  return null;
}

// Pièces obligatoires absentes au moment d'envoyer (par ex. brouillon restauré
// après un rechargement de page : les fichiers ne peuvent pas être conservés).
// Reprend exactement les conditions de validateStep (étapes 1, 3 et 4).
function findMissingRequiredFile() {
  const missing = (rule) => ({
    step: rule.step,
    message: `Merci de joindre ${rule.label} : les pièces jointes ne sont pas conservées si la page a été rechargée.`,
  });
  if (!g('photoIdentity')?.files?.length) return missing(FILE_RULES.photoIdentity);
  if (val('passRegionEnabled') === 'true' && !g('passRegionDocument')?.files?.length) {
    return missing(FILE_RULES.passRegionDocument);
  }
  const formula = val('formulaCode');
  if ((formula === 'pro' || formula === 'cse_thales') && !g('proProofDocument')?.files?.length) {
    return missing(FILE_RULES.proProofDocument);
  }
  const qsPositive = Object.values(collectQs()).some(v => v === 'yes');
  if ((isMinor(val('birthDate')) || qsPositive)
      && !g('medicalCertificate')?.files?.length
      && !checked('certificateCommitment')
      && !certificateReusable()) {
    return missing(FILE_RULES.medicalCertificate);
  }
  return null;
}

// ─── Soumission du formulaire ─────────────────────────────────────────────────

// Passage à l'étape suivante (bouton « Continuer » ; sur appareil tactile aussi
// la touche « Aller / Suivant » du clavier). Logique reprise telle quelle du
// gestionnaire de clic, pour qu'elle reste identique des deux côtés.
function goToNextStep() {
  const err = validateStep(currentStep);
  if (err) { setAlert(err); return; }
  saveDraft();
  showStep(Math.min(currentStep + 1, TOTAL_STEPS - 1));
  if (currentStep === 5) renderClothingOrder(); // Recalcul quantités tenue
}

// Message lisible quand le réseau lâche pendant l'envoi (fréquent en 4G, dans un
// train, en changeant de Wi-Fi) : le navigateur ne fournit sinon qu'un texte
// technique en anglais (« Failed to fetch », « Load failed »…).
function isNetworkFailure(err) {
  return /failed to fetch|load failed|networkerror|network request failed|internet connection appears to be offline|network connection was lost/i
    .test(String(err?.message || ''));
}

async function submitForm(event) {
  event.preventDefault();

  // Appareil tactile : la touche « Aller » du clavier virtuel soumet le formulaire
  // depuis n'importe quelle étape. Avant la dernière, ce n'est pas un envoi du
  // dossier mais un « Continuer ».
  if (IS_TOUCH_DEVICE && currentStep < TOTAL_STEPS - 1) { goToNextStep(); return; }

  const error = validateStep(7);
  if (error) { setAlert(error); return; }

  // Pièce obligatoire absente (typiquement : page rechargée par le téléphone,
  // les fichiers ne survivent pas à un rechargement) : on renvoie à la bonne
  // étape avec un message clair, plutôt qu'une erreur du serveur à la fin.
  const missingFile = findMissingRequiredFile();
  if (missingFile) { showStep(missingFile.step); setAlert(missingFile.message); return; }

  const btn = g('submit-button');
  const submitLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Préparation…'; }
  setAlert('');

  try {
    const payload = buildPayload();
    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));

    // Fichiers
    const fileEntries = []; // fichiers tels qu'ils vont partir, pour le contrôle final
    const photoFileRaw = g('photoIdentity')?.files?.[0];
    if (photoFileRaw) {
      if (btn) btn.textContent = 'Compression de la photo…';
      const photoFile = await compressPhotoFile(photoFileRaw);
      formData.append('photoIdentity', photoFile);
      fileEntries.push({ rule: FILE_RULES.photoIdentity, file: photoFile });
    }

    // Certificat médical, justificatif Pass Région, justificatif tarif réduit :
    // un PDF part tel quel ; une photo est réduite (cf. prepareDocumentFile).
    for (const id of ['medicalCertificate', 'passRegionDocument', 'proProofDocument']) {
      const rawDoc = g(id)?.files?.[0];
      if (!rawDoc) continue;
      if (btn && !isPdfFile(rawDoc) && looksLikeImage(rawDoc)) btn.textContent = 'Préparation des documents…';
      const doc = await prepareDocumentFile(rawDoc);
      formData.append(id, doc);
      fileEntries.push({ rule: FILE_RULES[id], file: doc });
    }

    const fileProblem = findFileProblem(fileEntries);
    if (fileProblem) {
      if (btn) { btn.disabled = false; btn.textContent = submitLabel; }
      showStep(fileProblem.step);
      setAlert(fileProblem.message);
      return;
    }

    // Honeypot
    formData.append('website', '');

    if (btn) btn.textContent = 'Envoi en cours…';
    const submitOptions = { method: 'POST', body: formData };
    if (cseAccessCode) submitOptions.headers = { [CSE_ACCESS_HEADER]: encodeURIComponent(cseAccessCode) };
    const res = await fetch(SUBMIT_URL, submitOptions);
    const data = await res.json().catch(() => null);

    if (!res.ok || data?.error) {
      throw new Error(data?.error || `Erreur serveur (${res.status})`);
    }

    const { helloAssoUrl, registrationId, free } = data.data || {};

    if (free) {
      // Dossier validé immédiatement (tarif Membres du Bureau, gratuit) :
      // pas de paiement HelloAsso, on affiche directement la confirmation.
      clearDraft();
      const form = g('signup-form');
      const successPanel = g('success-panel');
      if (form) form.hidden = true;
      if (successPanel) {
        successPanel.hidden = false;
        successPanel.innerHTML = `
          <div class="hero-pill">✅ Dossier validé</div>
          <h2>Inscription validée !</h2>
          <p>Votre renouvellement au tarif Membres du Bureau a bien été enregistré, sans paiement requis.</p>
          <p>Votre fiche adhérent a été créée dans le logiciel de gestion du club.</p>
          <div class="success-note">
            📧 Le club a été notifié par email. N'hésitez pas à les contacter si vous avez des questions.
          </div>
          <div class="success-actions" style="margin-top:18px">
            <button type="button" class="btn" onclick="window.location.reload()">Déposer une autre inscription</button>
          </div>
        `;
      }
      return;
    }

    if (!helloAssoUrl) {
      throw new Error('Lien de paiement HelloAsso non reçu. Veuillez réessayer ou contacter le club.');
    }

    // Enregistrer l'ID pour la vérification au retour
    try { sessionStorage.setItem('affbc_reg_id', registrationId); } catch (e) { /* ignore */ }
    // Le brouillon n'est PAS effacé ici : il ne l'est qu'une fois le paiement
    // confirmé (showPaymentSuccess). Avant, un retour depuis HelloAsso (flèche
    // retour, erreur, refus bancaire) retombait sur un formulaire entièrement
    // vide. Le dossier est en plus mémorisé comme « paiement en attente » pour
    // pouvoir reprendre le paiement sans tout ressaisir.
    setPendingPayment(registrationId);
    saveDraft();

    // Redirection vers HelloAsso
    window.location.href = helloAssoUrl;

  } catch (err) {
    setAlert(isNetworkFailure(err)
      ? 'La connexion a été interrompue pendant l\'envoi de votre dossier. Vérifiez votre réseau (idéalement en Wi-Fi), puis réessayez.'
      : (err.message || 'Une erreur est survenue. Veuillez réessayer.'));
    if (btn) { btn.disabled = false; btn.textContent = 'Envoyer l\'inscription'; }
  }
}

// ─── Retour depuis HelloAsso ──────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `ref` vient de l'URL et est ensuite réaffiché dans la page : on n'accepte
// qu'un UUID, ce qui empêche toute injection HTML/JS via un lien forgé.
function sanitizeRegistrationId(value) {
  const id = String(value || '').trim();
  return REGISTRATION_ID_RE.test(id) ? id : '';
}

function setPendingPayment(registrationId) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id: registrationId, ts: Date.now() })); } catch (e) { /* ignore */ }
}

function getPendingPayment() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw);
    const id = sanitizeRegistrationId(pending?.id);
    if (!id || Date.now() - Number(pending?.ts || 0) > PENDING_MAX_AGE_MS) {
      localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return { id, ts: Number(pending.ts) };
  } catch (e) { return null; }
}

function clearPendingPayment() {
  try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
}

function startNewRegistration() {
  clearPendingPayment();
  window.location.reload();
}

async function fetchPaymentStatus(registrationId) {
  try {
    const res = await fetch(`${STATUS_URL}?registrationId=${encodeURIComponent(registrationId)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    return data?.data || null;
  } catch (e) { return null; }
}

// Interroge le statut jusqu'à `attempts` fois (espacées de 2 s).
// → `confirmed` : réponse « payé ET dossier finalisé » (sinon null) ;
//   `last` : dernière réponse exploitable (payé mais en cours de finalisation,
//   non payé + statut du dossier…), ou null si le serveur n'a pas répondu.
// Si `processing` est vrai, une autre requête (webhook, autre onglet) finalise
// le dossier : on continue le polling plutôt que d'afficher un succès
// prématuré, la fiche adhérent n'existe pas encore.
async function pollPayment(registrationId, attempts = 5) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const data = await fetchPaymentStatus(registrationId);
    if (data) last = data;
    if (data?.paid && !data?.processing) return { confirmed: data, last };
    if (i < attempts - 1) await sleep(2000);
  }
  return { confirmed: null, last };
}

async function handleHelloAssoReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('helloasso');

  if (!status) return false;

  // Nettoyer l'URL
  history.replaceState({}, '', location.pathname);

  const form = g('signup-form');
  const successPanel = g('success-panel');

  // Référence du dossier : URL d'abord, puis mémoire du navigateur.
  let registrationId = sanitizeRegistrationId(params.get('ref'));
  if (!registrationId) {
    try { registrationId = sanitizeRegistrationId(sessionStorage.getItem('affbc_reg_id')); } catch (e) { /* ignore */ }
  }
  if (!registrationId) registrationId = getPendingPayment()?.id || '';

  // Retour SANS paiement : flèche retour (cancel), erreur technique HelloAsso
  // (error) ou lien « reprendre mon paiement » de l'e-mail (resume).
  // On n'affiche jamais le formulaire ici : le formulaire n'est pas initialisé
  // à ce stade (init() s'arrête après ce retour) et serait inerte.
  if (status === 'cancel' || status === 'error' || status === 'resume') {
    if (form) form.hidden = true;
    if (!registrationId) {
      showNoReferencePanel(successPanel, status);
      return true;
    }
    showCheckingPanel(successPanel);
    // Le paiement a peut-être abouti malgré tout : on vérifie une fois avant
    // de proposer d'en refaire un.
    const { confirmed, last } = await pollPayment(registrationId, 1);
    if (confirmed) {
      showPaymentSuccess(successPanel, confirmed);
    } else if (last?.paid) {
      showPaymentPending(form, successPanel, registrationId, last);
    } else {
      showResumePanel(successPanel, registrationId, status, last);
    }
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

    if (!registrationId) {
      showNoReferencePanel(successPanel, status);
      return true;
    }

    // Polling : jusqu'à 5 tentatives espacées de 2 secondes
    const { confirmed, last } = await pollPayment(registrationId, 5);

    if (confirmed) {
      showPaymentSuccess(successPanel, confirmed);
    } else {
      // Paiement pas encore confirmé côté API — afficher message intermédiaire
      showPaymentPending(form, successPanel, registrationId, last);
    }
    return true;
  }

  return false;
}

// Visite « à froid » : si ce navigateur a un dossier dont le paiement n'a jamais
// été confirmé (onglet fermé sur HelloAsso, retour navigateur…), on vérifie son
// état au lieu de présenter un formulaire vierge — ce qui évite aussi de payer
// deux fois. Retourne true si un écran de suivi a été affiché.
async function handlePendingPaymentOnLoad() {
  const pending = getPendingPayment();
  if (!pending) return false;

  const form = g('signup-form');
  const panel = g('success-panel');
  const { confirmed, last } = await pollPayment(pending.id, 1);

  if (confirmed) {
    if (form) form.hidden = true;
    showPaymentSuccess(panel, confirmed);
    return true;
  }
  if (last?.paid) {
    showPaymentPending(form, panel, pending.id, last);
    return true;
  }
  if (last && last.registrationStatus === 'paiement_en_attente') {
    if (form) form.hidden = true;
    showResumePanel(panel, pending.id, 'pending', last);
    return true;
  }
  // Dossier inconnu, expiré ou statut inattendu : on repart sur le formulaire.
  clearPendingPayment();
  return false;
}

// Champs "foyer" repris pour inscrire un autre membre de la famille à la
// suite : adresse, téléphones, email et contact d'urgence sont presque
// toujours partagés par tous les enfants d'une même famille — les ressaisir
// à chaque inscription était la friction la plus citée. Tout le reste
// (identité, pratique, questionnaire de santé, photo, tarification,
// représentant légal, consentements, signatures, moyen de paiement) reste
// propre à CHAQUE personne inscrite et ne doit jamais être repris
// automatiquement.
const FAMILY_SHARED_FIELDS = [
  'address1', 'address2', 'postalCode', 'city',
  'phonePrimary', 'phoneSecondary', 'email',
  'emergencyLastName', 'emergencyFirstName', 'emergencyPhonePrimary', 'emergencyPhoneSecondary',
];

// Le formulaire reste dans le DOM (juste masqué) au moment où l'écran de
// succès s'affiche : collectAllFields() lit donc encore les valeurs qui
// viennent d'être saisies, même après le clearDraft() de
// showPaymentSuccess() (qui ne touche que le localStorage, pas le DOM).
function startFamilyMemberRegistration() {
  const current = collectAllFields();
  const shared = {};
  for (const key of FAMILY_SHARED_FIELDS) {
    if (current[key]) shared[key] = current[key];
  }
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ step: 0, data: shared, familyMember: true, ts: Date.now() }));
  } catch (e) { /* au pire, le formulaire repart simplement vierge */ }
  window.location.reload();
}

function showPaymentSuccess(panel, paymentData = null) {
  clearDraft();
  clearPendingPayment();
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
      <button type="button" class="btn primary" id="family-member-button">👪 Inscrire un autre membre de la famille</button>
      <button type="button" class="btn" onclick="window.location.reload()">Déposer une autre inscription</button>
    </div>
  `;
  panel.querySelector('#family-member-button')?.addEventListener('click', startFamilyMemberRegistration);
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

function showCheckingPanel(panel) {
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="hero-pill">Vérification…</div>
    <h2>Vérification de votre dossier</h2>
    <p>Merci de patienter quelques secondes…</p>
  `;
}

// Aucune référence de dossier retrouvée : on l'explique et on propose de
// recommencer, sans jamais laisser un formulaire inerte à l'écran.
function showNoReferencePanel(panel, status) {
  if (!panel) return;
  const text = status === 'success'
    ? 'Si vous avez payé sur HelloAsso, contactez le club en indiquant la date et l\'heure de votre paiement : votre dossier sera retrouvé.'
    : 'Si vous aviez déjà envoyé votre dossier, cherchez dans votre messagerie le message « Confirmation de votre inscription AFFBC » : il contient un lien pour reprendre votre paiement. Sinon, vous pouvez recommencer votre inscription.';
  panel.hidden = false;
  panel.innerHTML = `
    <div class="hero-pill" style="background:rgba(196,154,55,.2);color:#674b12">⚠️ Dossier introuvable</div>
    <h2>Nous n'avons pas retrouvé votre dossier</h2>
    <p>${text}</p>
    <div class="success-actions" style="margin-top:18px">
      <button type="button" class="btn primary" id="new-registration-button">Nouvelle inscription</button>
    </div>
  `;
  panel.querySelector('#new-registration-button')?.addEventListener('click', startNewRegistration);
}

// Écran « paiement non terminé » : le dossier et les pièces sont déjà
// enregistrés côté serveur, on propose de rouvrir une page de paiement.
function showResumePanel(panel, registrationId, reason, last = null) {
  if (!panel) return;

  // Dossier qui n'est plus repris­sable (purgé après 48 h, statut inattendu).
  if (last?.registrationStatus && last.registrationStatus !== 'paiement_en_attente') {
    clearPendingPayment();
    panel.hidden = false;
    panel.innerHTML = `
      <div class="hero-pill" style="background:rgba(196,154,55,.2);color:#674b12">⚠️ Dossier expiré</div>
      <h2>Ce dossier n'est plus disponible</h2>
      <p>Les dossiers dont le paiement n'est pas terminé sont supprimés au bout de 48 h. Vous pouvez recommencer votre inscription : vos informations saisies sont conservées dans ce navigateur, seuls les documents sont à joindre à nouveau.</p>
      <div class="success-actions" style="margin-top:18px">
        <button type="button" class="btn primary" id="new-registration-button">Recommencer mon inscription</button>
      </div>
    `;
    panel.querySelector('#new-registration-button')?.addEventListener('click', startNewRegistration);
    return;
  }

  const intro = {
    cancel: 'Vous avez quitté la page de paiement HelloAsso avant d\'avoir payé.',
    error: 'HelloAsso a signalé une erreur pendant le paiement.',
    resume: 'Votre dossier est bien enregistré, mais son paiement n\'est pas terminé.',
    pending: 'Votre dossier est bien enregistré, mais son paiement n\'a pas été finalisé.',
  }[reason] || 'Le paiement de votre dossier n\'est pas terminé.';
  const noPayment = last ? ' Nous n\'avons enregistré aucun paiement pour ce dossier.' : '';
  const count = [1, 2, 3].includes(Number(last?.installmentCount)) ? Number(last.installmentCount) : 1;
  const option = (n) => `<option value="${n}"${n === count ? ' selected' : ''}>Paiement en ${n} fois</option>`;

  panel.hidden = false;
  panel.innerHTML = `
    <div class="hero-pill" style="background:rgba(196,154,55,.2);color:#674b12">⏳ Paiement non terminé</div>
    <h2>Reprenez votre paiement</h2>
    <p>${intro}${noPayment}</p>
    <p><strong>Vous n'avez rien à ressaisir :</strong> votre dossier et vos documents sont conservés 48 h.</p>
    <div class="form-grid two" style="margin-top:16px">
      <label class="field">
        <span>Règlement HelloAsso</span>
        <select id="resume-installments">${option(1)}${option(2)}${option(3)}</select>
        <small>Paiement refusé par votre banque ? Confirmez l'opération dans l'application de votre banque (3-D Secure), essayez une autre carte, ou choisissez un paiement en 2 ou 3 fois.</small>
      </label>
    </div>
    <div class="alert" id="resume-alert" hidden style="margin-top:14px"></div>
    <div class="success-note">
      📋 <strong>Référence de votre dossier :</strong> ${registrationId}<br>
      En cas de difficulté, contactez le club en indiquant cette référence.
    </div>
    <div class="success-actions" style="margin-top:18px">
      <button type="button" class="btn primary" id="resume-pay-button">Reprendre mon paiement</button>
      <button type="button" class="btn" id="new-registration-button">Nouvelle inscription</button>
    </div>
  `;
  panel.querySelector('#resume-pay-button')?.addEventListener('click', () => resumePayment(panel, registrationId));
  panel.querySelector('#new-registration-button')?.addEventListener('click', startNewRegistration);
}

// Crée un nouveau lien de paiement pour un dossier déjà enregistré, puis y redirige.
async function resumePayment(panel, registrationId) {
  const btn = panel.querySelector('#resume-pay-button');
  const alertEl = panel.querySelector('#resume-alert');
  const select = panel.querySelector('#resume-installments');
  const showError = (message) => {
    if (!alertEl) return;
    alertEl.textContent = message || '';
    alertEl.hidden = !message;
  };

  showError('');
  if (btn) { btn.disabled = true; btn.textContent = 'Ouverture de HelloAsso…'; }

  try {
    const res = await fetch(RESUME_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ registrationId, installmentCount: Number(select?.value || 1) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) throw new Error(data?.error || `Erreur serveur (${res.status})`);

    const result = data?.data || {};
    if (result.paid) {
      // Une tentative précédente avait en réalité été payée : rien à repayer.
      showCheckingPanel(panel);
      const { confirmed, last } = await pollPayment(registrationId, 5);
      if (confirmed) showPaymentSuccess(panel, confirmed);
      else showPaymentPending(g('signup-form'), panel, registrationId, last);
      return;
    }
    if (!result.helloAssoUrl) {
      throw new Error('Lien de paiement HelloAsso non reçu. Veuillez réessayer ou contacter le club.');
    }

    try { sessionStorage.setItem('affbc_reg_id', registrationId); } catch (e) { /* ignore */ }
    setPendingPayment(registrationId);
    window.location.href = result.helloAssoUrl;
  } catch (err) {
    showError(err instanceof TypeError
      ? 'Erreur de connexion. Vérifiez votre réseau puis réessayez.'
      : (err.message || 'Une erreur est survenue. Veuillez réessayer.'));
    if (btn) { btn.disabled = false; btn.textContent = 'Reprendre mon paiement'; }
  }
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

// Aides à la saisie sur appareil tactile (sans effet sur ordinateur) :
//  - touche « entrée » du clavier virtuel libellée « Suivant » ;
//  - pas de majuscule automatique / correcteur sur les noms et lieux (le correcteur
//    d'iOS transforme volontiers un prénom) ;
//  - rappel des formats acceptés sous les champs de pièces jointes.
function enhanceMobileForm() {
  if (!IS_TOUCH_DEVICE) return;

  document.querySelectorAll('.step-panel input').forEach((el) => {
    if (['file', 'checkbox', 'radio', 'date', 'number', 'hidden'].includes(el.type)) return;
    if (el.closest('.step-panel[data-step="7"]')) return;
    el.setAttribute('enterkeyhint', 'next');
  });

  ['lastName', 'firstName', 'birthPlace', 'address1', 'city',
   'emergencyLastName', 'emergencyFirstName', 'legalLastName', 'legalFirstName', 'legalCity'].forEach((id) => {
    const el = g(id);
    if (!el) return;
    el.setAttribute('autocapitalize', 'words');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('spellcheck', 'false');
  });
  const emailField = g('email');
  if (emailField) {
    emailField.setAttribute('autocapitalize', 'off');
    emailField.setAttribute('autocorrect', 'off');
    emailField.setAttribute('spellcheck', 'false');
  }

  ['medicalCertificate', 'passRegionDocument', 'proProofDocument'].forEach((id) => {
    const label = g(id)?.closest('label.field');
    if (!label || label.querySelector('.file-hint')) return;
    const hint = document.createElement('small');
    hint.className = 'file-hint';
    hint.textContent = 'PDF ou photo (JPEG, PNG) : une photo prise avec le téléphone convient, elle est réduite automatiquement.';
    label.appendChild(hint);
  });
}

async function init() {
  // 1. Charger la config
  await loadConfig();

  // Page restaurée depuis le cache « retour/avancer » du navigateur (retour
  // depuis HelloAsso avec le bouton précédent) : l'état JS d'avant la
  // redirection (bouton grisé « Envoi en cours… ») n'a plus de sens, on recharge.
  window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });

  await loadTarifs();

  // 2. Vérifier si on revient de HelloAsso, ou si ce navigateur a un dossier
  // dont le paiement n'est pas terminé. Traité AVANT l'état « inscriptions
  // fermées » : quelqu'un qui a déjà envoyé son dossier doit toujours pouvoir
  // voir sa confirmation ou terminer son paiement.
  const handled = await handleHelloAssoReturn();
  if (handled) return;
  const pendingHandled = await handlePendingPaymentOnLoad();
  if (pendingHandled) return;

  // 2bis. Si les inscriptions sont fermées, on affiche le bandeau et on
  // n'initialise rien d'autre (pas de formulaire, pas de handlers de
  // soumission) : c'est une mesure d'UX, la vraie protection est côté
  // serveur dans /api/public/inscription (POST).
  //
  // Exception : un membre du CSE Thalès qui a saisi un code valide dans cet
  // onglet garde accès au formulaire (formule verrouillée sur « CSE Thalès »).
  if (CONFIG && CONFIG.isOpen === false) {
    if (await restoreCseAccess()) {
      const cseBanner = g('cse-access-banner');
      if (cseBanner) cseBanner.hidden = false;
    } else {
      applyClosedState();
      return;
    }
  }

  // 3. Rendre le QS et les commandes
  renderQsGrid();
  renderClothingOrder();
  initDecathlonPartnerBanner();
  applyDateBounds();

  // 4. Préremplissage depuis l'espace membre (lien "Renouveler mon
  // adhésion"), sinon recharger le brouillon local.
  const prefill = readPrefillFromUrl();
  let draft = null;
  if (prefill) {
    applyDraft(prefill);
    const alert = g('draft-alert');
    if (alert) {
      alert.hidden = false;
      alert.textContent = 'Vos informations ont été préremplies depuis votre espace membre. Vérifiez-les avant de continuer.';
    }
  } else {
    draft = loadDraft();
    if (draft?.data) {
      applyDraft(draft.data);
      const alert = g('draft-alert');
      if (alert) {
        alert.hidden = false;
        alert.textContent = draft.familyMember
          ? 'Adresse, téléphones, email et contact d\'urgence repris de l\'inscription précédente : vérifiez-les, puis complétez l\'identité de ce nouveau membre.'
          : 'Un brouillon a été restauré. Vérifiez vos informations avant de continuer.';
        // Les fichiers choisis ne peuvent pas être restaurés : un téléphone recharge
        // volontiers la page (retour de l'appareil photo, changement d'application).
        if (IS_TOUCH_DEVICE && !draft.familyMember && draft.step >= 1) {
          alert.textContent += ' Vos pièces jointes (photo, certificat…) ne sont pas conservées : pensez à les ajouter à nouveau.';
        }
      }
    }
  }

  // Accès CSE : un brouillon ou un préremplissage ne doit pas réintroduire une autre formule.
  enforceCseFormula();

  // 5. Afficher l'étape initiale
  showStep(draft?.step || 0);

  // 6. Navigation étape suivante / précédente
  document.addEventListener('click', e => {
    const nextBtn = e.target.closest('[data-next]');
    const prevBtn = e.target.closest('[data-prev]');
    const stepBtn = e.target.closest('[data-step-nav]');

    if (nextBtn) goToNextStep();

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
  document.addEventListener('input', () => { updateConditionals(); updateSummary(); updateDateFieldErrors(); });
  document.addEventListener('change', () => { updateConditionals(); updateSummary(); updateDateFieldErrors(); });
  document.addEventListener('input', scheduleBureauEligibilityRefresh);
  document.addEventListener('change', scheduleBureauEligibilityRefresh);
  const postalCodeField = g('postalCode');
  if (postalCodeField) postalCodeField.addEventListener('input', schedulePostalCodeLookup);

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

  // 9 bis. Contrôle immédiat du fichier choisi (format / poids), au lieu d'attendre
  // l'envoi final. Indulgent : ne bloque que ce que le serveur refuserait de toute façon.
  for (const rule of Object.values(FILE_RULES)) {
    const fileInput = g(rule.id);
    if (fileInput) fileInput.addEventListener('change', () => checkChosenFile(rule));
  }

  // 9 ter. Appareils tactiles uniquement : aides à la saisie + brouillon enregistré
  // au fil de la saisie (un téléphone peut décharger la page quand on bascule vers
  // l'appareil photo ou une autre application ; le brouillon n'était enregistré
  // qu'au clic sur « Continuer »).
  enhanceMobileForm();
  if (IS_TOUCH_DEVICE) {
    let autosaveTimer = null;
    const scheduleAutosave = () => { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosaveDraftIfNeeded, 800); };
    document.addEventListener('input', scheduleAutosave);
    document.addEventListener('change', scheduleAutosave);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosaveDraftIfNeeded(); });
    window.addEventListener('pagehide', autosaveDraftIfNeeded);
  }

  // 10. Mise à jour initiale
  updateConditionals();
  await refreshBureauEligibility();
  updateSummary();
  updateDateFieldErrors();
}

document.addEventListener('DOMContentLoaded', init);
