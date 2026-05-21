import { badRequest, json } from "../../../../_lib/data.js";
import { onRequestGet as getHelloAssoStatus } from "./status.js";
import {
  getRegistrationIdFromNotification,
  verifyHelloAssoNotification,
} from "./notification-helpers.js";

export async function onRequestPost(context) {
  try {
    const rawBody = await context.request.text();
    const isAuthentic = await verifyHelloAssoNotification(context.request, rawBody, context.env);
    if (!isAuthentic) {
      return badRequest("Notification HelloAsso non authentifiée", 401);
    }

    const payload = rawBody ? JSON.parse(rawBody) : null;
    const eventType = String(payload?.eventType || "").trim();
    if (eventType !== "Payment" && eventType !== "Order") {
      return json({ data: { ignored: true, eventType }, error: null });
    }

    const registrationId = getRegistrationIdFromNotification(payload);
    if (!registrationId) {
      return json({ data: { ignored: true, reason: "missing_registration_id", eventType }, error: null });
    }

    const syncUrl = new URL(context.request.url);
    syncUrl.pathname = "/api/public/payment/helloasso/status";
    syncUrl.search = new URLSearchParams({ registrationId }).toString();

    const syncResponse = await getHelloAssoStatus({
      request: new Request(syncUrl.toString(), { method: "GET" }),
      env: context.env,
    });

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
    return badRequest(error?.message || "Notification HelloAsso invalide", 400);
  }
}
