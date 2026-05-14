import { badRequest } from "./data.js";

function getOrigin(request) {
  return new URL(request.url).origin;
}

async function getRegistration(db, registrationId) {
  const row = await db.prepare(`SELECT * FROM inscriptions_publiques WHERE id = ? LIMIT 1`).bind(registrationId).first();
  if (!row?.id) {
    throw new Error("Inscription introuvable");
  }
  return row;
}

function parseDossierJson(registration) {
  try {
    return JSON.parse(registration?.dossier_json || "{}");
  } catch {
    return {};
  }
}

async function updateRegistrationPayment(db, registrationId, updates = {}) {
  const registration = await getRegistration(db, registrationId);
  const dossier = parseDossierJson(registration);
  const payment = {
    ...(dossier.payment || {}),
    ...(updates.payment || {}),
  };
  const nextDossier = { ...dossier, payment };
  await db.prepare(`
    UPDATE inscriptions_publiques
    SET statut = ?,
        paiement_mode = ?,
        paiement_reference = ?,
        dossier_json = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    updates.status || registration.statut,
    updates.method || registration.paiement_mode,
    updates.reference || registration.paiement_reference,
    JSON.stringify(nextDossier),
    new Date().toISOString(),
    registrationId,
  ).run();
}

function amountToCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function getHelloAssoBaseUrl(env) {
  return env.HELLOASSO_ENV === "sandbox"
    ? "https://api.helloasso-sandbox.com/v5"
    : "https://api.helloasso.com/v5";
}

async function getHelloAssoAccessToken(env) {
  if (!env.HELLOASSO_CLIENT_ID || !env.HELLOASSO_CLIENT_SECRET) {
    throw new Error("HelloAsso n'est pas configuré");
  }
  const response = await fetch(`${getHelloAssoBaseUrl(env).replace(/\/v5$/, "")}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.HELLOASSO_CLIENT_ID,
      client_secret: env.HELLOASSO_CLIENT_SECRET,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.access_token) {
    throw new Error(result?.error_description || result?.message || "Authentification HelloAsso impossible");
  }
  return result.access_token;
}

async function helloAssoRequest(env, path, method = "GET", body = null) {
  if (!env.HELLOASSO_ORGANIZATION_SLUG) {
    throw new Error("Le slug d'organisation HelloAsso est manquant");
  }
  const token = await getHelloAssoAccessToken(env);
  const response = await fetch(`${getHelloAssoBaseUrl(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || result?.error || "Erreur HelloAsso");
  }
  return result;
}

function stripeFormPayload(params = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      body.append(key, String(value));
    }
  }
  return body;
}

async function stripeRequest(env, path, params) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe n'est pas configuré");
  }
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: stripeFormPayload(params),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.error?.message || "Erreur Stripe");
  }
  return result;
}

function paypalBaseUrl(env) {
  return env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal n'est pas configuré");
  }
  const response = await fetch(`${paypalBaseUrl(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.access_token) {
    throw new Error(result?.error_description || "Authentification PayPal impossible");
  }
  return result.access_token;
}

async function paypalRequest(env, path, method = "POST", body = null) {
  const token = await getPayPalAccessToken(env);
  const response = await fetch(`${paypalBaseUrl(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || "Erreur PayPal");
  }
  return result;
}

function badPaymentRequest(error) {
  return badRequest(error.message || "Erreur de paiement", 500);
}

export {
  amountToCents,
  badPaymentRequest,
  getOrigin,
  getRegistration,
  helloAssoRequest,
  parseDossierJson,
  paypalRequest,
  stripeRequest,
  updateRegistrationPayment,
};
