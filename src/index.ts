import { onRequestGet as getInscriptionConfig } from "./routes/api/public/inscription-config.js";
import { onRequestGet as getAdherentEligibility } from "./routes/api/public/adherent-eligibility.js";
import { onRequestPost as postInscription } from "./routes/api/public/inscription.js";
import { onRequestPost as postHelloAssoNotification } from "./routes/api/public/payment/helloasso/notification.js";
import { onRequestGet as getHelloAssoStatus } from "./routes/api/public/payment/helloasso/status.js";
import { onRequestGet as getTarifs } from "./routes/api/public/tarifs.js";

type WorkerEnv = {
  [key: string]: unknown;
  ASSETS?: Fetcher;
};

type AppContext = {
  request: Request;
  env: WorkerEnv;
};

function getPublicOrigin(url: URL, env: WorkerEnv) {
  return String(env.PUBLIC_ORIGIN || url.origin).replace(/\/+$/, "");
}

function redirect(url: URL, pathname: string, status = 302, preserveSearch = false) {
  const next = new URL(url.toString());
  next.pathname = pathname;
  if (!preserveSearch) {
    next.search = "";
  }
  return Response.redirect(next.toString(), status);
}

function redirectToCanonicalRoot(url: URL, env: WorkerEnv, status = 302) {
  return Response.redirect(`${getPublicOrigin(url, env)}/`, status);
}

function methodNotAllowed(methods: string[]) {
  return withSecurityHeaders(new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: methods.join(", ") },
  }));
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data:",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "script-src 'self'",
        "connect-src 'self' https://api.helloasso.com",
      ].join("; "),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const context: AppContext = { request, env };

    if (path === "/index.html") {
      return redirectToCanonicalRoot(url, env);
    }

    if (path === "/api/health" && (method === "GET" || method === "HEAD")) {
      return withSecurityHeaders(new Response(JSON.stringify({ ok: true, data: { service: "inscription-americanfullfightingbons", date: new Date().toISOString() } }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      }));
    }

    if (path === "/api/version" && (method === "GET" || method === "HEAD")) {
      return withSecurityHeaders(new Response(JSON.stringify({ ok: true, data: { service: "inscription-americanfullfightingbons", version: "1.0.0" } }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      }));
    }

    if (path === "/inscription" || path === "/inscription/" || path === "/inscription/index.html") {
      return redirect(url, "/", 302, true);
    }

    if (path === "/inscription-config") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      return getInscriptionConfig(context);
    }

    if (path === "/api/public/inscription" || path === "/api/public/inscription/") {
      if (method !== "POST") {
        return methodNotAllowed(["POST"]);
      }
      return postInscription(context);
    }

    if (path === "/api/public/adherent-eligibility") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      return getAdherentEligibility(context);
    }

    if (path === "/api/public/payment/helloasso/status") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      return getHelloAssoStatus(context);
    }

    if (path === "/api/public/payment/helloasso/notification") {
      if (method !== "POST") {
        return methodNotAllowed(["POST"]);
      }
      return postHelloAssoNotification(context);
    }
    if (path === "/api/public/tarifs") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      return getTarifs(context);
    }

    if (env.ASSETS) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }

    return withSecurityHeaders(new Response("Not Found", { status: 404 }));
  },
} satisfies ExportedHandler<WorkerEnv>;
