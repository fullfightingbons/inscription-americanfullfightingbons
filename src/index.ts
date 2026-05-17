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
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: methods.join(", ") },
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
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
