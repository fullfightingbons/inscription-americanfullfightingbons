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
import { onRequestGet as getHelloAssoStatus } from "./routes/api/public/payment/helloasso/status.js";
import { onRequestPost as postHelloAssoNotification } from "./routes/api/public/payment/helloasso/notification.js";
import { onRequestGet as getTarifs } from "./routes/api/public/tarifs";
import { handleCleanupCron } from "./routes/cron/cleanup-abandoned.js";

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

  const context: RouteContext = { request, env };

  if (pathname === "/api/public/adherent-eligibility" && request.method === "GET") {
    return getAdherentEligibility(context);
  }

  if ((pathname === "/api/public/inscription" || pathname === "/api/public/inscription/") &&
      request.method === "POST") {
    return postInscription(context);
  }

  if (pathname === "/api/public/payment/helloasso/status" && request.method === "GET") {
    return getHelloAssoStatus(context);
  }

  if (pathname === "/api/public/payment/helloasso/notification" && request.method === "POST") {
    return postHelloAssoNotification(context);
  }

  if (pathname === "/api/public/tarifs" && request.method === "GET") {
    return getTarifs(context as any);
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
        const message = caught instanceof Error ? caught.message : "Erreur interne";
        console.error("[inscription] Erreur non gérée:", message);
        response = Response.json({ error: "Une erreur est survenue. Veuillez réessayer ou contacter le club." }, { status: 500 });
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
  },
};
