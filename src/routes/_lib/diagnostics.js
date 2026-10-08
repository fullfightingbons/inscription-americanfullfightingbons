/**
 * AFFBC — Diagnostic des blocages (inscription, paiement, finalisation, cron)
 *
 * Pourquoi ce module existe : jusqu'ici, quand une étape échouait (création du
 * checkout HelloAsso, finalisation après paiement, webhook…), la VRAIE erreur
 * (code HTTP + corps de la réponse HelloAsso) n'existait que dans un
 * `console.error` du Worker, et l'adhérent ne voyait qu'un message générique.
 * Impossible de savoir pourquoi un adhérent était bloqué sans aller fouiller
 * les logs Cloudflare au bon moment.
 *
 * Ce module centralise, pour TOUTES les étapes bloquantes :
 *   1. des erreurs typées (`HelloAssoApiError`) qui gardent le code HTTP, le
 *      point d'appel et les champs refusés par HelloAsso ;
 *   2. une classification (`classifyFailure`) : HelloAsso refuse les données,
 *      identifiants invalides, quota, indisponibilité, timeout, base D1…
 *   3. un journal d'incidents dans `audit_logs` (`public.erreur` pour une
 *      panne technique, `public.refus` pour un refus métier), avec une
 *      référence courte `INC-XXXXXX` que l'adhérent peut citer au club ;
 *   4. un message précis et actionnable pour l'adhérent, qui se termine
 *      toujours par cette référence ;
 *   5. une alerte e-mail au club (Brevo) pour les pannes techniques,
 *      dédupliquée pour ne pas inonder la boîte lors d'une panne HelloAsso.
 *
 * `reportFailure` ne lève JAMAIS : le diagnostic ne doit pas aggraver l'erreur
 * qu'il décrit.
 */

import { getClientIp, writeAuditLog } from "./audit.js";

export const INCIDENT_ACTION = "public.erreur";
export const REFUSAL_ACTION = "public.refus";

const TEXT_LIMIT = 600;
const ALERT_DEDUPE_MINUTES = 30;
const ALERT_TIMEOUT_MS = 6_000;
const INCIDENT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans 0/O, 1/I/L

// Libellés des étapes (journal, e-mail d'alerte, endpoint admin).
export const STEP_LABELS = {
  "inscription.parse": "Lecture du formulaire",
  "inscription.validation": "Contrôle des informations saisies",
  "inscription.blacklist": "Contrôle d'éligibilité",
  "inscription.renewal_check": "Vérification du renouvellement",
  "inscription.pricing": "Calcul du tarif",
  "inscription.certificate": "Certificat médical",
  "inscription.stock": "Stock de la tenue / boutique",
  "inscription.draft_insert": "Enregistrement du dossier",
  "inscription.upload": "Envoi des pièces justificatives",
  "inscription.free_registration": "Validation d'une inscription gratuite",
  "inscription.helloasso_checkout": "Création du paiement HelloAsso",
  "inscription.finalize": "Finalisation de l'envoi du dossier",
  "resume.lookup": "Reprise : recherche du dossier",
  "resume.state": "Reprise : état du dossier",
  "resume.status_check": "Reprise : vérification d'un paiement précédent",
  "resume.helloasso_checkout": "Reprise : création du nouveau paiement HelloAsso",
  "resume.db_update": "Reprise : mise à jour du dossier",
  "status.fetch_intent": "Vérification du paiement auprès de HelloAsso",
  "status.lock": "Verrou de traitement du paiement",
  "status.finalize": "Finalisation après paiement (fiche adhérent, comptabilité, PDF, e-mail)",
  "webhook.auth": "Webhook HelloAsso : authentification",
  "webhook.sync": "Webhook HelloAsso : synchronisation du paiement",
  "webhook.parse": "Webhook HelloAsso : lecture de la notification",
  "cron.cleanup": "Purge des dossiers abandonnés",
  "worker.unhandled": "Erreur non gérée du Worker",
  "health.config": "Contrôle de configuration",
  "health.database": "Contrôle de la base D1",
  "health.helloasso_auth": "Contrôle de l'authentification HelloAsso",
};

export function stepLabel(step) {
  return STEP_LABELS[step] || String(step || "étape inconnue");
}

// ─── Erreurs typées ───────────────────────────────────────────────────────────

/**
 * Erreur d'un appel HelloAsso (ou de la configuration nécessaire à l'appeler).
 * Garde tout ce qu'il faut pour comprendre le refus sans relire les logs.
 */
export class HelloAssoApiError extends Error {
  constructor(message, {
    httpStatus = null,
    endpoint = "",
    providerMessage = "",
    fieldErrors = [],
    kind = null,
  } = {}) {
    super(message);
    this.name = "HelloAssoApiError";
    this.httpStatus = httpStatus;
    this.endpoint = endpoint;
    this.providerMessage = providerMessage;
    this.fieldErrors = fieldErrors;
    this.kind = kind; // "config" quand l'appel n'a même pas pu partir
  }
}

function clip(value, limit = TEXT_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Extrait les champs refusés d'un corps d'erreur HelloAsso. Tolère les formes
 * rencontrées dans la pratique : `{ errors: [{ field, message, code }] }`,
 * `{ errors: { "payer.email": ["…"] } }` ou `{ message, code }`.
 */
export function extractFieldErrors(parsed) {
  const out = [];
  const push = (field, message, code) => {
    if (field || message || code) {
      out.push({ field: clip(field, 80), message: clip(message, 200), code: clip(code, 60) });
    }
  };
  const errors = parsed?.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "string") push("", entry, "");
      else push(entry?.field || entry?.propertyName || entry?.property || entry?.path, entry?.message || entry?.errorMessage, entry?.code || entry?.errorCode);
    }
  } else if (errors && typeof errors === "object") {
    for (const [field, value] of Object.entries(errors)) {
      push(field, Array.isArray(value) ? value.join(" ; ") : value, "");
    }
  }
  if (!out.length && parsed?.message) push("", parsed.message, parsed.code || parsed.error || "");
  return out.slice(0, 10);
}

/**
 * Construit une HelloAssoApiError à partir d'une réponse HTTP non-OK.
 * `what` : « checkout », « auth »… (reprend le format de message historique,
 * « HelloAsso checkout échoué (400) : … », pour ne rien casser).
 */
export async function helloAssoErrorFromResponse(response, { what, endpoint = "" }) {
  const text = await response.text().catch(() => "");
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const fieldErrors = extractFieldErrors(parsed);
  const providerMessage = clip(
    fieldErrors.map((e) => [e.field, e.message || e.code].filter(Boolean).join(" : ")).join(" | ") || text,
  );
  return new HelloAssoApiError(
    `HelloAsso ${what} échoué (${response.status}) : ${text}`,
    { httpStatus: response.status, endpoint, providerMessage, fieldErrors },
  );
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Range une erreur dans une catégorie exploitable.
 * `technical: false` = refus métier (message lisible destiné à l'adhérent).
 */
export function classifyFailure(error) {
  if (error instanceof HelloAssoApiError) {
    const status = error.httpStatus;
    let kind = error.kind;
    if (!kind) {
      if (status === 400 || status === 422) kind = "provider_rejected_data";
      else if (status === 401 || status === 403) kind = "provider_auth";
      else if (status === 404) kind = "provider_not_found";
      else if (status === 429) kind = "provider_rate_limit";
      else if (status >= 500) kind = "provider_down";
      else kind = "provider_error";
    }
    return { kind, httpStatus: status ?? null, technical: true };
  }

  const name = String(error?.name || "");
  const message = String(error?.message ?? error ?? "");
  if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout", httpStatus: null, technical: true };
  if (/D1_|SQLITE_|no such table|no such column/i.test(message)) return { kind: "database", httpStatus: null, technical: true };
  if (/Cannot read propert|is not a function|is not defined|of undefined|of null|Unexpected token/i.test(message)) {
    return { kind: "bug", httpStatus: null, technical: true };
  }
  if (error instanceof TypeError || /fetch failed|network connection|connection lost/i.test(message)) {
    return { kind: "network", httpStatus: null, technical: true };
  }
  return { kind: "business", httpStatus: null, technical: false };
}

// ─── Messages destinés à l'adhérent ───────────────────────────────────────────

const FIELD_LABELS = [
  [/dateofbirth|birth/i, "date de naissance du payeur"],
  [/email/i, "adresse e-mail"],
  [/firstname/i, "prénom du payeur"],
  [/lastname/i, "nom du payeur"],
  [/zipcode|postal/i, "code postal"],
  [/city/i, "ville"],
  [/address/i, "adresse"],
  [/country/i, "pays"],
  [/amount|terms|installment/i, "montant ou échéancier de paiement"],
];

export function humanizeFields(fieldErrors = []) {
  const labels = [];
  for (const entry of fieldErrors) {
    const found = FIELD_LABELS.find(([re]) => re.test(entry.field || ""));
    if (found && !labels.includes(found[1])) labels.push(found[1]);
  }
  return labels;
}

/**
 * Message précis pour l'adhérent. Se termine toujours par la référence
 * d'incident. `flow` : "inscription" | "resume" | "status".
 */
export function buildMemberMessage({ flow, step, classification, fieldErrors = [], incidentId, paid = false, businessMessage = "" }) {
  const ref = `(Référence : ${incidentId})`;

  // Paiement déjà encaissé mais dossier non finalisé : le plus important à dire.
  if (paid) {
    return "Votre paiement a bien été reçu par HelloAsso, mais la validation de votre dossier a rencontré un problème technique. "
      + `Ne payez pas une seconde fois : le club a été prévenu et finalisera votre dossier. ${ref}`;
  }

  if (!classification.technical) return `${businessMessage} ${ref}`.trim();

  const keep = flow === "resume"
    ? " Votre dossier et vos documents restent enregistrés."
    : flow === "inscription" ? " Votre dossier n'a pas été enregistré : vous pouvez réessayer." : "";
  const where = `à l'étape « ${stepLabel(step)} »`;

  switch (classification.kind) {
    case "provider_rejected_data": {
      const fields = humanizeFields(fieldErrors);
      const detail = fields.length ? ` (${fields.join(", ")})` : "";
      return `HelloAsso a refusé d'ouvrir le paiement car une information du dossier est invalide${detail}. `
        + `Le club en a été informé et vous recontactera.${keep} ${ref}`;
    }
    case "provider_auth":
    case "config":
      return `Le paiement en ligne est momentanément indisponible (problème de configuration côté club). Le club a été prévenu automatiquement.${keep} ${ref}`;
    case "provider_rate_limit":
      return `HelloAsso reçoit trop de demandes en ce moment. Patientez une minute puis réessayez.${keep} ${ref}`;
    case "provider_down":
    case "provider_error":
    case "provider_not_found":
    case "timeout":
    case "network":
      return `Le service de paiement HelloAsso ne répond pas correctement pour le moment. Réessayez dans quelques minutes.${keep} ${ref}`;
    case "database":
      return `Notre base de données est momentanément indisponible. Réessayez dans quelques minutes.${keep} ${ref}`;
    default:
      return `Une erreur technique est survenue ${where}. Le club a été prévenu.${keep} ${ref}`;
  }
}

function suggestedHttpStatus(classification) {
  if (!classification.technical) return 400;
  return classification.kind.startsWith("provider") || classification.kind === "timeout" || classification.kind === "network" ? 502 : 500;
}

// ─── Alerte e-mail au club ────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function recentIncidentExists(db, { step, kind, registrationId, paid, minutes }) {
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  // Paiement encaissé : une alerte par dossier. Sinon : une alerte par (étape, type)
  // pour ne pas recevoir un e-mail par adhérent pendant une panne HelloAsso.
  const sql = paid
    ? `SELECT 1 AS found FROM audit_logs WHERE action = ? AND created_at >= ? AND entity_id = ? AND json_extract(details, '$.step') = ? LIMIT 1`
    : `SELECT 1 AS found FROM audit_logs WHERE action = ? AND created_at >= ? AND json_extract(details, '$.step') = ? AND json_extract(details, '$.kind') = ? LIMIT 1`;
  const binds = paid ? [INCIDENT_ACTION, cutoff, registrationId, step] : [INCIDENT_ACTION, cutoff, step, kind];
  try {
    const row = await db.prepare(sql).bind(...binds).first();
    return Boolean(row?.found);
  } catch {
    return false;
  }
}

async function sendIncidentAlert(env, d) {
  if (!env.BREVO_API_KEY) return { sent: false, reason: "brevo_api_key_missing" };
  const to = env.SIGNUP_ALERT_TO || "club@americanfullfightingbons.fr";
  const from = env.SIGNUP_ALERT_FROM || "contact@americanfullfightingbons.fr";
  const label = stepLabel(d.step);
  const subject = d.paid
    ? `⚠️ AFFBC — paiement encaissé, dossier NON finalisé (${d.incidentId})`
    : `AFFBC inscription — blocage « ${label} » (${d.incidentId})`;
  const rows = [
    ["Référence incident", d.incidentId],
    ["Étape", `${label} [${d.step}]`],
    ["Type", d.kind],
    ["Code HTTP HelloAsso", d.httpStatus ?? "—"],
    ["Appel", d.endpoint || "—"],
    ["Réponse HelloAsso", d.providerMessage || "—"],
    ["Erreur", d.errorMessage || "—"],
    ["Dossier (référence)", d.registrationId || "—"],
    ["Date", d.at],
  ];
  const hint = d.paid
    ? "Le paiement est enregistré chez HelloAsso mais la fiche adhérent n'a pas été créée. Ne PAS refaire payer l'adhérent : relancer la finalisation (GET /api/public/payment/helloasso/status?registrationId=…) ou la traiter à la main dans gestion."
    : "Le détail complet est dans audit_logs (action « public.erreur ») et via GET /api/admin/inscription/incidents.";
  const html = `<html><body style="font-family:Arial,sans-serif;color:#20140f;max-width:640px">
    <h2 style="color:#a23521">${escapeHtml(subject)}</h2>
    <table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`).join("")}</table>
    <p>${escapeHtml(hint)}</p></body></html>`;
  const text = [subject, "", ...rows.map(([k, v]) => `${k} : ${v}`), "", hint].join("\n");

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: env.SIGNUP_ALERT_SENDER_NAME || "AFFBC Inscriptions", email: from },
      to: [{ email: to, name: env.SIGNUP_ALERT_TO_NAME || "AFFBC" }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
  });
  if (!response.ok) return { sent: false, reason: `brevo_http_${response.status}` };
  return { sent: true };
}

// ─── Point d'entrée ───────────────────────────────────────────────────────────

function newIncidentId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `INC-${Array.from(bytes, (b) => INCIDENT_ALPHABET[b % INCIDENT_ALPHABET.length]).join("")}`;
}

/**
 * Consigne un blocage et prépare la réponse à renvoyer.
 *
 * @param {{ env: object, request?: Request }} context
 * @param {object} opts
 * @param {string} opts.step           clé de STEP_LABELS (ex. "resume.helloasso_checkout")
 * @param {unknown} opts.error         l'erreur capturée (ou un Error construit pour un refus)
 * @param {string} [opts.flow]         "inscription" | "resume" | "status" | "webhook" | "cron" | "health"
 * @param {string|null} [opts.registrationId]
 * @param {boolean} [opts.paid]        le paiement HelloAsso est déjà encaissé
 * @param {boolean} [opts.refusal]     refus métier attendu (pas d'alerte, action public.refus)
 * @param {boolean} [opts.alert]       forcer / interdire l'alerte (par défaut : pannes techniques)
 * @param {boolean} [opts.technical]   traiter une Error simple comme une panne (cron, webhook…)
 * @param {string} [opts.kind]         type à enregistrer pour cette panne (avec `technical`)
 * @param {object} [opts.extra]        détails non personnels utiles au diagnostic
 * @returns {Promise<{ incidentId: string, kind: string, technical: boolean, status: number, message: string }>}
 */
export async function reportFailure(context, opts = {}) {
  const env = context?.env || {};
  const { step = "worker.unhandled", error, flow = "inscription", registrationId = null, paid = false, refusal = false, extra = {} } = opts;
  const incidentId = newIncidentId();
  let classification = { kind: "bug", httpStatus: null, technical: true };
  try {
    classification = classifyFailure(error);
    // Une erreur « métier » (Error simple) qui survient APRÈS un paiement encaissé, ou que l'appelant
    // sait être une panne (cron, webhook…), est traitée comme une panne technique : journal + alerte.
    if (!refusal && (paid || opts.technical === true) && !classification.technical) {
      classification = { ...classification, technical: true, kind: opts.kind || (paid ? "finalize_failed" : "unknown") };
    }
    if (refusal) classification = { ...classification, technical: false };
    const fieldErrors = error instanceof HelloAssoApiError ? error.fieldErrors : [];
    const businessMessage = clip(error?.message ?? error ?? "", 300);
    const message = buildMemberMessage({ flow, step, classification, fieldErrors, incidentId, paid, businessMessage });

    const details = {
      incidentId,
      step,
      stepLabel: stepLabel(step),
      flow,
      kind: refusal ? "business" : classification.kind,
      httpStatus: classification.httpStatus,
      endpoint: error instanceof HelloAssoApiError ? clip(error.endpoint, 200) : undefined,
      providerMessage: error instanceof HelloAssoApiError ? clip(error.providerMessage || "") : undefined,
      fieldErrors: fieldErrors.length ? fieldErrors : undefined,
      errorName: clip(error?.name || "", 80) || undefined,
      errorMessage: clip(error?.message ?? error ?? ""),
      paid: paid || undefined,
      extra: Object.keys(extra).length ? extra : undefined,
      at: new Date().toISOString(),
    };

    const shouldAlert = opts.alert ?? (!refusal && classification.technical);
    let alert = { sent: false, reason: "not_applicable" };
    if (shouldAlert && env.DB) {
      try {
        const duplicate = await recentIncidentExists(env.DB, { step, kind: details.kind, registrationId, paid, minutes: ALERT_DEDUPE_MINUTES });
        alert = duplicate
          ? { sent: false, reason: "deduplicated" }
          : await sendIncidentAlert(env, { ...details, paid, registrationId });
      } catch (alertError) {
        alert = { sent: false, reason: clip(alertError?.message || "alert_failed", 120) };
      }
    }
    details.alert = alert;

    // Journal : action distincte pour une panne technique et un refus métier.
    if (env.DB) {
      await writeAuditLog(env.DB, {
        action: refusal || !classification.technical ? REFUSAL_ACTION : INCIDENT_ACTION,
        entityType: registrationId ? "inscriptions_publiques" : "system",
        entityId: registrationId,
        details,
        ip: context?.request ? getClientIp(context.request) : "",
      }).catch((auditError) => console.error("[diagnostics] écriture du journal impossible :", auditError?.message || String(auditError)));
    }

    // Ligne JSON unique, filtrable dans les logs Cloudflare (« affbc.incident »).
    (classification.technical ? console.error : console.warn)(JSON.stringify({ tag: "affbc.incident", ...details }));

    return {
      incidentId,
      kind: details.kind,
      technical: classification.technical && !refusal,
      status: suggestedHttpStatus(classification),
      message,
    };
  } catch (internalError) {
    // Le diagnostic ne doit jamais aggraver la situation.
    console.error("[diagnostics] reportFailure a échoué :", internalError?.message || String(internalError));
    return {
      incidentId,
      kind: classification.kind,
      technical: true,
      status: 500,
      message: `Une erreur est survenue. Veuillez réessayer ou contacter le club. (Référence : ${incidentId})`,
    };
  }
}

/** Raccourci : refus métier attendu (validation, dossier expiré, plafond de reprises…). */
export function reportRefusal(context, opts = {}) {
  return reportFailure(context, { ...opts, refusal: true, alert: false });
}
