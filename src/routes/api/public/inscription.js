/**
 * AFFBC — Worker Cloudflare Pages : soumission du formulaire d'inscription public
 *
 * Corrections appliquées :
 *  - Les prix sont rechargés depuis D1 (jamais du payload client)
 *  - Les erreurs internes ne sont plus exposées au client (message générique)
 *  - isMinor / calculateTotals / toBool importés depuis _lib/helpers.js
 *  - Timeout AbortSignal sur les appels HelloAsso et Brevo
 *  - Téléphone secondaire optionnel (pratiquant et contact d'urgence)
 *  - Regex email renforcée côté serveur
 *  - Email de confirmation envoyé à l'adhérent après soumission
 */

import { badRequest, json } from "../../_lib/data.js";
import { getClientIp, writeAuditLog } from "../../_lib/audit.js";
import { isMinor, calculateTotals, toBool, normalizeInstallmentCount } from "../../_lib/helpers.js";
import {
  assertAdditionalOrderItemsStock,
  assertClothingOrderStock,
  boutiqueStockRequestError,
  fetchBoutiqueClothingStock,
  fetchBoutiqueProducts,
} from "../../_lib/boutique-stock.js";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const FETCH_TIMEOUT_MS = 12_000; // 12 s pour les appels externes
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

function requireText(value, label) {
  if (!String(value || "").trim()) throw new Error(`${label} obligatoire`);
  return String(value).trim();
}

function requireDate(value, label) {
  const clean = requireText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new Error(`${label} doit être au format YYYY-MM-DD`);
  return clean;
}

function requireEmail(value) {
  const clean = requireText(value, "Email").toLowerCase();
  // Regex plus stricte : un seul @, domaine avec au moins un point, TLD ≥ 2 chars
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(clean)) {
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
  if (!raw) throw new Error("Données d'inscription manquantes");
  try { return JSON.parse(String(raw)); }
  catch { throw new Error("Payload d'inscription invalide"); }
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
  return normalizeHelloAssoName(value, fallback)
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function splitAmountCents(totalCents, count) {
  const baseAmount = Math.floor(totalCents / count);
  let remainder = totalCents - baseAmount * count;
  return Array.from({ length: count }, () => {
    const amount = baseAmount + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return amount;
  });
}

function buildInstallmentDate(monthOffset, dayOfMonth = 5) {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, Math.min(dayOfMonth, 27), 12, 0, 0),
  );
  return date.toISOString().slice(0, 10);
}

function buildInstallmentPlan(totalCents, installmentCount) {
  const count = normalizeInstallmentCount(installmentCount);
  const amounts = splitAmountCents(totalCents, count);
  return {
    installmentCount: count,
    initialAmount: amounts[0],
    terms: amounts.slice(1).map((amount, index) => ({ amount, date: buildInstallmentDate(index + 1) })),
    schedule: amounts.map((amount, index) => ({ amount, date: index === 0 ? null : buildInstallmentDate(index) })),
  };
}

// ─── Chargement des tarifs depuis D1 (source de vérité) ──────────────────────

async function loadPricingFromDb(db) {
  const DEFAULT = { base: 250, family: 200, pro: 125, cseThales: 39, bureau: 0, newMemberKit: 40, passport: 25, tshirt: 25, pantalon: 15 };
  try {
    const result = await db.prepare(`SELECT cle, valeur FROM club_info`).all();
    const info   = Object.fromEntries((result.results || []).map((r) => [r.cle, r.valeur]));
    // Tenter aussi le champ JSON centralisé (tarifs.ts)
    let jsonPricing = {};
    try { jsonPricing = info.inscription_pricing ? JSON.parse(info.inscription_pricing) : {}; } catch {}
    return {
      base:        Number(info.public_inscription_tarif_base        || jsonPricing.base        || DEFAULT.base),
      family:      Number(info.public_inscription_tarif_famille     || jsonPricing.family      || DEFAULT.family),
      pro:         Number(info.public_inscription_tarif_pro         || jsonPricing.pro         || DEFAULT.pro),
      cseThales:   Number(info.public_inscription_tarif_cse_thales  || jsonPricing.cseThales   || DEFAULT.cseThales),
      bureau:      Number(info.public_inscription_bureau            || jsonPricing.bureau      || DEFAULT.bureau),
      newMemberKit:Number(info.public_inscription_supplement_tenue  || jsonPricing.newMemberKit|| DEFAULT.newMemberKit),
      passport:    Number(info.public_inscription_tarif_passeport   || jsonPricing.passport    || DEFAULT.passport),
      tshirt:      Number(info.public_inscription_tshirt            || jsonPricing.tshirt      || DEFAULT.tshirt),
      pantalon:    Number(info.public_inscription_pantalon          || jsonPricing.pantalon    || DEFAULT.pantalon),
    };
  } catch {
    return DEFAULT;
  }
}

async function loadOrderProductsFromDb(db, env) {
  try {
    const result = await db.prepare(`SELECT cle, valeur FROM club_info WHERE cle = 'inscription_order_products'`).all();
    const raw = result?.results?.[0]?.valeur ? JSON.parse(result.results[0].valeur) : [];
    const configuredProducts = Array.isArray(raw) ? raw : [];
    let boutiqueProducts = [];
    try {
      boutiqueProducts = await fetchBoutiqueProducts(env);
    } catch (error) {
      console.warn("[inscription] Catalogue boutique indisponible:", error?.message ?? String(error));
    }
    const boutiqueById = new Map((boutiqueProducts || []).map((product) => [Number(product.productId), product]));
    return configuredProducts
      .filter((product) => product && product.active !== false)
      .map((product) => {
        const source = String(product.source || "gestion");
        const boutiqueProductId = Number(product.boutiqueProductId || 0) || null;
        const boutiqueProduct = source === "boutique" && boutiqueProductId
          ? boutiqueById.get(boutiqueProductId)
          : null;
        return {
          id: String(product.id || boutiqueProductId || crypto.randomUUID()),
          source,
          active: product.active !== false,
          boutiqueProductId,
          name: String(boutiqueProduct?.name || product.name || ""),
          description: String(boutiqueProduct?.description || product.description || ""),
          price: Number(boutiqueProduct?.price ?? product.price ?? 0),
          requiresSize: Boolean(
            product.requiresSize ||
            (Array.isArray(boutiqueProduct?.sizes) && boutiqueProduct.sizes.length > 0),
          ),
          defaultQtyNew: Math.max(0, Number(product.defaultQtyNew || 0)),
        };
      })
      .filter((product) => product.name && Number.isFinite(product.price));
  } catch {
    return [];
  }
}

// ─── Validation du payload ────────────────────────────────────────────────────

function validatePayload(payload) {
  const identity = payload?.identity || {};
  const contact  = payload?.contact  || {};
  const emergency = payload?.emergency || {};
  const legalRep  = payload?.legalRepresentative || {};
  const practice  = payload?.practice  || {};
  const health    = payload?.health    || {};
  const consents  = payload?.consents  || {};
  const payment   = payload?.payment   || {};

  const birthDate = requireDate(identity.birthDate, "Date de naissance");
  const minor     = isMinor(birthDate);

  requireText(identity.lastName,  "Nom");
  requireText(identity.firstName, "Prénom");
  requireText(identity.birthPlace,"Lieu de naissance");
  requireText(contact.address1,   "Adresse");
  requireText(contact.postalCode, "Code postal");
  requireText(contact.city,       "Ville");
  requireText(contact.phonePrimary,  "Téléphone principal");
  // phoneSecondary optionnel : on ne bloque pas si absent
  requireEmail(contact.email);
  requireText(emergency.lastName,  "Nom du contact d'urgence");
  requireText(emergency.firstName, "Prénom du contact d'urgence");
  requireText(emergency.phonePrimary,  "Téléphone principal du contact d'urgence");
  // emergencyPhoneSecondary optionnel
  requireText(practice.typeInscription,"Type d'inscription");
  requireText(practice.practiceType,   "Type de pratique");
  requireText(practice.formulaCode,    "Formule tarifaire");

  if (payment.method !== "helloasso") throw new Error("Mode de paiement invalide : seul HelloAsso est accepté");
  const installmentCount = normalizeInstallmentCount(payment.installmentCount);
  if (![1, 2, 3].includes(installmentCount)) throw new Error("Le nombre d'échéances HelloAsso est invalide");
  if (payment.payerFirstName) requireText(payment.payerFirstName, "Prénom du payeur");
  if (payment.payerLastName)  requireText(payment.payerLastName,  "Nom du payeur");

  if (minor) {
    requireText(legalRep.lastName,       "Nom du représentant légal");
    requireText(legalRep.firstName,      "Prénom du représentant légal");
    requireText(legalRep.role,           "Qualité du représentant légal");
    requireText(legalRep.signatureName,  "Signature du représentant légal");
    requireText(legalRep.city,           "Ville de l'autorisation parentale");
    requireDate(legalRep.signedAt,       "Date de l'autorisation parentale");
  }

  for (const key of REQUIRED_QS_KEYS) {
    if (health.qsSport?.[key] !== "yes" && health.qsSport?.[key] !== "no") {
      throw new Error("Toutes les réponses au questionnaire de santé sont obligatoires");
    }
  }

  if (!toBool(consents.rulesAccepted)) throw new Error("L'acceptation du règlement intérieur est obligatoire");
  if (consents.imageRights !== "yes" && consents.imageRights !== "no") throw new Error("Le choix du droit à l'image est obligatoire");
  requireText(consents.applicantSignatureName,"Signature du pratiquant");
  requireDate(consents.signedAt, "Date de signature");

  if (practice.passRegionEnabled && !/^\d{4}$/.test(String(practice.passRegionCode || "").trim())) {
    throw new Error("Le code Pass Région doit contenir 4 chiffres");
  }
  if (practice.passRegionEnabled && !String(practice.passRegionDossierNumber || "").trim()) {
    throw new Error("Le numéro de dossier Pass Région est obligatoire");
  }

  const certificateRequired = minor || REQUIRED_QS_KEYS.some((key) => health.qsSport?.[key] === "yes");
  return { birthDate, minor, certificateRequired };
}

// ─── Upload R2 ────────────────────────────────────────────────────────────────

async function uploadRequiredFile(env, registrationId, file, targetName, preferImage = false) {
  if (!(file instanceof File) || !file.size) throw new Error(`Le document ${targetName} est obligatoire`);
  if (file.size > MAX_FILE_SIZE) throw new Error(`Le document ${targetName} dépasse ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} Mo`);

  if (preferImage) {
    if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error(`Le document ${targetName} doit être une image JPEG ou PNG`);
  } else {
    if (file.type !== "application/pdf") throw new Error(`Le document ${targetName} doit être un fichier PDF`);
  }

  const bucket = preferImage ? (env.R2_STORAGE || env.R2_PDF) : (env.R2_PDF || env.R2_STORAGE);
  if (!bucket) throw new Error("Le stockage des pièces justificatives n'est pas configuré");

  const key = `public-inscriptions/${registrationId}/${targetName}${fileExtension(file.name) || (preferImage ? ".jpg" : ".pdf")}`;
  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata:   { contentType: file.type || (preferImage ? "image/jpeg" : "application/pdf") },
    customMetadata: { originalName: safeFileName(file.name || targetName) },
  });

  return {
    bucket: preferImage ? (env.R2_STORAGE ? "storage" : "fullfighting-pdf") : (env.R2_PDF ? "fullfighting-pdf" : "storage"),
    key, name: file.name || targetName, contentType: file.type || "", size: file.size || 0,
  };
}

// ─── HelloAsso ────────────────────────────────────────────────────────────────

async function getHelloAssoToken(env) {
  const baseUrl = env.HELLOASSO_ENV === "sandbox"
    ? "https://api.helloasso-sandbox.com"
    : "https://api.helloasso.com";
  const response = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id:  env.HELLOASSO_CLIENT_ID,
      client_secret: env.HELLOASSO_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HelloAsso auth échouée (${response.status}) : ${text}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("HelloAsso : token absent de la réponse d'authentification");
  return data.access_token;
}

async function createHelloAssoCheckout(env, payload, totals, registrationId) {
  if (!env.HELLOASSO_CLIENT_ID || !env.HELLOASSO_CLIENT_SECRET || !env.HELLOASSO_ORGANIZATION_SLUG) {
    throw new Error("HelloAsso n'est pas configuré (variables d'environnement manquantes).");
  }

  const amountCents = Math.round(totals.total * 100);
  if (amountCents <= 0) throw new Error("Le montant du dossier est nul — impossible de créer un paiement HelloAsso.");

  const installmentPlan = buildInstallmentPlan(amountCents, payload.payment?.installmentCount);
  payload.payment = { ...(payload.payment || {}), installmentCount: installmentPlan.installmentCount, schedule: installmentPlan.schedule };

  const token = await getHelloAssoToken(env);
  const origin = String(env.PUBLIC_ORIGIN || "https://inscription.americanfullfightingbons.fr").replace(/\/+$/, "");

  const firstName = String(payload.identity?.firstName || "").trim();
  const lastName  = String(payload.identity?.lastName  || "").trim();
  const legalRep  = payload.legalRepresentative || {};
  let payerFirstName = String(payload.payment?.payerFirstName || "").trim();
  let payerLastName  = String(payload.payment?.payerLastName  || "").trim();
  if (!payerFirstName || !payerLastName) {
    payerFirstName = String(legalRep.firstName || payerFirstName || firstName).trim();
    payerLastName  = String(legalRep.lastName  || payerLastName  || lastName ).trim();
  }
  payerFirstName = normalizeHelloAssoFirstName(payerFirstName, firstName) || "Adherent";
  payerLastName  = normalizeHelloAssoLastName (payerLastName,  lastName)  || "AFFBC";

  const body = {
    totalAmount:   amountCents,
    initialAmount: installmentPlan.initialAmount,
    itemName: `Inscription AFFBC — ${firstName} ${lastName}`.trim(),
    backUrl:   `${origin}/?helloasso=cancel`,
    errorUrl:  `${origin}/?helloasso=cancel`,
    returnUrl: `${origin}/?helloasso=success&ref=${registrationId}`,
    containsDonation: false,
    payer: {
      firstName: payerFirstName,
      lastName:  payerLastName,
      email:     String(payload.contact?.email    || "").trim(),
      dateOfBirth: String(payload.identity?.birthDate || "").trim() || undefined,
      address:   String(payload.contact?.address1 || "").trim()    || undefined,
      city:      String(payload.contact?.city     || "").trim()    || undefined,
      zipCode:   String(payload.contact?.postalCode|| "").trim()   || undefined,
      country:   "FRA",
      companyName: env.APP_NAME || "AFFBC",
    },
    metadata: {
      registrationId,
      formula: payload.practice?.formulaCode || "",
      nom:     lastName,
      prenom:  firstName,
      installmentCount: installmentPlan.installmentCount,
    },
  };
  if (installmentPlan.terms.length > 0) body.terms = installmentPlan.terms;

  const baseUrl = env.HELLOASSO_ENV === "sandbox"
    ? "https://api.helloasso-sandbox.com/v5"
    : "https://api.helloasso.com/v5";
  const response = await fetch(
    `${baseUrl}/organizations/${env.HELLOASSO_ORGANIZATION_SLUG}/checkout-intents`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HelloAsso checkout échoué (${response.status}) : ${text}`);
  }
  const data = await response.json();
  return { url: data.redirectUrl || data.checkoutUrl || null, checkoutIntentId: data.id || null };
}

// ─── Emails Brevo ─────────────────────────────────────────────────────────────

function buildEmailHtml(payload, totals, registrationId, helloAssoUrl) {
  const identity  = payload.identity || {};
  const contact   = payload.contact  || {};
  const practice  = payload.practice || {};
  const count     = normalizeInstallmentCount(payload.payment?.installmentCount);
  const haLink    = helloAssoUrl
    ? `<p><strong>🔗 Lien HelloAsso :</strong> <a href="${helloAssoUrl}">${helloAssoUrl}</a></p>`
    : "<p><em>⚠️ Lien HelloAsso non généré.</em></p>";
  return `
  <html><body style="font-family:Arial,sans-serif;color:#20140f;max-width:600px">
    <h2 style="color:#a23521">Nouvelle inscription AFFBC</h2>
    <p><strong>Référence :</strong> ${escapeMime(registrationId)}</p><hr>
    <h3>Adhérent</h3>
    <p><strong>Nom :</strong> ${escapeMime(identity.lastName)} ${escapeMime(identity.firstName)}</p>
    <p><strong>Email :</strong> ${escapeMime(contact.email)}</p>
    <p><strong>Téléphone :</strong> ${escapeMime(contact.phonePrimary)}</p>
    <p><strong>Ville :</strong> ${escapeMime(contact.city)}</p><hr>
    <h3>Dossier</h3>
    <p><strong>Formule :</strong> ${escapeMime(practice.formulaCode)}</p>
    <p><strong>Type :</strong> ${escapeMime(practice.typeInscription)}</p>
    <p><strong>Total :</strong> ${totals.total.toFixed(2)} €</p>
    <p><strong>Paiement :</strong> HelloAsso (${count} fois${count === 1 ? "" : " prévues"}, en attente)</p>
    ${haLink}
    <hr><p style="color:#888;font-size:12px">La fiche adhérent sera créée après confirmation du paiement.</p>
  </body></html>`.trim();
}

function buildEmailText(payload, totals, registrationId, helloAssoUrl) {
  const identity = payload.identity || {};
  const contact  = payload.contact  || {};
  const practice = payload.practice || {};
  const count    = normalizeInstallmentCount(payload.payment?.installmentCount);
  return [
    "Nouvelle inscription AFFBC",
    `Référence : ${registrationId}`,
    "",
    `Adhérent : ${identity.firstName} ${identity.lastName}`,
    `Email : ${contact.email}`,
    `Téléphone : ${contact.phonePrimary}`,
    `Ville : ${contact.city}`,
    "",
    `Formule : ${practice.formulaCode}`,
    `Type : ${practice.typeInscription}`,
    `Total : ${totals.total.toFixed(2)} €`,
    `Paiement : HelloAsso (${count} fois${count === 1 ? "" : " prévues"}, en attente)`,
    helloAssoUrl ? `Lien HelloAsso : ${helloAssoUrl}` : "⚠️ Lien HelloAsso non généré",
  ].join("\n");
}

// ─── Email de confirmation à l'adhérent ──────────────────────────────────────

function buildConfirmationEmailHtml(payload, totals, registrationId) {
  const identity = payload.identity || {};
  const contact  = payload.contact  || {};
  const practice = payload.practice || {};
  const count    = normalizeInstallmentCount(payload.payment?.installmentCount);
  return `
  <html><body style="font-family:Arial,sans-serif;color:#20140f;max-width:600px">
    <h2 style="color:#a23521">Votre inscription AFFBC a bien été reçue</h2>
    <p>Bonjour ${escapeMime(identity.firstName)},</p>
    <p>Nous avons bien reçu votre dossier d'inscription au club <strong>AMERICAN FULL FIGHTING BONS EN CHABLAIS</strong>.</p>
    <p><strong>Référence :</strong> ${escapeMime(registrationId)}</p><hr>
    <h3>Récapitulatif</h3>
    <p><strong>Formule :</strong> ${escapeMime(practice.formulaCode)}</p>
    <p><strong>Type :</strong> ${escapeMime(practice.typeInscription)}</p>
    <p><strong>Montant total :</strong> ${totals.total.toFixed(2)} €</p>
    <p><strong>Paiement :</strong> HelloAsso (${count} fois${count === 1 ? "" : " prévues"})</p>
    <hr>
    <p>Votre dossier sera validé après confirmation du paiement HelloAsso. Vous recevrez votre licence FFK une fois le dossier complet.</p>
    <p>En cas de question : <a href="mailto:fullfightingbons@gmail.com">fullfightingbons@gmail.com</a></p>
    <p style="color:#888;font-size:12px">AMERICAN FULL FIGHTING BONS EN CHABLAIS — 15 Place Henri Boucher, 74890 Bons En Chablais</p>
  </body></html>`.trim();
}

function buildConfirmationEmailText(payload, totals, registrationId) {
  const identity = payload.identity || {};
  const practice = payload.practice || {};
  const count    = normalizeInstallmentCount(payload.payment?.installmentCount);
  return [
    `Bonjour ${identity.firstName},`,
    "",
    "Nous avons bien reçu votre dossier d'inscription au club AMERICAN FULL FIGHTING BONS EN CHABLAIS.",
    `Référence : ${registrationId}`,
    "",
    `Formule : ${practice.formulaCode}`,
    `Type : ${practice.typeInscription}`,
    `Montant total : ${totals.total.toFixed(2)} €`,
    `Paiement : HelloAsso (${count} fois${count === 1 ? "" : " prévues"})`,
    "",
    "Votre dossier sera validé après confirmation du paiement HelloAsso.",
    "En cas de question : fullfightingbons@gmail.com",
  ].join("\n");
}

async function sendConfirmationEmail(env, payload, totals, registrationId) {
  if (!env.BREVO_API_KEY) return { sent: false, reason: "brevo_api_key_missing" };
  const adherentEmail = String(payload.contact?.email || "").trim().toLowerCase();
  if (!adherentEmail) return { sent: false, reason: "no_adherent_email" };
  const from    = env.SIGNUP_ALERT_FROM || "contact@americanfullfightingbons.fr";
  const identity = payload.identity || {};
  const subject  = "Confirmation de votre inscription AFFBC";

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: env.SIGNUP_ALERT_SENDER_NAME || "AFFBC Inscriptions", email: from },
      to: [{ email: adherentEmail, name: `${escapeMime(identity.firstName)} ${escapeMime(identity.lastName)}`.trim() }],
      subject,
      htmlContent: buildConfirmationEmailHtml(payload, totals, registrationId),
      textContent: buildConfirmationEmailText(payload, totals, registrationId),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || `brevo_http_${response.status}`);
  return { sent: true, messageId: result?.messageId || null };
}

// ─── Email d'alerte club ──────────────────────────────────────────────────────

async function sendSignupAlert(env, payload, totals, registrationId, helloAssoUrl) {
  if (!env.BREVO_API_KEY) return { sent: false, reason: "brevo_api_key_missing" };
  const to      = env.SIGNUP_ALERT_TO   || "fullfightingbons@gmail.com";
  const from    = env.SIGNUP_ALERT_FROM || "contact@americanfullfightingbons.fr";
  const identity = payload.identity || {};
  const adherentEmail = String(payload.contact?.email || "").trim().toLowerCase();
  const subject  = `Nouvelle inscription AFFBC — ${escapeMime(identity.lastName)} ${escapeMime(identity.firstName)}`.trim();
  const recipients = [
    { email: to, name: env.SIGNUP_ALERT_TO_NAME || "AFFBC" },
    adherentEmail
      ? { email: adherentEmail, name: `${escapeMime(identity.firstName)} ${escapeMime(identity.lastName)}`.trim() || adherentEmail }
      : null,
  ].filter((entry, index, array) => entry && array.findIndex((item) => item?.email === entry.email) === index);

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: env.SIGNUP_ALERT_SENDER_NAME || "AFFBC Inscriptions", email: from },
      to: recipients,
      subject,
      htmlContent: buildEmailHtml(payload, totals, registrationId, helloAssoUrl),
      textContent: buildEmailText(payload, totals, registrationId, helloAssoUrl),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || `brevo_http_${response.status}`);
  return { sent: true, messageId: result?.messageId || null };
}

// ─── Base de données ──────────────────────────────────────────────────────────

async function findActiveExercise(db) {
  const active = await db.prepare(`SELECT * FROM exercices WHERE statut = 'actif' ORDER BY date_debut DESC LIMIT 1`).first();
  if (active?.id) return active;
  return db.prepare(`SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1`).first();
}

function normalizePersonName(value) { return String(value || "").trim(); }
function normalizeEmail(value)      { return String(value || "").trim().toLowerCase(); }
function hasBureauDiscipline(discipline) { return String(discipline || "").toLowerCase().includes("membre du bureau"); }

async function findMatchingAdherent(db, payload) {
  const nom      = String(payload.identity?.lastName  || "").trim().toUpperCase();
  const prenom   = normalizePersonName(payload.identity?.firstName);
  const birthDate = String(payload.identity?.birthDate || "").trim();
  const email    = normalizeEmail(payload.contact?.email);
  if (!nom || !prenom || !birthDate || !email) return { adherent: null, renewalVerified: false, reason: "missing_fields" };

  const adherent = await db
    .prepare(`SELECT id, nom, prenom, naissance, email, discipline FROM adherents WHERE nom = ? AND prenom = ?`)
    .bind(nom, prenom)
    .first();
  if (!adherent)                                        return { adherent: null,  renewalVerified: false, reason: "not_found" };
  if (adherent.naissance !== birthDate)                 return { adherent,        renewalVerified: false, reason: "birthdate_mismatch" };
  if (normalizeEmail(adherent.email) !== email)         return { adherent,        renewalVerified: false, reason: "email_mismatch" };
  return { adherent, renewalVerified: true, reason: null };
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  if (!context.env.DB) return badRequest("D1 binding is missing", 500);

  try {
    const formData = await context.request.formData();

    // Honeypot anti-spam
    if (String(formData.get("website") || "").trim()) {
      return json({ data: { accepted: true }, error: null });
    }

    const payload    = parseJsonField(formData, "payload");
    const validation = validatePayload(payload);

    // ── Vérification renouvellement ──────────────────────────────────────────
    let matchingAdherent = null;
    if (payload.practice.typeInscription === "renouvellement") {
      const renewalCheck = await findMatchingAdherent(context.env.DB, payload);
      matchingAdherent = renewalCheck.adherent;
      if (!renewalCheck.adherent)                          return badRequest("Nom et prénom non trouvés pour un renouvellement");
      if (renewalCheck.reason === "birthdate_mismatch")    return badRequest("La date de naissance ne correspond pas à la fiche existante");
      if (renewalCheck.reason === "email_mismatch")        return badRequest("L'email ne correspond pas à la fiche existante");
    }

    if (payload.practice.formulaCode === "bureau") {
      if (payload.practice.typeInscription !== "renouvellement") return badRequest("Le tarif Membres du Bureau est réservé aux renouvellements");
      if (!matchingAdherent) {
        const renewalCheck = await findMatchingAdherent(context.env.DB, payload);
        matchingAdherent   = renewalCheck.adherent;
        if (!renewalCheck.renewalVerified) return badRequest("Impossible de vérifier l'adhérent pour le tarif Membres du Bureau");
      }
      if (!hasBureauDiscipline(matchingAdherent.discipline)) {
        return badRequest("Le tarif Membres du Bureau n'est autorisé que pour les adhérents avec la discipline \"membre du bureau\"");
      }
    }

    // ── Calcul des totaux depuis D1 (jamais depuis payload.pricing) ──────────
    const serverPricing = await loadPricingFromDb(context.env.DB);
    const extraProductCatalog = await loadOrderProductsFromDb(context.env.DB, context.env);
    const totals = calculateTotals(
      { ...payload.practice, passRegionAmount: payload.practice?.passRegionAmount },
      serverPricing,
      payload.clothingOrder,
      payload.extraOrderItems,
      extraProductCatalog,
    );
    totals.certificateRequired = validation.certificateRequired;

    try {
      const clothingStock = await fetchBoutiqueClothingStock(context.env);
      assertClothingOrderStock(clothingStock, payload.clothingOrder);
      const boutiqueProducts = await fetchBoutiqueProducts(context.env);
      assertAdditionalOrderItemsStock(boutiqueProducts, totals.orderItems);
    } catch (error) {
      return boutiqueStockRequestError(error);
    }

    // ── Upload des pièces justificatives ─────────────────────────────────────
    const registrationId    = crypto.randomUUID();
    const uploadedDocuments = {};

    uploadedDocuments.photoIdentity = await uploadRequiredFile(context.env, registrationId, formData.get("photoIdentity"), "photo-identite", true);

    if (validation.certificateRequired) {
      uploadedDocuments.medicalCertificate = await uploadRequiredFile(context.env, registrationId, formData.get("medicalCertificate"), "certificat-medical", false);
    }
    if (toBool(payload.practice?.passRegionEnabled)) {
      uploadedDocuments.passRegionDocument = await uploadRequiredFile(context.env, registrationId, formData.get("passRegionDocument"), "pass-region", false);
    }
    if (payload.practice?.formulaCode === "pro" || payload.practice?.formulaCode === "cse_thales") {
      uploadedDocuments.proofDocument = await uploadRequiredFile(context.env, registrationId, formData.get("proProofDocument"), "justificatif-tarif", false);
    }

    // ── Création de la session de paiement HelloAsso ─────────────────────────
    const checkout = await createHelloAssoCheckout(context.env, payload, totals, registrationId);
    const helloAssoUrl             = checkout.url;
    const helloAssoCheckoutIntentId = checkout.checkoutIntentId;

    // ── Insertion dans inscriptions_publiques ────────────────────────────────
    const exercise = await findActiveExercise(context.env.DB);
    const now      = new Date().toISOString();

    const row = {
      id:                          registrationId,
      nom:                         String(payload.identity.lastName  || "").trim().toUpperCase(),
      prenom:                      String(payload.identity.firstName || "").trim(),
      email:                       String(payload.contact.email      || "").trim().toLowerCase(),
      telephone:                   String(payload.contact.phonePrimary|| "").trim(),
      naissance:                   payload.identity.birthDate,
      ville:                       String(payload.contact.city       || "").trim(),
      formule_code:                String(payload.practice.formulaCode || "").trim(),
      pratique_type:               String(payload.practice.practiceType|| "").trim(),
      montant_total:               totals.total,
      paiement_mode:               "helloasso",
      paiement_reference:          `ONLINE-${registrationId.slice(0, 8).toUpperCase()}`,
      statut:                      "paiement_en_attente",
      mineur:                      validation.minor ? 1 : 0,
      pass_region:                 toBool(payload.practice.passRegionEnabled) ? 1 : 0,
      droit_image:                 payload.consents.imageRights === "yes" ? 1 : 0,
      reglement_accepte:           toBool(payload.consents.rulesAccepted) ? 1 : 0,
      adherent_id:                 null,
      helloasso_checkout_intent_id: helloAssoCheckoutIntentId,
      helloasso_url:               helloAssoUrl,
      dossier_json:                JSON.stringify({ ...payload, computedTotals: totals }),
      documents_json:              JSON.stringify(uploadedDocuments),
      exercice_id:                 exercise?.id || null,
      created_at:                  now,
      updated_at:                  now,
      submitted_at:                now,
    };

    const columns = Object.keys(row);
    await context.env.DB.prepare(
      `INSERT INTO inscriptions_publiques (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).bind(...columns.map((c) => row[c])).run();

    // ── Email d'alerte club ───────────────────────────────────────────────────
    let emailAlertStatus = { sent: false, reason: "not_attempted" };
    try {
      emailAlertStatus = await sendSignupAlert(context.env, payload, totals, registrationId, helloAssoUrl);
    } catch (error) {
      emailAlertStatus = { sent: false, reason: error.message || "send_failed" };
    }

    // ── Email de confirmation à l'adhérent ────────────────────────────────────
    let confirmationEmailStatus = { sent: false, reason: "not_attempted" };
    try {
      confirmationEmailStatus = await sendConfirmationEmail(context.env, payload, totals, registrationId);
    } catch (error) {
      confirmationEmailStatus = { sent: false, reason: error.message || "send_failed" };
    }

    // ── Audit log ─────────────────────────────────────────────────────────────
    await writeAuditLog(context.env.DB, {
      action:     "public.inscription_submitted",
      entityType: "inscriptions_publiques",
      entityId:   registrationId,
      details:    { email: row.email, total: totals.total, formula: row.formule_code, paymentMethod: "helloasso", helloAssoCheckoutIntentId, emailAlertStatus, confirmationEmailStatus },
      ip:         getClientIp(context.request),
    }).catch(() => {});

    return json({ data: { registrationId, total: totals.total, helloAssoUrl, helloAssoCheckoutIntentId }, error: null });

  } catch (error) {
    // Erreurs métier (validation, fichiers) → message lisible ; erreurs inattendues → message générique
    const isBusinessError = error.message && error.message.length < 200;
    console.error("[inscription] Erreur:", error?.message ?? String(error));
    return badRequest(
      isBusinessError ? error.message : "Une erreur est survenue. Veuillez réessayer ou contacter le club.",
      isBusinessError ? 400 : 500,
    );
  }
}
