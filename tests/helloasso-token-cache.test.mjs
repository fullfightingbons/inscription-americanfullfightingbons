import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireHelloAssoToken,
  computeTokenTtlMs,
  invalidateHelloAssoToken,
  resetHelloAssoTokenCache,
} from "../src/routes/_lib/helloasso-token.js";
import { createHelloAssoCheckout } from "../src/routes/api/public/inscription.js";
import { getHelloAssoAccessToken, helloAssoRequest } from "../src/routes/_lib/public-payments.js";
import { runHealthChecks } from "../src/routes/cron/health-check.js";

// Incident INC-EM2X2A (13/10/2026) : HelloAsso a répondu 429 « error code: 1015 »
// (limitation de débit Cloudflare) sur POST /oauth2/token, car le Worker demandait
// un jeton neuf à CHAQUE appel. Ces tests verrouillent le comportement attendu :
// le jeton est réutilisé jusqu'à son expiration, et un échec n'est jamais mis en cache.

const ENV = {
  HELLOASSO_CLIENT_ID: "test-id",
  HELLOASSO_CLIENT_SECRET: "test-secret",
  HELLOASSO_ORGANIZATION_SLUG: "affbc-test",
  HELLOASSO_ENV: "sandbox",
  PUBLIC_ORIGIN: "https://inscription.example.org",
};

test.beforeEach(() => resetHelloAssoTokenCache());

// Fabrique d'appels « réseau » : compte les demandes et numérote les jetons (tok-1, tok-2…).
function fakeTokenRequest({ expiresIn = 1800, failWith = null } = {}) {
  const state = { calls: 0 };
  const request = async () => {
    state.calls += 1;
    if (failWith) throw failWith;
    return { token: `tok-${state.calls}`, expiresIn };
  };
  return { state, request };
}

// Horloge contrôlable pour tester l'expiration sans attendre.
async function withFakeClock(run) {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    return await run({ advance: (ms) => { now += ms; } });
  } finally {
    Date.now = realNow;
  }
}

test("computeTokenTtlMs keeps the token until shortly before HelloAsso expires it", () => {
  assert.equal(computeTokenTtlMs(1800), 1_680_000); // 30 min − 2 min de marge
  assert.equal(computeTokenTtlMs(undefined), 300_000); // pas d'expires_in : 5 min, prudent
  assert.equal(computeTokenTtlMs("abc"), 300_000);
  assert.equal(computeTokenTtlMs(0), 300_000);
  assert.equal(computeTokenTtlMs(60), 54_000); // jeton très court : marge de 10 % seulement
  assert.equal(computeTokenTtlMs(999_999), 3_600_000); // plafond d'une heure
});

test("a fresh token is reused instead of asking HelloAsso again", async () => {
  const { state, request } = fakeTokenRequest();
  const first = await acquireHelloAssoToken(ENV, request);
  const second = await acquireHelloAssoToken(ENV, request);
  const third = await acquireHelloAssoToken(ENV, request);
  assert.equal(state.calls, 1);
  assert.deepEqual([first, second, third], [
    { token: "tok-1", cached: false },
    { token: "tok-1", cached: true },
    { token: "tok-1", cached: true },
  ]);
});

test("the token is renewed once its lifetime (minus the margin) has elapsed", async () => {
  await withFakeClock(async ({ advance }) => {
    const { state, request } = fakeTokenRequest({ expiresIn: 1800 });
    await acquireHelloAssoToken(ENV, request);
    advance(1_679_000); // juste avant la limite (30 min − 2 min)
    assert.equal((await acquireHelloAssoToken(ENV, request)).token, "tok-1");
    advance(2_000); // limite dépassée
    const renewed = await acquireHelloAssoToken(ENV, request);
    assert.deepEqual(renewed, { token: "tok-2", cached: false });
    assert.equal(state.calls, 2);
  });
});

test("a failed authentication is never cached", async () => {
  const boom = new Error("HelloAsso auth échoué (429) : error code: 1015");
  const failing = fakeTokenRequest({ failWith: boom });
  await assert.rejects(() => acquireHelloAssoToken(ENV, failing.request), /1015/);
  await assert.rejects(() => acquireHelloAssoToken(ENV, failing.request), /1015/);
  assert.equal(failing.state.calls, 2, "chaque échec est retenté, rien n'est mémorisé");

  const working = fakeTokenRequest();
  assert.equal((await acquireHelloAssoToken(ENV, working.request)).token, "tok-1");
});

test("forceRefresh bypasses the cache and replaces the cached token", async () => {
  const { state, request } = fakeTokenRequest();
  await acquireHelloAssoToken(ENV, request);
  const forced = await acquireHelloAssoToken(ENV, request, { forceRefresh: true });
  assert.deepEqual(forced, { token: "tok-2", cached: false });
  assert.equal((await acquireHelloAssoToken(ENV, request)).token, "tok-2");
  assert.equal(state.calls, 2);
});

test("invalidate only forgets the token it was given", async () => {
  const { state, request } = fakeTokenRequest();
  await acquireHelloAssoToken(ENV, request); // tok-1
  invalidateHelloAssoToken(ENV, "un-autre-jeton");
  assert.equal((await acquireHelloAssoToken(ENV, request)).cached, true, "jeton différent : cache intact");
  invalidateHelloAssoToken(ENV, "tok-1");
  assert.equal((await acquireHelloAssoToken(ENV, request)).token, "tok-2");
  assert.equal(state.calls, 2);
});

test("sandbox and production (and different client ids) never share a token", async () => {
  const { state, request } = fakeTokenRequest();
  await acquireHelloAssoToken({ ...ENV, HELLOASSO_ENV: "sandbox" }, request);
  await acquireHelloAssoToken({ ...ENV, HELLOASSO_ENV: "production" }, request);
  await acquireHelloAssoToken({ ...ENV, HELLOASSO_ENV: "production", HELLOASSO_CLIENT_ID: "autre" }, request);
  assert.equal(state.calls, 3);
});

// ── Intégration : les vrais chemins de code (inscription, statut/reprise, santé) ──

const TOTALS = { total: 250 };
const payload = () => ({
  identity: { firstName: "Jean", lastName: "Dupont", birthDate: "1985-04-12" },
  contact: { email: "jean@example.com", address1: "1 rue X", city: "Ville", postalCode: "74000" },
  payment: { installmentCount: 1 },
  practice: { formulaCode: "base" },
});

/**
 * Faux réseau HelloAsso. `tokenCounter` compte les POST /oauth2/token ;
 * `checkoutAuth` liste les en-têtes Authorization reçus par /checkout-intents ;
 * `rejectTokens` = jetons que le faux HelloAsso refuse en 401 (jeton révoqué).
 */
async function withFakeHelloAsso({ rejectTokens = [] } = {}, run) {
  const original = global.fetch;
  const net = { tokenCalls: 0, checkoutAuth: [], getAuth: [] };
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/oauth2/token")) {
      net.tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `tok-${net.tokenCalls}`, expires_in: 1800 }), { status: 200 });
    }
    const auth = init.headers?.authorization || init.headers?.Authorization || "";
    const bearer = auth.replace("Bearer ", "");
    if (href.includes("/checkout-intents")) {
      const isPost = (init.method || "GET") === "POST";
      (isPost ? net.checkoutAuth : net.getAuth).push(auth);
      if (rejectTokens.includes(bearer)) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
      return isPost
        ? new Response(JSON.stringify({ id: 7, redirectUrl: "https://pay.example/7" }), { status: 200 })
        : new Response(JSON.stringify({ id: 7, order: null }), { status: 200 });
    }
    throw new Error(`URL inattendue dans le test : ${href}`);
  };
  try {
    return await run(net);
  } finally {
    global.fetch = original;
  }
}

test("several checkouts in a row ask HelloAsso for ONE token only", async () => {
  await withFakeHelloAsso({}, async (net) => {
    for (let i = 0; i < 5; i += 1) {
      const result = await createHelloAssoCheckout(ENV, payload(), TOTALS, `reg-${i}`);
      assert.equal(result.url, "https://pay.example/7");
    }
    assert.equal(net.tokenCalls, 1, "avant la correction : 5 demandes de jeton, d'où le 429 / 1015");
    assert.equal(net.checkoutAuth.length, 5);
    assert.ok(net.checkoutAuth.every((a) => a === "Bearer tok-1"));
  });
});

test("checkouts and status reads share the same cached token", async () => {
  await withFakeHelloAsso({}, async (net) => {
    await createHelloAssoCheckout(ENV, payload(), TOTALS, "reg-1");
    await helloAssoRequest(ENV, "/organizations/affbc-test/checkout-intents/7");
    await helloAssoRequest(ENV, "/organizations/affbc-test/checkout-intents/7");
    assert.equal(net.tokenCalls, 1);
  });
});

test("a cached token rejected with 401 is replaced and the checkout retried once", async () => {
  await withFakeHelloAsso({ rejectTokens: ["tok-1"] }, async (net) => {
    // Le cache contient tok-1, que HelloAsso a révoqué entre-temps.
    await getHelloAssoAccessToken(ENV);
    const result = await createHelloAssoCheckout(ENV, payload(), TOTALS, "reg-1");
    assert.equal(result.url, "https://pay.example/7", "le membre ne voit aucune erreur");
    assert.deepEqual(net.checkoutAuth, ["Bearer tok-1", "Bearer tok-2"]);
    assert.equal(net.tokenCalls, 2);
    // Le nouveau jeton est désormais celui du cache.
    await createHelloAssoCheckout(ENV, payload(), TOTALS, "reg-2");
    assert.equal(net.tokenCalls, 2);
  });
});

test("the same stale-token recovery applies to status reads", async () => {
  await withFakeHelloAsso({ rejectTokens: ["tok-1"] }, async (net) => {
    await getHelloAssoAccessToken(ENV);
    const intent = await helloAssoRequest(ENV, "/organizations/affbc-test/checkout-intents/7");
    assert.equal(intent.id, 7);
    assert.deepEqual(net.getAuth, ["Bearer tok-1", "Bearer tok-2"]);
  });
});

test("a 401 on a brand-new token is a real configuration error: no retry", async () => {
  await withFakeHelloAsso({ rejectTokens: ["tok-1"] }, async (net) => {
    await assert.rejects(
      () => createHelloAssoCheckout(ENV, payload(), TOTALS, "reg-1"),
      (error) => error.httpStatus === 401,
    );
    assert.equal(net.checkoutAuth.length, 1, "un seul essai");
    assert.equal(net.tokenCalls, 1);
  });
});

test("the daily health check really asks HelloAsso, even when a token is cached", async () => {
  await withFakeHelloAsso({}, async (net) => {
    await getHelloAssoAccessToken(ENV); // jeton déjà en cache dans l'isolat
    const env = {
      ...ENV,
      BREVO_API_KEY: "k",
      R2_PDF: {},
      DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
    };
    const report = await runHealthChecks(env);
    assert.equal(report.ok, true);
    assert.equal(net.tokenCalls, 2, "le contrôle de santé ne se contente pas du cache");
  });
});
