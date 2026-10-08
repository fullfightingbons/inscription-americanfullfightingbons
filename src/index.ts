/**
 * AFFBC — Inscription publique : point d'entrée du Worker
 *
 * CORRECTIF (2026-07-08) : ce fichier remplace une version qui était en
 * réalité le routeur du projet `site-americanfullfightingbons` (copié par
 * erreur dans ce dépôt). Toutes les routes réelles de l'inscription
 * (`/inscription-config`, `/api/public/inscription`, `/api/public/tarifs`,
 * `/api/public/payment/helloasso/status`, etc.) étaient donc invisibles
 * pour le routeur et retombaient systématiquement sur le 404 générique
 * "Not found" — d'où le stock boutique qui n'apparaissait plus (config
 * jamais chargée) et l'erreur "Not found" à l'envoi du dossier (POST vers
 * une route inconnue du routeur).
 *
 * Ce fichier se contente de faire le lien entre les chemins publics documentés
 * dans README.md et les handlers déjà existants dans `src/routes/`
 * (convention Cloudflare Pages Functions : onRequestGet / onRequestPost avec
 * un objet `context = { request, env }`).
 */

import { onRequestGet as getInscriptionConfig } from "./routes/api/public/inscription-config.js";
import { onRequestGet as getAdherentEligibility } from "./routes/api/public/adherent-eligibility.js";
import { onRequestPost as postInscription } from "./routes/api/public/inscription.js";
import { onRequestPost as postCseAccess } from "./routes/api/public/cse-access.js";
import { onRequestGet as getHelloAssoStatus } from "./routes/api/public/payment/helloasso/status.js";
import { onRequestPost as postHelloAssoNotification } from "./routes/api/public/payment/helloasso/notification.js";
import { onRequestPost as postHelloAssoResume } from "./routes/api/public/payment/helloasso/resume.js";
import { onRequestGet as getTarifs } from "./routes/api/public/tarifs";
import { onRequestGet as getCommune } from "./routes/api/public/commune.js";
import { handleCleanupCron } from "./routes/cron/cleanup-abandoned.js";
import { runHealthChecks } from "./routes/cron/health-check.js";
import { INCIDENT_ACTION, REFUSAL_ACTION, reportFailure } from "./routes/_lib/diagnostics.js";

type RouteContext = { request: Request; env: Env };

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

function redirectTo(pathname: string, requestUrl: URL): Response {
  const target = new URL(pathname, requestUrl.origin);
  return Response.redirect(target.toString(), 301);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function secureTokenEquals(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(left || ""), sha256Hex(right || "")]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function requireAdminStatusToken(request: Request, env: Env): Promise<Response | null> {
  const expected = String((env as any).INSCRIPTION_ADMIN_STATUS_TOKEN || "").trim();
  if (!expected) return Response.json({ error: "Endpoint admin non configuré." }, { status: 503 });
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !(await secureTokenEquals(token, expected))) {
    return Response.json({ error: "Non autorisé" }, { status: 401 });
  }
  return null;
}

async function getAdminInscriptionStatus(request: Request, env: Env): Promise<Response> {
  const authError = await requireAdminStatusToken(request, env);
  if (authError) return authError;

  const [totalRow, byStatus, byPayment, byDay] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS total,
             SUM(COALESCE(montant_total, 0)) AS amount_total,
             MAX(created_at) AS latest_created_at
      FROM inscriptions_publiques
    `).first<{ total: number; amount_total: number; latest_created_at: string | null }>(),
    env.DB.prepare(`
      SELECT statut, COUNT(*) AS count, SUM(COALESCE(montant_total, 0)) AS amount_total
      FROM inscriptions_publiques
      GROUP BY statut
      ORDER BY count DESC
    `).all<{ statut: string; count: number; amount_total: number }>(),
    env.DB.prepare(`
      SELECT paiement_mode, COUNT(*) AS count
      FROM inscriptions_publiques
      GROUP BY paiement_mode
      ORDER BY count DESC
    `).all<{ paiement_mode: string; count: number }>(),
    env.DB.prepare(`
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
      FROM inscriptions_publiques
      WHERE date(substr(created_at, 1, 10)) >= date('now', '-30 days')
      GROUP BY day
      ORDER BY day DESC
    `).all<{ day: string; count: number }>(),
  ]);

  return Response.json({
    ok: true,
    data: {
      generated_at: new Date().toISOString(),
      total: Number(totalRow?.total || 0),
      amount_total: Number(totalRow?.amount_total || 0),
      latest_created_at: totalRow?.latest_created_at || null,
      by_status: byStatus.results || [],
      by_payment_mode: byPayment.results || [],
      last_30_days: byDay.results || [],
    },
  });
}

// Journal d'incidents : blocages techniques (public.erreur) et refus métier (public.refus).
// Même jeton que /api/admin/inscription/status.
//   ?hours=72   fenêtre (1 à 2160 h)       ?limit=100  nombre max de lignes (≤ 500)
//   ?type=erreur|refus                      ?id=INC-XXXXXX  retrouver une référence donnée à un adhérent
async function getAdminIncidents(request: Request, env: Env): Promise<Response> {
  const authError = await requireAdminStatusToken(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 72, 1), 24 * 90);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  const type = (url.searchParams.get("type") || "").toLowerCase();
  const incidentId = (url.searchParams.get("id") || "").trim().toUpperCase();
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  const actions = type === "erreur" ? [INCIDENT_ACTION] : type === "refus" ? [REFUSAL_ACTION] : [INCIDENT_ACTION, REFUSAL_ACTION];
  const binds: (string | number)[] = [...actions, since];
  let sql = `SELECT id, action, entity_id, details, ip, created_at FROM audit_logs
             WHERE action IN (${actions.map(() => "?").join(", ")}) AND created_at >= ?`;
  if (incidentId) {
    sql += ` AND json_extract(details, '$.incidentId') = ?`;
    binds.push(incidentId);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all<{
    id: string; action: string; entity_id: string | null; details: string | null; ip: string; created_at: string;
  }>();

  const incidents = (results || []).map((row) => {
    let details: Record<string, unknown> = {};
    try { details = row.details ? JSON.parse(row.details) : {}; } catch { /* détails illisibles */ }
    return { at: row.created_at, type: row.action === INCIDENT_ACTION ? "erreur" : "refus", registrationId: row.entity_id, ip: row.ip, ...details };
  });

  const summary: Record<string, number> = {};
  for (const incident of incidents as Array<Record<string, unknown>>) {
    const key = `${incident.type} | ${incident.step ?? "?"} | ${incident.kind ?? "?"}`;
    summary[key] = (summary[key] || 0) + 1;
  }

  return Response.json({
    ok: true,
    data: { generated_at: new Date().toISOString(), window_hours: hours, count: incidents.length, summary, incidents },
  });
}

async function routeApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if ((pathname === "/api/health" || pathname === "/api/version") &&
      (request.method === "GET" || request.method === "HEAD")) {
    const body = pathname === "/api/health"
      ? { ok: true, date: new Date().toISOString() }
      : { ok: true, service: "inscription-americanfullfightingbons", version: "1.0.0" };
    return request.method === "HEAD"
      ? new Response(null, { status: 200 })
      : Response.json(body);
  }

  if (pathname === "/api/admin/inscription/status" && request.method === "GET") {
    return getAdminInscriptionStatus(request, env);
  }

  if (pathname === "/api/admin/inscription/incidents" && request.method === "GET") {
    return getAdminIncidents(request, env);
  }

  const context: RouteContext = { request, env };

  if (pathname === "/api/public/inscription-config" &&
      (request.method === "GET" || request.method === "HEAD")) {
    return getInscriptionConfig(context);
  }

  if (pathname === "/api/public/adherent-eligibility" && request.method === "GET") {
    return getAdherentEligibility(context);
  }

  if ((pathname === "/api/public/inscription" || pathname === "/api/public/inscription/") &&
      request.method === "POST") {
    return postInscription(context);
  }

  if (pathname === "/api/public/cse-access" && request.method === "POST") {
    return postCseAccess(context);
  }

  if (pathname === "/api/public/payment/helloasso/status" && request.method === "GET") {
    return getHelloAssoStatus(context);
  }

  if (pathname === "/api/public/payment/helloasso/notification" && request.method === "POST") {
    return postHelloAssoNotification(context);
  }

  if (pathname === "/api/public/payment/helloasso/resume" && request.method === "POST") {
    return postHelloAssoResume(context);
  }

  if (pathname === "/api/public/tarifs" && request.method === "GET") {
    return getTarifs(context as any);
  }

  if (pathname === "/api/public/commune" && request.method === "GET") {
    return getCommune(context);
  }

  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    let response: Response;

    // Compatibilité : anciennes URLs /inscription et /inscription/ → /
    if (pathname === "/inscription" || pathname === "/inscription/") {
      return redirectTo("/", url);
    }

    if (pathname === "/inscription-config" && (request.method === "GET" || request.method === "HEAD")) {
      response = await getInscriptionConfig({ request, env });
    } else if (pathname.startsWith("/api/")) {
      try {
        response = await routeApi(request, env, pathname);
      } catch (caught) {
        // Dernier filet : l'erreur est consignée (étape « worker.unhandled », chemin appelé) au lieu de disparaître.
        const report = await reportFailure({ env, request }, {
          step: "worker.unhandled",
          flow: "worker",
          error: caught,
          technical: true,
          kind: "unhandled",
          extra: { path: pathname, method: request.method },
        });
        response = Response.json({ error: `Une erreur est survenue. Veuillez réessayer ou contacter le club. (Référence : ${report.incidentId})` }, { status: 500 });
      }
    } else {
      response = await env.ASSETS.fetch(request);
    }

    return withSecurityHeaders(response);
  },

  // ── Cron : purge des inscriptions abandonnées (cf. wrangler.json triggers.crons) ──
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      handleCleanupCron(env).then(
        (r: unknown) => console.log("[cron] handleCleanupCron:", JSON.stringify(r)),
        (e: unknown) => console.error("[cron] handleCleanupCron a échoué", e instanceof Error ? e.message : String(e)),
      ),
    );
    // Contrôle de santé du paiement en ligne (config, D1, identifiants HelloAsso) : alerte le club
    // AVANT qu'un adhérent ne soit bloqué.
    ctx.waitUntil(
      runHealthChecks(env).then(
        (r: unknown) => console.log("[cron] runHealthChecks:", JSON.stringify(r)),
        (e: unknown) => console.error("[cron] runHealthChecks a échoué", e instanceof Error ? e.message : String(e)),
      ),
    );
  },
};
