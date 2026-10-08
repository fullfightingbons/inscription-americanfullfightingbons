/**
 * AFFBC — Cron : contrôle de santé du paiement en ligne
 *
 * Vérifie, sans attendre qu'un adhérent soit bloqué, que ce dont l'inscription
 * a besoin fonctionne : variables/secrets présents, base D1 joignable,
 * identifiants HelloAsso acceptés. Chaque échec est consigné dans le journal
 * d'incidents (audit_logs, `public.erreur`) et déclenche l'alerte e-mail au
 * club, avec la raison précise (ex. « HelloAsso auth échouée (401) »).
 *
 * Exécuté par le même déclencheur cron que la purge (cf. src/index.ts).
 * Le contrôle HelloAsso ne coûte qu'une demande de jeton OAuth par exécution.
 */

import { reportFailure } from "../_lib/diagnostics.js";
import { getHelloAssoAccessToken } from "../_lib/public-payments.js";

const REQUIRED_SECRETS = [
  "HELLOASSO_CLIENT_ID",
  "HELLOASSO_CLIENT_SECRET",
  "HELLOASSO_ORGANIZATION_SLUG",
  "BREVO_API_KEY",
];

export async function runHealthChecks(env) {
  const results = [];

  const run = async (name, step, fn) => {
    try {
      await fn();
      results.push({ check: name, ok: true });
      return true;
    } catch (error) {
      results.push({ check: name, ok: false, error: String(error?.message || error).slice(0, 200) });
      await reportFailure({ env }, { step, flow: "health", error, technical: true, kind: "health_failed" });
      return false;
    }
  };

  // 1. Configuration : on liste les NOMS manquants, jamais les valeurs.
  const configOk = await run("config", "health.config", async () => {
    const missing = REQUIRED_SECRETS.filter((name) => !String(env?.[name] || "").trim());
    if (!env?.R2_PDF && !env?.R2_STORAGE) missing.push("R2_PDF/R2_STORAGE");
    if (missing.length) throw new Error(`Configuration incomplète : ${missing.join(", ")}`);
  });

  // 2. Base de données.
  await run("database", "health.database", async () => {
    if (!env?.DB) throw new Error("Binding D1 (DB) absent");
    await env.DB.prepare("SELECT 1 AS ok").first();
  });

  // 3. Authentification HelloAsso (inutile si la configuration est déjà incomplète).
  if (configOk) {
    await run("helloasso_auth", "health.helloasso_auth", () => getHelloAssoAccessToken(env));
  }

  return { ok: results.every((r) => r.ok), results };
}
