import test from "node:test";
import assert from "node:assert/strict";

import {
  HelloAssoApiError,
  buildMemberMessage,
  classifyFailure,
  extractFieldErrors,
  humanizeFields,
  reportFailure,
} from "../src/routes/_lib/diagnostics.js";
import { createHelloAssoCheckout, onRequestPost as postInscription } from "../src/routes/api/public/inscription.js";
import { onRequestPost as resumePayment } from "../src/routes/api/public/payment/helloasso/resume.js";
import { onRequestGet as getStatus } from "../src/routes/api/public/payment/helloasso/status.js";
import { onRequestPost as postNotification } from "../src/routes/api/public/payment/helloasso/notification.js";
import { runHealthChecks } from "../src/routes/cron/health-check.js";

// Journal d'incidents : chaque blocage doit laisser une trace précise (étape, code HTTP,
// réponse HelloAsso, référence INC-…) ET renvoyer à l'adhérent un message adapté à la cause.

const ID = "123e4567-e89b-42d3-a456-426614174000";
const OLD_INTENT = "1001";
const ENV_BASE = {
  HELLOASSO_CLIENT_ID: "test-id",
  HELLOASSO_CLIENT_SECRET: "test-secret",
  HELLOASSO_ORGANIZATION_SLUG: "affbc-test",
  HELLOASSO_ENV: "sandbox",
  PUBLIC_ORIGIN: "https://inscription.example.org",
  BREVO_API_KEY: "brevo-key",
  SIGNUP_ALERT_TO: "club@example.org",
  R2_PDF: {},
};

function makeRegistration(overrides = {}) {
  return {
    id: ID,
    statut: "paiement_en_attente",
    adherent_id: null,
    helloasso_checkout_intent_id: OLD_INTENT,
    helloasso_url: "https://old.example/pay",
    dossier_json: JSON.stringify({
      identity: { firstName: "Jean", lastName: "Martin", birthDate: "1990-04-12" },
      contact: { email: "jean@example.com", address1: "1 rue X", city: "Bons", postalCode: "74890" },
      practice: { formulaCode: "base", typeInscription: "nouvelle" },
      payment: { method: "helloasso", installmentCount: 1 },
      computedTotals: { total: 250 },
    }),
    updated_at: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

// D1 factice : registre d'audit lisible + les requêtes utilisées par les handlers testés.
function makeDb(row = makeRegistration(), { failLock = false } = {}) {
  const state = { row, audit: [], updates: 0 };
  return {
    state,
    prepare(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      const exec = (args) => ({
        async first() {
          if (text.startsWith("SELECT * FROM inscriptions_publiques WHERE id = ?")) {
            return args[0] === state.row?.id ? { ...state.row } : null;
          }
          if (text.startsWith("SELECT 1 AS found FROM audit_logs")) {
            const perRegistration = text.includes("entity_id = ?");
            const found = state.audit.some((a) => a.action === args[0] && a.created_at >= args[1] && (
              perRegistration
                ? a.entity_id === args[2] && a.details.step === args[3]
                : a.details.step === args[2] && a.details.kind === args[3]
            ));
            return found ? { found: 1 } : null;
          }
          if (text.startsWith("SELECT 1 AS ok")) return { ok: 1 };
          throw new Error(`first() inattendu : ${text}`);
        },
        async run() {
          if (text.startsWith('INSERT INTO "audit_logs"')) {
            const columns = text.match(/\((.*?)\) VALUES/)[1].split(",").map((c) => c.trim().replace(/"/g, ""));
            const entry = Object.fromEntries(columns.map((c, i) => [c, args[i]]));
            state.audit.push({ ...entry, details: entry.details ? JSON.parse(entry.details) : null });
            return { meta: { changes: 1 } };
          }
          if (text.startsWith("UPDATE inscriptions_publiques SET helloasso_checkout_intent_id = ?")) {
            state.updates += 1;
            return { meta: { changes: 1 } };
          }
          if (text.startsWith("UPDATE inscriptions_publiques SET statut = 'traitement_paiement'")) {
            if (failLock) throw new Error("D1_ERROR: database is locked");
            return { meta: { rows_written: 1 } };
          }
          if (text.startsWith("UPDATE inscriptions_publiques SET statut = 'paiement_en_attente'")) return { meta: { changes: 0 } };
          throw new Error(`run() inattendu : ${text}`);
        },
        async all() { return { results: [] }; },
      });
      return { bind: (...args) => exec(args), ...exec([]) };
    },
  };
}

// Mock de fetch : HelloAsso (jeton, checkout, lecture d'un checkout) + Brevo (alertes).
async function withMockedNetwork(options, run) {
  const { tokenStatus = 200, createStatus = 200, createBody = null, intents = { [OLD_INTENT]: null } } = options;
  const original = global.fetch;
  const calls = { brevo: [], post: 0 };
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("api.brevo.com")) {
      calls.brevo.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messageId: "m1" }), { status: 201 });
    }
    if (href.includes("/oauth2/token")) {
      return tokenStatus === 200
        ? new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
        : new Response(JSON.stringify({ error: "invalid_client", error_description: "Client secret invalide" }), { status: tokenStatus });
    }
    if (href.includes("/checkout-intents")) {
      if ((init.method || "GET") === "POST") {
        calls.post += 1;
        return createStatus === 200
          ? new Response(JSON.stringify({ id: 2002, redirectUrl: "https://pay.example/2002" }), { status: 200 })
          : new Response(JSON.stringify(createBody ?? { message: "boom" }), { status: createStatus });
      }
      const intentId = href.split("/checkout-intents/")[1];
      return new Response(JSON.stringify({ id: Number(intentId), order: intents[intentId] ?? null }), { status: 200 });
    }
    throw new Error(`URL inattendue dans le test : ${href}`);
  };
  try { return await run(calls); } finally { global.fetch = original; }
}

const resume = (db, env = {}) => resumePayment({
  request: new Request("https://inscription.example.org/api/public/payment/helloasso/resume", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ registrationId: ID }),
  }),
  env: { ...ENV_BASE, ...env, DB: db },
});

const INC_RE = /INC-[A-Z2-9]{6}/;

// ─── Briques unitaires ────────────────────────────────────────────────────────

test("extractFieldErrors reads the error shapes HelloAsso can return", () => {
  assert.deepEqual(
    extractFieldErrors({ errors: [{ field: "payer.email", message: "invalide", code: "ArgumentInvalid" }] }),
    [{ field: "payer.email", message: "invalide", code: "ArgumentInvalid" }],
  );
  assert.equal(extractFieldErrors({ errors: { "payer.zipCode": ["trop court", "invalide"] } })[0].message, "trop court ; invalide");
  assert.equal(extractFieldErrors({ message: "Bad request", code: "X" })[0].message, "Bad request");
  assert.deepEqual(extractFieldErrors(null), []);
});

test("classifyFailure separates provider, infrastructure and business errors", () => {
  const http = (status) => classifyFailure(new HelloAssoApiError("x", { httpStatus: status })).kind;
  assert.equal(http(400), "provider_rejected_data");
  assert.equal(http(401), "provider_auth");
  assert.equal(http(403), "provider_auth");
  assert.equal(http(429), "provider_rate_limit");
  assert.equal(http(503), "provider_down");
  assert.equal(classifyFailure(new HelloAssoApiError("x", { kind: "config" })).kind, "config");
  assert.equal(classifyFailure(Object.assign(new Error("t"), { name: "TimeoutError" })).kind, "timeout");
  assert.equal(classifyFailure(new Error("D1_ERROR: no such table: x")).kind, "database");
  assert.equal(classifyFailure(new TypeError("Cannot read properties of undefined (reading 'a')")).kind, "bug");
  assert.equal(classifyFailure(new TypeError("Network connection lost.")).kind, "network");
  const business = classifyFailure(new Error("Email obligatoire"));
  assert.equal(business.kind, "business");
  assert.equal(business.technical, false);
});

test("member messages name the cause, end with the reference, and never promise what is false", () => {
  const base = { incidentId: "INC-ABC234" };
  const rejected = buildMemberMessage({
    ...base, flow: "resume", step: "resume.helloasso_checkout",
    classification: { kind: "provider_rejected_data", technical: true },
    fieldErrors: [{ field: "payer.dateOfBirth", message: "m" }, { field: "payer.email", message: "m" }],
  });
  assert.match(rejected, /date de naissance du payeur, adresse e-mail/);
  assert.match(rejected, /Votre dossier et vos documents restent enregistrés/);
  assert.match(rejected, /\(Référence : INC-ABC234\)$/);

  // Première inscription : le dossier est nettoyé, on ne dit jamais « vos documents restent enregistrés ».
  const first = buildMemberMessage({ ...base, flow: "inscription", step: "inscription.helloasso_checkout", classification: { kind: "provider_down", technical: true } });
  assert.match(first, /vous pouvez réessayer/);
  assert.doesNotMatch(first, /restent enregistrés/);

  const paid = buildMemberMessage({ ...base, flow: "status", step: "status.finalize", classification: { kind: "database", technical: true }, paid: true });
  assert.match(paid, /Ne payez pas une seconde fois/);

  assert.deepEqual(humanizeFields([{ field: "payer.zipCode" }, { field: "payer.unknownField" }]), ["code postal"]);
});

// ─── Journal + alerte ─────────────────────────────────────────────────────────

test("reportFailure journals the exact failure, alerts the club once, and dedupes the next identical one", async () => {
  const db = makeDb();
  const error = new HelloAssoApiError("HelloAsso checkout échoué (400) : …", {
    httpStatus: 400, endpoint: "POST /organizations/x/checkout-intents",
    providerMessage: "payer.dateOfBirth : L'acheteur doit être majeur",
    fieldErrors: [{ field: "payer.dateOfBirth", message: "L'acheteur doit être majeur", code: "ArgumentInvalid" }],
  });
  await withMockedNetwork({}, async (calls) => {
    const first = await reportFailure({ env: { ...ENV_BASE, DB: db } }, { step: "resume.helloasso_checkout", flow: "resume", registrationId: ID, error });
    assert.match(first.incidentId, INC_RE);
    assert.equal(first.status, 502);
    assert.equal(calls.brevo.length, 1);
    assert.match(calls.brevo[0].subject, new RegExp(first.incidentId));

    await reportFailure({ env: { ...ENV_BASE, DB: db } }, { step: "resume.helloasso_checkout", flow: "resume", registrationId: ID, error });
    assert.equal(calls.brevo.length, 1, "la 2e panne identique ne renvoie pas d'e-mail");
  });

  assert.equal(db.state.audit.length, 2, "mais elle est bien journalisée");
  const row = db.state.audit[0];
  assert.equal(row.action, "public.erreur");
  assert.equal(row.entity_id, ID);
  assert.equal(row.details.step, "resume.helloasso_checkout");
  assert.equal(row.details.kind, "provider_rejected_data");
  assert.equal(row.details.httpStatus, 400);
  assert.match(row.details.providerMessage, /majeur/);
  assert.equal(row.details.alert.sent, true);
  assert.equal(db.state.audit[1].details.alert.reason, "deduplicated");
});

test("a business refusal is journaled as public.refus without any e-mail alert", async () => {
  const db = makeDb();
  await withMockedNetwork({}, async (calls) => {
    const report = await reportFailure({ env: { ...ENV_BASE, DB: db } }, { step: "inscription.validation", flow: "inscription", error: new Error("Email obligatoire"), refusal: true });
    assert.equal(report.technical, false);
    assert.equal(calls.brevo.length, 0);
  });
  assert.equal(db.state.audit[0].action, "public.refus");
});

test("reportFailure never throws, even when the journal itself is broken", async () => {
  const brokenDb = { prepare() { throw new Error("D1 down"); } };
  const report = await reportFailure({ env: { ...ENV_BASE, DB: brokenDb } }, { step: "status.finalize", error: new Error("x"), technical: true });
  assert.match(report.incidentId, INC_RE);
  assert.ok(report.message.includes(report.incidentId));
});

// ─── Reprise du paiement : la cause réelle remonte ───────────────────────────

test("resume: HelloAsso refuses the data → precise message, exact reason journaled, dossier untouched", async () => {
  const db = makeDb();
  const body = { errors: [{ field: "payer.dateOfBirth", message: "L'acheteur doit être majeur", code: "ArgumentInvalid" }] };
  await withMockedNetwork({ createStatus: 400, createBody: body }, async (calls) => {
    const res = await resume(db);
    const json = await res.json();
    assert.equal(res.status, 502);
    assert.match(json.error, /date de naissance du payeur/);
    assert.match(json.error, /restent enregistrés/);
    const ref = json.error.match(INC_RE)[0];

    const row = db.state.audit.find((a) => a.action === "public.erreur");
    assert.equal(row.details.incidentId, ref, "la référence donnée à l'adhérent retrouve la ligne du journal");
    assert.equal(row.details.step, "resume.helloasso_checkout");
    assert.equal(row.details.httpStatus, 400);
    assert.equal(row.details.endpoint, "POST /organizations/affbc-test/checkout-intents");
    assert.match(row.details.providerMessage, /majeur/);
    assert.equal(row.details.extra.previousCheckoutIntentId, OLD_INTENT);
    assert.equal(row.ip, "203.0.113.9");
    assert.equal(calls.brevo.length, 1);
  });
  assert.equal(db.state.updates, 0);
});

test("resume: HelloAsso unavailable (503) vs checkout rejected as unauthorized (401) give different messages", async () => {
  await withMockedNetwork({ createStatus: 503 }, async () => {
    const json = await (await resume(makeDb())).json();
    assert.match(json.error, /ne répond pas correctement/);
  });
  const db = makeDb();
  await withMockedNetwork({ createStatus: 401, createBody: { message: "Unauthorized" } }, async () => {
    const res = await resume(db);
    const json = await res.json();
    assert.equal(res.status, 502);
    assert.match(json.error, /problème de configuration côté club/);
  });
  const row = db.state.audit.find((a) => a.action === "public.erreur");
  assert.equal(row.details.kind, "provider_auth");
  assert.equal(row.details.httpStatus, 401);
  assert.equal(row.details.step, "resume.helloasso_checkout");
});

test("resume: rejected HelloAsso credentials fail at the payment check and link both journal lines", async () => {
  const db = makeDb();
  await withMockedNetwork({ tokenStatus: 401 }, async () => {
    const res = await resume(db);
    const json = await res.json();
    assert.equal(res.status, 502);
    assert.match(json.error, /Impossible de vérifier l'état de votre paiement précédent/);
    const ref = json.error.match(INC_RE)[0];

    // La panne réelle (jeton refusé) est journalisée par /status…
    const root = db.state.audit.find((a) => a.action === "public.erreur");
    assert.equal(root.details.incidentId, ref);
    assert.equal(root.details.step, "status.fetch_intent");
    assert.equal(root.details.kind, "provider_auth");
    assert.equal(root.details.endpoint, "POST /oauth2/token");
    assert.match(root.details.providerMessage, /Client secret invalide/);

    // …et la reprise s'y rattache au lieu d'inventer une seconde cause.
    const link = db.state.audit.find((a) => a.details.step === "resume.status_check");
    assert.equal(link.details.extra.upstreamIncident, ref);
  });
});

test("resume: refusals (expired dossier, unknown dossier) are journaled with their step", async () => {
  const db = makeDb(makeRegistration({ statut: "abandonnee" }));
  const res = await resume(db);
  assert.equal(res.status, 410);
  assert.equal(db.state.audit[0].action, "public.refus");
  assert.equal(db.state.audit[0].details.step, "resume.state");
  assert.equal(db.state.audit[0].details.extra.statut, "abandonnee");
});

// ─── Après paiement : le cas le plus grave ───────────────────────────────────

test("status: payment confirmed by HelloAsso but finalization fails → 'do not pay twice' + club alerted", async () => {
  const db = makeDb(makeRegistration(), { failLock: true });
  const intents = { [OLD_INTENT]: { id: 77, payments: [{ amount: 25000, date: "2026-09-24T10:00:00Z" }] } };
  await withMockedNetwork({ intents }, async (calls) => {
    const res = await getStatus({
      request: new Request(`https://inscription.example.org/api/public/payment/helloasso/status?registrationId=${ID}`),
      env: { ...ENV_BASE, DB: db },
    });
    const json = await res.json();
    assert.equal(res.status, 500);
    assert.match(json.error, /Ne payez pas une seconde fois/);
    assert.match(json.error, INC_RE);

    const row = db.state.audit.find((a) => a.action === "public.erreur");
    assert.equal(row.details.paid, true);
    assert.equal(row.details.step, "status.lock");
    assert.equal(row.details.kind, "database");
    assert.equal(calls.brevo.length, 1);
    assert.match(calls.brevo[0].subject, /paiement encaissé, dossier NON finalisé/);
  });
});

test("status: a failure before any payment is confirmed never claims the member has paid", async () => {
  const db = makeDb();
  await withMockedNetwork({ intents: { [OLD_INTENT]: null }, tokenStatus: 503 }, async () => {
    const res = await getStatus({
      request: new Request(`https://inscription.example.org/api/public/payment/helloasso/status?registrationId=${ID}`),
      env: { ...ENV_BASE, DB: db },
    });
    const json = await res.json();
    assert.equal(res.status, 502);
    assert.doesNotMatch(json.error, /paiement a bien été reçu/);
    assert.equal(db.state.audit.find((a) => a.action === "public.erreur").details.step, "status.fetch_intent");
  });
});

// ─── Webhook, inscription, santé ─────────────────────────────────────────────

test("webhook: an unauthenticated notification is journaled and alerted (once)", async () => {
  const db = makeDb();
  await withMockedNetwork({}, async (calls) => {
    const send = () => postNotification({
      request: new Request("https://inscription.example.org/api/public/payment/helloasso/notification", { method: "POST", body: "{}" }),
      env: { ...ENV_BASE, DB: db },
    });
    assert.equal((await send()).status, 401);
    assert.equal((await send()).status, 401);
    assert.equal(calls.brevo.length, 1);
  });
  assert.equal(db.state.audit[0].details.step, "webhook.auth");
  assert.equal(db.state.audit[0].details.kind, "webhook_auth");
});

test("inscription: a refusal returned without exception is journaled at the right step, message unchanged", async () => {
  const db = makeDb();
  const form = new FormData();
  form.set("payload", JSON.stringify({}));
  const res = await postInscription({
    request: new Request("https://inscription.example.org/api/public/inscription", { method: "POST", body: form }),
    env: { ...ENV_BASE, DB: db },
  });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.doesNotMatch(json.error, INC_RE, "un simple refus de validation ne s'encombre pas d'une référence");
  assert.equal(db.state.audit.length, 1);
  assert.equal(db.state.audit[0].action, "public.refus");
  assert.equal(db.state.audit[0].details.step, "inscription.validation");
});

test("createHelloAssoCheckout keeps HTTP status, endpoint and refused fields on a 400", async () => {
  const body = { errors: [{ field: "payer.email", message: "Email invalide", code: "ArgumentInvalid" }] };
  await withMockedNetwork({ createStatus: 400, createBody: body }, async () => {
    const payload = {
      identity: { firstName: "Jean", lastName: "Martin", birthDate: "1990-04-12" },
      contact: { email: "x", address1: "1 rue X", city: "Bons", postalCode: "74890" },
      practice: { formulaCode: "base" },
      payment: { method: "helloasso", installmentCount: 1 },
    };
    await assert.rejects(
      () => createHelloAssoCheckout({ ...ENV_BASE }, payload, { total: 250 }, ID),
      (error) => {
        assert.ok(error instanceof HelloAssoApiError);
        assert.equal(error.httpStatus, 400);
        assert.equal(error.fieldErrors[0].field, "payer.email");
        assert.match(error.message, /HelloAsso checkout échoué \(400\)/);
        return true;
      },
    );
  });
});

test("health check: reports the exact failing component before any member is blocked", async () => {
  // Configuration incomplète : les NOMS manquants sont listés, jamais les valeurs.
  const db1 = makeDb();
  const missingEnv = { ...ENV_BASE, DB: db1 };
  delete missingEnv.BREVO_API_KEY;
  const r1 = await withMockedNetwork({}, () => runHealthChecks(missingEnv));
  assert.equal(r1.ok, false);
  assert.match(r1.results.find((r) => r.check === "config").error, /BREVO_API_KEY/);
  assert.ok(!r1.results.some((r) => r.check === "helloasso_auth"), "pas de test d'auth si la config est déjà incomplète");

  // Identifiants refusés par HelloAsso.
  const db2 = makeDb();
  const r2 = await withMockedNetwork({ tokenStatus: 401 }, () => runHealthChecks({ ...ENV_BASE, DB: db2 }));
  assert.equal(r2.ok, false);
  const row = db2.state.audit.find((a) => a.details.step === "health.helloasso_auth");
  assert.equal(row.details.kind, "provider_auth");
  assert.equal(row.details.httpStatus, 401);

  // Tout va bien : aucune ligne dans le journal.
  const db3 = makeDb();
  const r3 = await withMockedNetwork({}, () => runHealthChecks({ ...ENV_BASE, DB: db3 }));
  assert.equal(r3.ok, true);
  assert.equal(db3.state.audit.length, 0);
});
