/**
 * AFFBC — Reprise du paiement HelloAsso d'un dossier déjà enregistré
 *
 * POST /api/public/payment/helloasso/resume
 * Corps JSON : { registrationId: "<uuid>", installmentCount?: 1 | 2 | 3 }
 *
 * Pourquoi cet endpoint existe : le lien de paiement HelloAsso n'est valable que
 * 15 minutes et l'adhérent peut le quitter (flèche retour, erreur technique,
 * refus bancaire, onglet fermé…). Sans ce endpoint, la seule issue était de
 * ressaisir tout le formulaire et de renvoyer les pièces justificatives, alors
 * que le dossier et les fichiers sont déjà enregistrés (statut
 * "paiement_en_attente", conservé 48 h avant purge par le cron).
 *
 * Ce handler :
 *   1. retrouve le dossier et vérifie qu'il peut encore être repris ;
 *   2. vérifie, via le handler /status, qu'aucune tentative précédente n'a en
 *      réalité été payée (évite tout double paiement) — au passage, cela
 *      finalise le dossier si c'est le cas ;
 *   3. crée un NOUVEAU checkout HelloAsso à partir du dossier stocké, en
 *      conservant l'identifiant de l'ancien dans
 *      `payment.previousCheckoutIntentIds` (relu par /status) ;
 *   4. renvoie l'URL de paiement à ouvrir.
 *
 * L'identifiant de dossier est un UUID v4 non devinable ; en complément, le
 * nombre de reprises est plafonné (MAX_RESUMES).
 */

import { badRequest, json } from "../../../../_lib/data.js";
import { getClientIp, writeAuditLog } from "../../../../_lib/audit.js";
import { HelloAssoApiError, reportFailure, reportRefusal } from "../../../../_lib/diagnostics.js";
import { normalizeInstallmentCount } from "../../../../_lib/helpers.js";
import { getRegistration, parseDossierJson } from "../../../../_lib/public-payments.js";
import { createHelloAssoCheckout } from "../../inscription.js";
import { onRequestGet as getHelloAssoStatus } from "./status.js";

export const MAX_RESUMES = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuts d'un dossier dont le paiement est déjà passé (ou en cours de
// finalisation) : rien à reprendre, /status se charge de finaliser.
const PAID_STATUSES = new Set(["traitement_paiement", "payee", "paiement_planifie"]);

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return badRequest("D1 binding is missing", 500);

  let body = null;
  try {
    body = await request.json();
  } catch {
    return badRequest("Requête invalide");
  }

  const registrationId = String(body?.registrationId || "").trim();
  if (!UUID_RE.test(registrationId)) {
    return badRequest("Référence d'inscription invalide");
  }

  // Tout refus / panne à partir d'ici est consigné (journal d'incidents) avec l'étape exacte.
  const refuse = async (step, message, status, extra = {}) => {
    await reportRefusal(context, { step, flow: "resume", registrationId, error: new Error(message), extra: { ...extra, responseStatus: status } });
    return badRequest(message, status);
  };

  let registration;
  try {
    registration = await getRegistration(env.DB, registrationId);
  } catch (lookupError) {
    // « Inscription introuvable » = vrai refus ; toute autre erreur (D1…) est une panne à signaler.
    if (String(lookupError?.message || "") !== "Inscription introuvable") {
      const report = await reportFailure(context, { step: "resume.lookup", flow: "resume", registrationId, error: lookupError });
      return badRequest(report.message, report.status);
    }
    return refuse("resume.lookup", "Dossier introuvable. Merci de refaire votre inscription.", 404);
  }

  // Déjà finalisé (fiche adhérent créée) : le paiement a bien eu lieu.
  if (registration.adherent_id) {
    return json({ data: { paid: true, alreadyProcessed: true, registrationId }, error: null });
  }

  if (PAID_STATUSES.has(registration.statut)) {
    return json({ data: { paid: true, processing: true, registrationId }, error: null });
  }

  if (registration.statut === "abandonnee") {
    return refuse(
      "resume.state",
      "Ce dossier a expiré (délai de 48 h dépassé) et ses pièces ont été supprimées. Merci de refaire votre inscription.",
      410,
      { statut: registration.statut },
    );
  }

  if (registration.statut !== "paiement_en_attente") {
    return refuse(
      "resume.state",
      "Ce dossier ne peut pas être repris automatiquement. Merci de contacter le club en indiquant votre référence.",
      409,
      { statut: registration.statut },
    );
  }

  // ── Une tentative précédente a-t-elle en réalité été payée ? ───────────────
  // On passe par le handler /status (même logique que le webhook) : s'il
  // constate un paiement, il finalise le dossier. Si HelloAsso est injoignable,
  // on préfère refuser plutôt que d'ouvrir un second paiement à l'aveugle.
  const statusUrl = new URL(request.url);
  statusUrl.pathname = "/api/public/payment/helloasso/status";
  statusUrl.search = new URLSearchParams({ registrationId }).toString();
  const statusResponse = await getHelloAssoStatus({
    request: new Request(statusUrl.toString(), { method: "GET" }),
    env,
  });
  const statusBody = await statusResponse.json().catch(() => null);
  if (!statusResponse.ok || statusBody?.error) {
    // /status a déjà consigné sa propre panne (référence INC-…) : on la relie à celle-ci.
    const upstream = String(statusBody?.error || "").match(/INC-[A-Z0-9]{6}/)?.[0] || null;
    const report = await reportRefusal(context, {
      step: "resume.status_check",
      flow: "resume",
      registrationId,
      error: new Error(statusBody?.error || `HTTP ${statusResponse.status}`),
      extra: { upstreamIncident: upstream, responseStatus: statusResponse.status },
    });
    return badRequest(
      `Impossible de vérifier l'état de votre paiement précédent pour le moment. Merci de réessayer dans quelques instants. (Référence : ${upstream || report.incidentId})`,
      502,
    );
  }
  if (statusBody?.data?.paid) {
    return json({
      data: {
        paid: true,
        processing: Boolean(statusBody.data.processing),
        alreadyProcessed: Boolean(statusBody.data.alreadyProcessed),
        registrationId,
      },
      error: null,
    });
  }

  // ── Nouveau checkout à partir du dossier stocké ────────────────────────────
  const dossier = parseDossierJson(registration);
  const totals = dossier.computedTotals;
  if (!totals || !(Number(totals.total) > 0)) {
    return refuse(
      "resume.state",
      "Ce dossier ne peut pas être repris automatiquement. Merci de contacter le club en indiquant votre référence.",
      409,
      { reason: "montant_absent_ou_nul" },
    );
  }

  const previousPayment = dossier.payment || {};
  const resumeCount = Number(previousPayment.resumeCount || 0);
  if (resumeCount >= MAX_RESUMES) {
    return refuse(
      "resume.state",
      "Trop de tentatives de paiement pour ce dossier. Merci de contacter le club en indiquant votre référence.",
      429,
      { reason: "max_resumes", resumeCount },
    );
  }

  const requestedCount = body?.installmentCount;
  const installmentCount = normalizeInstallmentCount(
    requestedCount === undefined || requestedCount === null || requestedCount === ""
      ? previousPayment.installmentCount
      : requestedCount,
  );

  // createHelloAssoCheckout complète payload.payment (installmentCount, schedule)
  // avec des dates d'échéance recalculées à partir d'aujourd'hui.
  const payload = { ...dossier, payment: { ...previousPayment, method: "helloasso", installmentCount } };

  // Échec de création : on consigne la VRAIE raison (code HTTP + champs refusés par
  // HelloAsso) et on renvoie à l'adhérent un message adapté à cette raison.
  let checkout;
  let checkoutError = null;
  try {
    checkout = await createHelloAssoCheckout(env, payload, totals, registrationId);
  } catch (error) {
    checkoutError = error;
  }
  if (!checkoutError && (!checkout?.url || !checkout?.checkoutIntentId)) {
    checkoutError = new HelloAssoApiError("HelloAsso a répondu sans lien de paiement ni identifiant de checkout", {
      httpStatus: 502,
      endpoint: `POST /organizations/${env.HELLOASSO_ORGANIZATION_SLUG}/checkout-intents`,
    });
  }
  if (checkoutError) {
    const report = await reportFailure(context, {
      step: "resume.helloasso_checkout",
      flow: "resume",
      registrationId,
      error: checkoutError,
      extra: { installmentCount, resumeCount, previousCheckoutIntentId: registration.helloasso_checkout_intent_id || null },
    });
    return badRequest(report.message, report.status);
  }

  const now = new Date().toISOString();
  const previousCheckoutIntentIds = [...new Set(
    [...(Array.isArray(previousPayment.previousCheckoutIntentIds) ? previousPayment.previousCheckoutIntentIds : []),
      registration.helloasso_checkout_intent_id]
      .filter(Boolean)
      .map(String),
  )].filter((id) => id !== String(checkout.checkoutIntentId));

  const nextDossier = {
    ...dossier,
    payment: {
      ...previousPayment,
      installmentCount: payload.payment.installmentCount,
      schedule: payload.payment.schedule,
      resumeCount: resumeCount + 1,
      lastResumedAt: now,
      previousCheckoutIntentIds,
    },
  };

  // UPDATE conditionnel : si, entre-temps, un paiement a été détecté (statut
  // passé à "traitement_paiement") ou le dossier purgé, on ne l'écrase pas.
  let update;
  try {
    update = await env.DB.prepare(
      `UPDATE inscriptions_publiques
       SET helloasso_checkout_intent_id = ?, helloasso_url = ?, dossier_json = ?, updated_at = ?
       WHERE id = ? AND adherent_id IS NULL AND statut = 'paiement_en_attente'`,
    ).bind(
      String(checkout.checkoutIntentId),
      checkout.url,
      JSON.stringify(nextDossier),
      now,
      registrationId,
    ).run();
  } catch (dbError) {
    // Le checkout HelloAsso existe mais la base ne le connaît pas : on garde son identifiant
    // dans le journal pour pouvoir rapprocher un éventuel paiement fait sur ce lien.
    const report = await reportFailure(context, {
      step: "resume.db_update",
      flow: "resume",
      registrationId,
      error: dbError,
      extra: { orphanCheckoutIntentId: String(checkout.checkoutIntentId) },
    });
    return badRequest(report.message, report.status);
  }

  const changed = update?.meta?.changes ?? update?.meta?.rows_written ?? 0;
  if (!(changed > 0)) {
    return refuse(
      "resume.db_update",
      "L'état de votre dossier vient de changer. Rechargez la page pour vérifier votre paiement.",
      409,
      { reason: "etat_modifie_entre_temps", orphanCheckoutIntentId: String(checkout.checkoutIntentId) },
    );
  }

  await writeAuditLog(env.DB, {
    action: "public.paiement_repris",
    entityType: "inscriptions_publiques",
    entityId: registrationId,
    details: {
      resumeCount: resumeCount + 1,
      installmentCount: payload.payment.installmentCount,
      helloAssoCheckoutIntentId: checkout.checkoutIntentId,
    },
    ip: getClientIp(request),
  }).catch(() => {});

  return json({
    data: {
      registrationId,
      total: Number(totals.total),
      installmentCount: payload.payment.installmentCount,
      helloAssoUrl: checkout.url,
      helloAssoCheckoutIntentId: checkout.checkoutIntentId,
    },
    error: null,
  });
}
