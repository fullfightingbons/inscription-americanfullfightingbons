/**
 * AFFBC — Worker Cloudflare Pages : soumission du formulaire d'inscription public
 *
 * Ce handler :
 *   1. Valide le payload
 *   2. Uploade les pièces justificatives dans R2
 *   3. Crée la session de paiement HelloAsso
 *   4. Insère un enregistrement dans `inscriptions_publiques` (statut: paiement_en_attente)
 *      ↳ La fiche adhérent et la vente tenue sont créées par status.js APRÈS confirmation du paiement
 *   5. Retourne l'URL de paiement HelloAsso au front
 */

import { badRequest, json } from "../../_lib/data.js";
import { getClientIp, writeAuditLog } from "../../_lib/audit.js";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const REQUIRED_QS_KEYS = [
  "familyCardiacDeath",
  "chestPain",
  "wheezing",
  "fainting",
  "sportStop",
  "longTermTreatment",
  "bonePain",
  "practiceInterrupted",
  "medicalAdviceNeeded",
];

// ─── Helpers génériques ───────────────────────────────────────────────────────

function toBool(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function requireText(value, label) {
  if (!String(value || "").trim()) {
    throw new Error(`${label} obligatoire`);
  }
  return String(value).trim();
}

function requireDate(value, label) {
  const clean = requireText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new Error(`${label} doit être au format YYYY-MM-DD`);
  }
  return clean;
}

function requireEmail(value) {
  const clean = requireText(value, "Email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error("Email invalide");
  }
  return clean;
}

function fileExtension(name = "") {
  const clean = String(name || "");
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index).toLowerCase() : "";
}

function safeFileName(name = "") {
  return String(name || "document")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function parseJsonField(formData, key) {
  const raw = formData.get(key);
  if (!raw) {
    throw new Error("Données d'inscription manquantes");
  }
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new Error("Payload d'inscription invalide");
  }
}

function escapeMime(value) {
  return String(value || "").replace(/\r?\n/g, " ").trim();
}

function normalizeHelloAssoName(value, fallback = "") {
  return String(value || fallback || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[''`".,]/g, " ")
    .replace(/[^A-Za-z -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHelloAssoFirstName(value, fallback = "") {
  const normalized = normalizeHelloAssoName(value, fallback)
    .replace(/-/g, " ")
    .split(" ")
    .filter(Boolean)[0] || "";
  return normalized.slice(0, 64);
}

function normalizeHelloAssoLastName(value, fallback = "") {
  const normalized = normalizeHelloAssoName(value, fallback)
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 64);
}

function normalizeInstallmentCount(value) {
  const count = Number(value || 1);
  return count === 2 || count === 3 ? count : 1;
}

function splitAmountCents(totalCents, count) {
  const baseAmount = Math.floor(totalCents / count);
  let remainder = totalCents - (baseAmount * count);
  return Array.from({ length: count }, () => {
    const amount = baseAmount + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return amount;
  });
}

function buildInstallmentDate(monthOffset, dayOfMonth = 5) {
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const date = new Date(Date.UTC(utcYear, utcMonth + monthOffset, Math.min(dayOfMonth, 27), 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function buildInstallmentPlan(totalCents, installmentCount) {
  const count = normalizeInstallmentCount(installmentCount);
  const amounts = splitAmountCents(totalCents, count);
  const initialAmount = amounts[0];
  const terms = amounts.slice(1).map((amount, index) => ({
    amount,
    date: buildInstallmentDate(index + 1),
  }));
  return {
    installmentCount: count,
    initialAmount,
    terms,
    schedule: amounts.map((amount, index) => ({
      amount,
      date: index === 0 ? null : buildInstallmentDate(index),
    })),
  };
}

// ─── Calcul des totaux ────────────────────────────────────────────────────────

function isMinor(birthDate) {
  const now = new Date();
  const birth = new Date(`${birthDate}T00:00:00`);
  const age =
    now.getFullYear() -
    birth.getFullYear() -
    (now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())
      ? 1
      : 0);
  return age < 18;
}

function getActiveExerciseDate(endDate) {
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return endDate;
  }
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-07-31`;
}

function calculateTotals(payload) {
  const pricing = payload?.pricing || {};
  const formula = payload.formulaCode;
  const typeInscription = payload.typeInscription;
  const passRegionEnabled = toBool(payload.passRegionEnabled);
  const passportEnabled = toBool(payload.passportEnabled);
  const clothing = payload?.clothingOrder || {};

  const baseMap = {
    base: Number(pricing.base || 250),
    family: Number(pricing.family || 200),
    pro: Number(pricing.pro || 125),
    cse_thales: Number(pricing.cseThales || 39),
    bureau: Number(pricing.bureau || 0),
  };

  const baseCotisation = baseMap[formula];
  if (!Number.isFinite(baseCotisation)) {
    throw new Error("Formule tarifaire invalide");
  }
  const formulaLabelMap = {
    base:      'Tarif standard',
    family:    'Tarif famille',
    pro:       'Tarif professionnel',
    cse_thales:'Tarif CSE Thales',
    bureau:    'Membres du Bureau',
  };

  const passRegionAmount = passRegionEnabled ? Number(payload.passRegionAmount || 0) : 0;
  const cotisation = Math.max(0, baseCotisation - passRegionAmount);

  const tshirtQty = Math.max(
    Number(clothing.tshirtQty || 0),
    typeInscription === "nouvelle" ? 1 : 0,
  );
  const pantalonQty = Math.max(
    Number(clothing.pantalonQty || 0),
    typeInscription === "nouvelle" ? 1 : 0,
  );

  const newMemberKit = Number(pricing.newMemberKit || 0);
  const passport = passportEnabled ? Number(pricing.passport || 25) : 0;
  const clothingTotal =
    tshirtQty * Number(pricing.tshirt || 25) +
    pantalonQty * Number(pricing.pantalon || 10);

  return {
    cotisation,
    passRegionAmount,
    newMemberKit,
    passport,
    clothingTotal,
    tshirtQty,
    pantalonQty,
    pricingTshirt: Number(pricing.tshirt || 25),
    pricingPantalon: Number(pricing.pantalon || 10),
    total: cotisation + newMemberKit + passport + clothingTotal,
    formulaLabel: formulaLabelMap[formula] || formula,
  };
}

function normalizePersonName(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hasBureauDiscipline(discipline) {
  return String(discipline || "").toLowerCase().includes("membre du bureau");
}

async function findMatchingAdherent(db, payload) {
  const nom = String(payload.identity?.lastName || "").trim().toUpperCase();
  const prenom = normalizePersonName(payload.identity?.firstName);
  const birthDate = String(payload.identity?.birthDate || "").trim();
  const email = normalizeEmail(payload.contact?.email);

  if (!nom || !prenom || !birthDate || !email) {
    return { adherent: null, renewalVerified: false, reason: "missing_fields" };
  }

  // Recherche d'abord sur nom+prenom pour pouvoir distinguer les raisons d'échec
  const adherent = await db.prepare(
    `SELECT id, nom, prenom, naissance, email, discipline FROM adherents WHERE nom = ? AND prenom = ?`,
  )
    .bind(nom, prenom)
    .first();

  if (!adherent) {
    return { adherent: null, renewalVerified: false, reason: "not_found" };
  }
  if (adherent.naissance !== birthDate) {
    return { adherent, renewalVerified: false, reason: "birthdate_mismatch" };
  }
  if (normalizeEmail(adherent.email) !== email) {
    return { adherent, renewalVerified: false, reason: "email_mismatch" };
  }

  return { adherent, renewalVerified: true, reason: null };
}

// ─── Validation du payload ────────────────────────────────────────────────────

function validatePayload(payload) {
  const identity = payload?.identity || {};
  const contact = payload?.contact || {};
  const emergency = payload?.emergency || {};
  const legalRep = payload?.legalRepresentative || {};
  const practice = payload?.practice || {};
  const health = payload?.health || {};
  const consents = payload?.consents || {};
  const payment = payload?.payment || {};

  const birthDate = requireDate(identity.birthDate, "Date de naissance");
  const minor = isMinor(birthDate);

  requireText(identity.lastName, "Nom");
  requireText(identity.firstName, "Prénom");
  requireText(identity.birthPlace, "Lieu de naissance");
  requireText(contact.address1, "Adresse");
  requireText(contact.postalCode, "Code postal");
  requireText(contact.city, "Ville");
  requireText(contact.phonePrimary, "Téléphone principal");
  requireText(contact.phoneSecondary, "Téléphone secondaire");
  requireEmail(contact.email);
  requireText(emergency.lastName, "Nom du contact d'urgence");
  requireText(emergency.firstName, "Prénom du contact d'urgence");
  requireText(emergency.phonePrimary, "Téléphone principal du contact d'urgence");
  requireText(emergency.phoneSecondary, "Téléphone secondaire du contact d'urgence");
  requireText(practice.typeInscription, "Type d'inscription");
  requireText(practice.practiceType, "Type de pratique");
  requireText(practice.formulaCode, "Formule tarifaire");

  // Seul HelloAsso est accepté
  if (payment.method !== "helloasso") {
    throw new Error("Mode de paiement invalide : seul HelloAsso est accepté");
  }
  const installmentCount = normalizeInstallmentCount(payment.installmentCount);
  if (![1, 2, 3].includes(installmentCount)) {
    throw new Error("Le nombre d'échéances HelloAsso est invalide");
  }
  if (payment.payerFirstName) {
    requireText(payment.payerFirstName, "Prénom du payeur");
  }
  if (payment.payerLastName) {
    requireText(payment.payerLastName, "Nom du payeur");
  }
  if (minor) {
    requireText(legalRep.lastName, "Nom du représentant légal");
    requireText(legalRep.firstName, "Prénom du représentant légal");
    requireText(legalRep.role, "Qualité du représentant légal");
    requireText(legalRep.signatureName, "Signature du représentant légal");
    requireText(legalRep.city, "Ville de l'autorisation parentale");
    requireDate(legalRep.signedAt, "Date de l'autorisation parentale");
  }

  for (const key of REQUIRED_QS_KEYS) {
    if (health.qsSport?.[key] !== "yes" && health.qsSport?.[key] !== "no") {
      throw new Error("Toutes les réponses au questionnaire de santé sont obligatoires");
    }
  }

  if (!toBool(consents.rulesAccepted)) {
    throw new Error("L'acceptation du règlement intérieur est obligatoire");
  }
  if (consents.imageRights !== "yes" && consents.imageRights !== "no") {
    throw new Error("Le choix du droit à l'image est obligatoire");
  }
  requireText(consents.applicantSignatureName, "Signature du pratiquant");
  requireDate(consents.signedAt, "Date de signature");

  if (
    practice.passRegionEnabled &&
    !/^\d{4}$/.test(String(practice.passRegionCode || "").trim())
  ) {
    throw new Error("Le code Pass Région doit contenir 4 chiffres");
  }

  if (
    practice.passRegionEnabled &&
    !String(practice.passRegionDossierNumber || "").trim()
  ) {
    throw new Error("Le numéro de dossier Pass Région est obligatoire");
  }

  const certificateRequired =
    minor || REQUIRED_QS_KEYS.some((key) => health.qsSport?.[key] === "yes");

  return { birthDate, minor, certificateRequired };
}

// ─── Upload R2 ────────────────────────────────────────────────────────────────

async function uploadRequiredFile(env, registrationId, file, targetName, preferImage = false) {
  if (!(file instanceof File) || !file.size) {
    throw new Error(`Le document ${targetName} est obligatoire`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `Le document ${targetName} dépasse ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} Mo`,
    );
  }
  if (preferImage) {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      throw new Error(`Le document ${targetName} doit être une image JPEG ou PNG`);
    }
  } else {
    if (file.type !== "application/pdf") {
      throw new Error(`Le document ${targetName} doit être un fichier PDF`);
    }
  }

  const bucket = preferImage
    ? env.R2_STORAGE || env.R2_PDF
    : env.R2_PDF || env.R2_STORAGE;
  if (!bucket) {
    throw new Error("Le stockage des pièces justificatives n'est pas configuré");
  }

  const key = `public-inscriptions/${registrationId}/${targetName}${
    fileExtension(file.name) || (preferImage ? ".jpg" : ".pdf")
  }`;

  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || (preferImage ? "image/jpeg" : "application/pdf") },
    customMetadata: { originalName: safeFileName(file.name || targetName) },
  });

  return {
    bucket: preferImage
      ? env.R2_STORAGE ? "storage" : "fullfighting-pdf"
      : env.R2_PDF ? "fullfighting-pdf" : "storage",
    key,
    name: file.name || targetName,
    contentType: file.type || "",
    size: file.size || 0,
  };
}

// ─── HelloAsso ────────────────────────────────────────────────────────────────

async function getHelloAssoToken(env) {
  const baseUrl = env.HELLOASSO_ENV === "sandbox" ? "https://api.helloasso-sandbox.com" : "https://api.helloasso.com";
  const response = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.HELLOASSO_CLIENT_ID,
      client_secret: env.HELLOASSO_CLIENT_SECRET,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HelloAsso auth échouée (${response.status}) : ${text}`);
  }
  const data = await response.json();
  if (!data.access_token) {
    throw new Error("HelloAsso : token absent de la réponse d'authentification");
  }
  return data.access_token;
}

async function createHelloAssoCheckout(env, payload, totals, registrationId) {
  const helloAssoEnabled =
    env.HELLOASSO_CLIENT_ID &&
    env.HELLOASSO_CLIENT_SECRET &&
    env.HELLOASSO_ORGANIZATION_SLUG;

  if (!helloAssoEnabled) {
    throw new Error(
      "HelloAsso n'est pas configuré sur ce serveur. Vérifiez les variables d'environnement HELLOASSO_CLIENT_ID, HELLOASSO_CLIENT_SECRET et HELLOASSO_ORGANIZATION_SLUG.",
    );
  }

  const amountCents = Math.round(totals.total * 100);
  if (amountCents <= 0) {
    throw new Error("Le montant du dossier est nul — impossible de créer un paiement HelloAsso.");
  }
  const installmentPlan = buildInstallmentPlan(
    amountCents,
    payload.payment?.installmentCount,
  );
  payload.payment = {
    ...(payload.payment || {}),
    installmentCount: installmentPlan.installmentCount,
    schedule: installmentPlan.schedule,
  };

  const token = await getHelloAssoToken(env);

  const origin = String(env.PUBLIC_ORIGIN || "https://inscription.americanfullfightingbons.fr").replace(/\/+$/, "");
  const firstName = String(payload.identity?.firstName || "").trim();
  const lastName = String(payload.identity?.lastName || "").trim();
  const birthDate = String(payload.identity?.birthDate || "").trim();
  const email = String(payload.contact?.email || "").trim();
  const address = String(payload.contact?.address1 || "").trim();
  const city = String(payload.contact?.city || "").trim();
  const zipCode = String(payload.contact?.postalCode || "").trim();
  const legalRep = payload.legalRepresentative || {};
  let payerFirstName = String(payload.payment?.payerFirstName || "").trim();
  let payerLastName = String(payload.payment?.payerLastName || "").trim();
  if (!payerFirstName || !payerLastName) {
    payerFirstName = String(legalRep.firstName || payerFirstName || firstName).trim();
    payerLastName = String(legalRep.lastName || payerLastName || lastName).trim();
  }
  payerFirstName = normalizeHelloAssoFirstName(payerFirstName, firstName) || "Adherent";
  payerLastName = normalizeHelloAssoLastName(payerLastName, lastName) || "AFFBC";

  const body = {
    totalAmount: amountCents,
    initialAmount: installmentPlan.initialAmount,
    itemName: `Inscription AFFBC — ${firstName} ${lastName}`.trim(),
    backUrl: `${origin}/?helloasso=cancel`,
    errorUrl: `${origin}/?helloasso=cancel`,
    returnUrl: `${origin}/?helloasso=success&ref=${registrationId}`,
    containsDonation: false,
    payer: {
      firstName: payerFirstName,
      lastName: payerLastName,
      email,
      dateOfBirth: birthDate || undefined,
      address: address || undefined,
      city: city || undefined,
      zipCode: zipCode || undefined,
      country: "FRA",
      companyName: env.APP_NAME || "AFFBC",
    },
    metadata: {
      registrationId,
      formula: payload.practice?.formulaCode || "",
      nom: lastName,
      prenom: firstName,
      installmentCount: installmentPlan.installmentCount,
    },
  };
  if (installmentPlan.terms.length > 0) {
    body.terms = installmentPlan.terms;
  }

  const baseUrl = env.HELLOASSO_ENV === "sandbox" ? "https://api.helloasso-sandbox.com/v5" : "https://api.helloasso.com/v5";
  const response = await fetch(
    `${baseUrl}/organizations/${env.HELLOASSO_ORGANIZATION_SLUG}/checkout-intents`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HelloAsso checkout échoué (${response.status}) : ${text}`);
  }

  const data = await response.json();
  return {
    url: data.redirectUrl || data.checkoutUrl || null,
    checkoutIntentId: data.id || null,
  };
}

// ─── Emails Brevo ─────────────────────────────────────────────────────────────

function buildEmailHtml(payload, totals, registrationId, helloAssoUrl) {
  const identity = payload.identity || {};
  const contact = payload.contact || {};
  const practice = payload.practice || {};
  const installmentCount = normalizeInstallmentCount(payload.payment?.installmentCount);
  const helloAssoLine = helloAssoUrl
    ? `<p><strong>🔗 Lien de paiement HelloAsso :</strong> <a href="${helloAssoUrl}">${helloAssoUrl}</a></p>`
    : "<p><em>⚠️ Lien HelloAsso non généré — vérifier la configuration.</em></p>";

  return `
  <html>
  <body style="font-family:Arial,sans-serif;color:#20140f;max-width:600px">
    <h2 style="color:#a23521">Nouvelle inscription AFFBC</h2>
    <p><strong>Référence dossier :</strong> ${escapeMime(registrationId)}</p>
    <hr>
    <h3>Adhérent</h3>
    <p><strong>Nom :</strong> ${escapeMime(identity.lastName)} ${escapeMime(identity.firstName)}</p>
    <p><strong>Email :</strong> ${escapeMime(contact.email)}</p>
    <p><strong>Téléphone :</strong> ${escapeMime(contact.phonePrimary)}</p>
    <p><strong>Ville :</strong> ${escapeMime(contact.city)}</p>
    <hr>
    <h3>Dossier</h3>
    <p><strong>Formule :</strong> ${escapeMime(practice.formulaCode)}</p>
    <p><strong>Type d'inscription :</strong> ${escapeMime(practice.typeInscription)}</p>
    <p><strong>Montant total :</strong> ${totals.total.toFixed(2)} €</p>
    <p><strong>Mode de paiement :</strong> HelloAsso (${installmentCount} fois${installmentCount === 1 ? "" : " prévues"}, en attente de confirmation)</p>
    ${helloAssoLine}
    <hr>
    <p style="color:#888;font-size:12px">
      La fiche adhérent et la vente tenue seront créées automatiquement dans le logiciel
      dès confirmation du paiement par HelloAsso.
    </p>
  </body>
  </html>`.trim();
}

function buildEmailText(payload, totals, registrationId, helloAssoUrl) {
  const identity = payload.identity || {};
  const contact = payload.contact || {};
  const practice = payload.practice || {};
  const installmentCount = normalizeInstallmentCount(payload.payment?.installmentCount);
  return [
    "Nouvelle inscription AFFBC",
    `Référence dossier : ${registrationId}`,
    "",
    `Adhérent : ${identity.firstName} ${identity.lastName}`,
    `Email : ${contact.email}`,
    `Téléphone : ${contact.phonePrimary}`,
    `Ville : ${contact.city}`,
    "",
    `Formule : ${practice.formulaCode}`,
    `Type : ${practice.typeInscription}`,
    `Montant total : ${totals.total.toFixed(2)} €`,
    `Mode de paiement : HelloAsso (${installmentCount} fois${installmentCount === 1 ? "" : " prévues"}, en attente)`,
    helloAssoUrl ? `Lien HelloAsso : ${helloAssoUrl}` : "⚠️ Lien HelloAsso non généré",
  ].join("\n");
}

async function sendSignupAlert(env, payload, totals, registrationId, helloAssoUrl) {
  if (!env.BREVO_API_KEY) {
    return { sent: false, reason: "brevo_api_key_missing" };
  }
  const to = env.SIGNUP_ALERT_TO || "fullfightingbons@gmail.com";
  const from = env.SIGNUP_ALERT_FROM || "contact@americanfullfightingbons.fr";
  const identity = payload.identity || {};
  const subject = `Nouvelle inscription AFFBC — ${escapeMime(identity.lastName)} ${escapeMime(identity.firstName)}`.trim();

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        name: env.SIGNUP_ALERT_SENDER_NAME || "AFFBC Inscriptions",
        email: from,
      },
      to: [{ email: to, name: env.SIGNUP_ALERT_TO_NAME || "AFFBC" }],
      subject,
      htmlContent: buildEmailHtml(payload, totals, registrationId, helloAssoUrl),
      textContent: buildEmailText(payload, totals, registrationId, helloAssoUrl),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || `brevo_http_${response.status}`);
  }
  return { sent: true, messageId: result?.messageId || null };
}

// ─── Base de données — Exercice actif ─────────────────────────────────────────

async function findActiveExercise(db) {
  const active = await db
    .prepare(`SELECT * FROM exercices WHERE statut = 'actif' ORDER BY date_debut DESC LIMIT 1`)
    .first();
  if (active?.id) return active;
  return db
    .prepare(`SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1`)
    .first();
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return badRequest("D1 binding is missing", 500);
  }

  try {
    const formData = await context.request.formData();

    // Honeypot anti-spam
    if (String(formData.get("website") || "").trim()) {
      return json({ data: { accepted: true }, error: null });
    }

    const payload = parseJsonField(formData, "payload");
    const validation = validatePayload(payload);

    // ── Vérification renouvellement ──────────────────────────────────────────
    let matchingAdherent = null;
    if (payload.practice.typeInscription === "renouvellement") {
      const renewalCheck = await findMatchingAdherent(context.env.DB, payload);
      matchingAdherent = renewalCheck.adherent;

      if (!renewalCheck.adherent) {
        return badRequest(
          "Nom et prénom non trouvés dans la base d'adhérents pour un renouvellement de licence",
        );
      }
      if (renewalCheck.reason === "birthdate_mismatch") {
        return badRequest(
          "La date de naissance ne correspond pas à celle enregistrée pour cet adhérent",
        );
      }
      if (renewalCheck.reason === "email_mismatch") {
        return badRequest("L'email ne correspond pas à celui enregistré pour cet adhérent");
      }
    }

    if (payload.practice.formulaCode === "bureau") {
      if (payload.practice.typeInscription !== "renouvellement") {
        return badRequest(
          "Le tarif Membres du Bureau est réservé aux renouvellements correspondant à un adhérent existant",
        );
      }
      if (!matchingAdherent) {
        const renewalCheck = await findMatchingAdherent(context.env.DB, payload);
        matchingAdherent = renewalCheck.adherent;
        if (!renewalCheck.renewalVerified) {
          return badRequest(
            "Impossible de vérifier l'adhérent pour appliquer le tarif Membres du Bureau",
          );
        }
      }
      if (!hasBureauDiscipline(matchingAdherent.discipline)) {
        return badRequest(
          "Le tarif Membres du Bureau n'est autorisé que pour les adhérents dont la discipline contient \"membre du bureau\"",
        );
      }
    }

    // ── Calcul des totaux ────────────────────────────────────────────────────
    const totals = calculateTotals({
      ...payload.practice,
      pricing: payload.pricing,
      clothingOrder: payload.clothingOrder,
      passRegionAmount: payload.practice?.passRegionAmount,
      passRegionEnabled: payload.practice?.passRegionEnabled,
      passportEnabled: payload.practice?.passportEnabled,
    });
    totals.certificateRequired = validation.certificateRequired;

    // ── Upload des pièces justificatives ─────────────────────────────────────
    const registrationId = crypto.randomUUID();
    const uploadedDocuments = {};

    uploadedDocuments.photoIdentity = await uploadRequiredFile(
      context.env,
      registrationId,
      formData.get("photoIdentity"),
      "photo-identite",
      true,
    );

    if (validation.certificateRequired) {
      uploadedDocuments.medicalCertificate = await uploadRequiredFile(
        context.env,
        registrationId,
        formData.get("medicalCertificate"),
        "certificat-medical",
        false,
      );
    }

    if (toBool(payload.practice?.passRegionEnabled)) {
      uploadedDocuments.passRegionDocument = await uploadRequiredFile(
        context.env,
        registrationId,
        formData.get("passRegionDocument"),
        "pass-region",
        false,
      );
    }

    if (
      payload.practice?.formulaCode === "pro" ||
      payload.practice?.formulaCode === "cse_thales"
    ) {
      uploadedDocuments.proofDocument = await uploadRequiredFile(
        context.env,
        registrationId,
        formData.get("proProofDocument"),
        "justificatif-tarif",
        false,
      );
    }

    // ── Création de la session de paiement HelloAsso (BLOQUANT) ─────────────
    const checkout = await createHelloAssoCheckout(
      context.env,
      payload,
      totals,
      registrationId,
    );
    const helloAssoUrl = checkout.url;
    const helloAssoCheckoutIntentId = checkout.checkoutIntentId;

    // ── Insertion dans inscriptions_publiques ────────────────────────────────
    const exercise = await findActiveExercise(context.env.DB);
    const now = new Date().toISOString();

    const row = {
      id: registrationId,
      nom: String(payload.identity.lastName || "").trim().toUpperCase(),
      prenom: String(payload.identity.firstName || "").trim(),
      email: String(payload.contact.email || "").trim().toLowerCase(),
      telephone: String(payload.contact.phonePrimary || "").trim(),
      naissance: payload.identity.birthDate,
      ville: String(payload.contact.city || "").trim(),
      formule_code: String(payload.practice.formulaCode || "").trim(),
      pratique_type: String(payload.practice.practiceType || "").trim(),
      montant_total: totals.total,
      paiement_mode: "helloasso",
      paiement_reference: `ONLINE-${registrationId.slice(0, 8).toUpperCase()}`,
      statut: "paiement_en_attente",
      mineur: validation.minor ? 1 : 0,
      pass_region: toBool(payload.practice.passRegionEnabled) ? 1 : 0,
      droit_image: payload.consents.imageRights === "yes" ? 1 : 0,
      reglement_accepte: toBool(payload.consents.rulesAccepted) ? 1 : 0,
      adherent_id: null,
      helloasso_checkout_intent_id: helloAssoCheckoutIntentId,
      helloasso_url: helloAssoUrl,
      dossier_json: JSON.stringify({ ...payload, computedTotals: totals }),
      documents_json: JSON.stringify(uploadedDocuments),
      exercice_id: exercise?.id || null,
      created_at: now,
      updated_at: now,
      submitted_at: now,
    };

    const columns = Object.keys(row);
    await context.env.DB.prepare(
      `INSERT INTO inscriptions_publiques (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`,
    )
      .bind(...columns.map((c) => row[c]))
      .run();

    // ── Email d'alerte ────────────────────────────────────────────────────────
    let emailAlertStatus = { sent: false, reason: "not_attempted" };
    try {
      emailAlertStatus = await sendSignupAlert(
        context.env,
        payload,
        totals,
        registrationId,
        helloAssoUrl,
      );
    } catch (error) {
      emailAlertStatus = { sent: false, reason: error.message || "send_failed" };
    }

    // ── Audit log ─────────────────────────────────────────────────────────────
    await writeAuditLog(context.env.DB, {
      action: "public.inscription_submitted",
      entityType: "inscriptions_publiques",
      entityId: registrationId,
      details: {
        email: row.email,
        total: totals.total,
        formula: row.formule_code,
        paymentMethod: "helloasso",
        helloAssoCheckoutIntentId,
        emailAlertStatus,
      },
      ip: getClientIp(context.request),
    }).catch(() => {});

    return json({
      data: {
        registrationId,
        total: totals.total,
        helloAssoUrl,
        helloAssoCheckoutIntentId,
      },
      error: null,
    });
  } catch (error) {
    return badRequest(error.message, 500);
  }
}
