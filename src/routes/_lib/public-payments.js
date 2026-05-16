import { badRequest } from "./data.js";

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
  const text = await response.text().catch(() => "");
  let result = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }
  if (!response.ok) {
    const errorMessages = Array.isArray(result?.errors)
      ? result.errors.map((entry) => entry?.message).filter(Boolean).join(" | ")
      : "";
    throw new Error(
      result?.message ||
      result?.error ||
      errorMessages ||
      `Erreur HelloAsso (${response.status}) : ${text || "réponse vide"}`,
    );
  }
  return result;
}

function badPaymentRequest(error) {
  return badRequest(error.message || "Erreur de paiement", 500);
}

export {
  badPaymentRequest,
  getRegistration,
  helloAssoRequest,
  parseDossierJson,
  updateRegistrationPayment,
};
