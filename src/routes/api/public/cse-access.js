/**
 * AFFBC — POST /api/public/cse-access
 *
 * Vérifie le code d'accès « CSE Thalès » saisi sur la page d'inscription
 * lorsque les inscriptions sont fermées au public.
 *
 * Corps : { "code": "XXXX-XXXX-XXXX" }
 * Réponses :
 *   200 { data: { valid: true }, error: null }
 *   403 { error: "Code invalide." }        (code faux, ou fonctionnalité désactivée)
 *
 * Ce endpoint ne donne qu'une information : le code est-il bon ? Il ne délivre
 * aucun jeton : le code est renvoyé par le navigateur à chaque soumission
 * (en-tête X-CSE-Access-Code) et revérifié par /api/public/inscription.
 */

import { badRequest, json } from "../../_lib/data.js";
import { getClientIp } from "../../_lib/audit.js";
import { verifyCseAccessCode } from "../../_lib/cse-access.js";

const MAX_BODY_BYTES = 2048;
// Ralentit les tentatives à l'aveugle sans rien écrire en base (un attaquant
// ne doit pas pouvoir remplir D1 en envoyant de faux codes).
const FAILURE_DELAY_MS = 800;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function onRequestPost(context) {
  if (!context.env.DB) return badRequest("D1 binding is missing", 500);

  const declaredLength = Number(context.request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return badRequest("Requête invalide", 413);

  let body = null;
  try {
    body = await context.request.json();
  } catch {
    return badRequest("Requête invalide");
  }

  const code = typeof body?.code === "string" ? body.code : "";
  if (!code || code.length > 200) {
    await wait(FAILURE_DELAY_MS);
    return badRequest("Code invalide.", 403);
  }

  const valid = await verifyCseAccessCode(context.env.DB, code);
  if (!valid) {
    console.warn("[cse-access] Code refusé depuis", getClientIp(context.request) || "IP inconnue");
    await wait(FAILURE_DELAY_MS);
    return badRequest("Code invalide.", 403);
  }

  return json({ data: { valid: true }, error: null });
}
