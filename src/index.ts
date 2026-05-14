import { onRequestGet as getInscriptionConfig } from "./routes/api/public/inscription-config.js";
import { onRequestPost as postInscription } from "./routes/api/public/inscription.js";
import { onRequestGet as getHelloAssoStatus } from "./routes/api/public/payment/helloasso/status.js";

type WorkerEnv = {
  [key: string]: unknown;
  ASSETS?: Fetcher;
};

type AppContext = {
  request: Request;
  env: WorkerEnv;
};

function redirect(url: URL, pathname: string, status = 302) {
  const next = new URL(url.toString());
  next.pathname = pathname;
  next.search = "";
  return Response.redirect(next.toString(), status);
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

    if (path === "/") {
      return redirect(url, "/inscription/");
    }

    if (path === "/inscription") {
      return redirect(url, "/inscription/");
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

    if (path === "/api/public/payment/helloasso/status") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      return getHelloAssoStatus(context);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
