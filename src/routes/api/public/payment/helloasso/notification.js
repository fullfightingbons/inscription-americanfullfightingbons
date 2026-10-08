import { badRequest, json } from "../../../../_lib/data.js";
import { reportFailure } from "../../../../_lib/diagnostics.js";
import { onRequestGet as getHelloAssoStatus } from "./status.js";
import {
  getRegistrationIdFromNotification,
  verifyHelloAssoNotification,
} from "./notification-helpers.js";

export async function onRequestPost(context) {
  let step = "webhook.parse";
  let registrationId = null;
  try {
    const rawBody = await context.request.text();
    step = "webhook.auth";
    const isAuthentic = await verifyHelloAssoNotification(context.request, rawBody, context.env);
    if (!isAuthentic) {
      // Un webhook refusé À TORT (ex. l'IP source de HelloAsso a changé) empêcherait toute
      // finalisation automatique sans aucun signe visible : on le consigne et on alerte
      // (dédupliqué sur 30 min, donc un scanner ne remplira pas la boîte du club).
      await reportFailure(context, {
        step: "webhook.auth",
        flow: "webhook",
        error: new Error("Notification HelloAsso non authentifiée"),
        technical: true,
        kind: "webhook_auth",
        alert: true,
      });
      return badRequest("Notification HelloAsso non authentifiée", 401);
    }

    step = "webhook.parse";
    const payload = rawBody ? JSON.parse(rawBody) : null;
    const eventType = String(payload?.eventType || "").trim();
    if (eventType !== "Payment" && eventType !== "Order") {
      return json({ data: { ignored: true, eventType }, error: null });
    }

    registrationId = getRegistrationIdFromNotification(payload);
    if (!registrationId) {
      return json({ data: { ignored: true, reason: "missing_registration_id", eventType }, error: null });
    }

    step = "webhook.sync";
    const syncUrl = new URL(context.request.url);
    syncUrl.pathname = "/api/public/payment/helloasso/status";
    syncUrl.search = new URLSearchParams({ registrationId }).toString();

    const syncResponse = await getHelloAssoStatus({
      request: new Request(syncUrl.toString(), { method: "GET" }),
      env: context.env,
    });

    // /status a déjà consigné sa propre panne (étape exacte, paiement encaissé ou non) : on la
    // relaie telle quelle à HelloAsso, qui réessaiera.
    if (!syncResponse.ok) {
      return syncResponse;
    }

    return json({
      data: {
        processed: true,
        eventType,
        registrationId,
      },
      error: null,
    });
  } catch (error) {
    const report = await reportFailure(context, { step, flow: "webhook", registrationId, error, technical: true, kind: "webhook_error" });
    // Corps illisible = requête invalide (400) ; le reste est une panne de notre côté (HelloAsso réessaiera).
    return badRequest(report.message, step === "webhook.parse" ? 400 : report.status);
  }
}
