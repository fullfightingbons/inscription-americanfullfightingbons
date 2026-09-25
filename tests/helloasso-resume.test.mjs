import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConfirmationEmailHtml,
  buildConfirmationEmailText,
  createHelloAssoCheckout,
} from "../src/routes/api/public/inscription.js";
import { onRequestPost as resumePayment, MAX_RESUMES } from "../src/routes/api/public/payment/helloasso/resume.js";
import { onRequestGet as getStatus } from "../src/routes/api/public/payment/helloasso/status.js";

// Reprise du paiement HelloAsso d'un dossier déjà enregistré.
//
// Contexte : le lien de paiement HelloAsso n'est valable que 15 minutes ; un
// adhérent qui quitte la page (flèche retour, erreur, refus bancaire) devait
// jusqu'ici tout ressaisir. POST /api/public/payment/helloasso/resume recrée un
// checkout pour le dossier existant. Ces tests remplacent D1 par une base en
// mémoire minimaliste et interceptent fetch (aucun appel réseau réel).

const ID = "123e4567-e89b-42d3-a456-426614174000";
const OLD_INTENT = "1001";
const NEW_INTENT = "2002";
const ENV_BASE = {
  HELLOASSO_CLIENT_ID: "test-id",
  HELLOASSO_CLIENT_SECRET: "test-secret",
  HELLOASSO_ORGANIZATION_SLUG: "affbc-test",
  HELLOASSO_ENV: "sandbox",
  PUBLIC_ORIGIN: "https://inscription.example.org",
};

function makeDossier(overrides = {}) {
  return {
    identity: { firstName: "Jean", lastName: "Martin", birthDate: "1990-04-12" },
    contact: { email: "jean@example.com", address1: "1 rue X", city: "Bons", postalCode: "74890" },
    practice: { formulaCode: "base", typeInscription: "nouvelle" },
    payment: { method: "helloasso", installmentCount: 1 },
    computedTotals: { total: 250 },
    ...overrides,
  };
}

function makeRegistration(overrides = {}, dossier = makeDossier()) {
  return {
    id: ID,
    nom: "MARTIN",
    prenom: "Jean",
    statut: "paiement_en_attente",
    adherent_id: null,
    helloasso_checkout_intent_id: OLD_INTENT,
    helloasso_url: "https://old.example/pay",
    dossier_json: JSON.stringify(dossier),
    updated_at: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

// D1 factice : ne comprend que les requêtes utilisées par les handlers testés.
function makeDb(row, { failUpdate = false, onLock = null } = {}) {
  const state = { row, audit: [], updates: 0 };
  return {
    state,
    prepare(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      return {
        bind(...args) {
          return {
            async first() {
              if (text.startsWith("SELECT * FROM inscriptions_publiques WHERE id = ?")) {
                return args[0] === state.row?.id ? { ...state.row } : null;
              }
              throw new Error(`first() inattendu : ${text}`);
            },
            async run() {
              if (text.startsWith("UPDATE inscriptions_publiques SET helloasso_checkout_intent_id = ?")) {
                if (failUpdate) return { meta: { changes: 0 } };
                const [intentId, url, dossierJson, updatedAt] = args;
                state.row = { ...state.row, helloasso_checkout_intent_id: intentId, helloasso_url: url, dossier_json: dossierJson, updated_at: updatedAt };
                state.updates += 1;
                return { meta: { changes: 1 } };
              }
              if (text.startsWith("UPDATE inscriptions_publiques SET statut = 'traitement_paiement'")) {
                if (onLock) return onLock();
                throw new Error("LOCK_REACHED");
              }
              if (text.startsWith("UPDATE inscriptions_publiques SET statut = 'paiement_en_attente'")) {
                return { meta: { changes: 0 } }; // libération du verrou (catch de status.js)
              }
              if (text.startsWith('INSERT INTO "audit_logs"')) {
                state.audit.push(args);
                return { meta: { changes: 1 } };
              }
              throw new Error(`run() inattendu : ${text}`);
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
}

// Mock de fetch : `intents` = { <id>: order|null } pour GET checkout-intents/<id>.
async function withMockedHelloAsso({ intents = { [OLD_INTENT]: null }, createStatus = 200, getStatus: getIntentStatus = 200 }, run) {
  const original = global.fetch;
  const calls = { get: [], post: [] };
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "fake-token" }), { status: 200 });
    }
    if (href.includes("/checkout-intents")) {
      if ((init.method || "GET") === "POST") {
        calls.post.push(JSON.parse(init.body));
        return createStatus === 200
          ? new Response(JSON.stringify({ id: Number(NEW_INTENT), redirectUrl: `https://pay.example/${NEW_INTENT}` }), { status: 200 })
          : new Response(JSON.stringify({ message: "boom" }), { status: createStatus });
      }
      const intentId = href.split("/checkout-intents/")[1];
      calls.get.push(intentId);
      if (getIntentStatus !== 200) return new Response(JSON.stringify({ message: "HelloAsso indisponible" }), { status: getIntentStatus });
      return new Response(JSON.stringify({ id: Number(intentId), order: intents[intentId] ?? null }), { status: 200 });
    }
    throw new Error(`URL inattendue dans le test : ${href}`);
  };
  try {
    return await run(calls);
  } finally {
    global.fetch = original;
  }
}

function post(body, db, envExtra = {}) {
  return resumePayment({
    request: new Request("https://inscription.example.org/api/public/payment/helloasso/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env: { ...ENV_BASE, ...envExtra, DB: db },
  });
}

const PAID_ORDER = { id: 77, payments: [{ amount: 25000, date: "2026-09-24T10:00:00Z" }] };

// ─── Validation d'entrée / états du dossier ──────────────────────────────────

test("resume rejects a malformed registrationId", async () => {
  const res = await post({ registrationId: "not-a-uuid" }, makeDb(makeRegistration()));
  assert.equal(res.status, 400);
});

test("resume returns 404 for an unknown registration", async () => {
  const res = await post({ registrationId: "00000000-0000-4000-8000-000000000000" }, makeDb(makeRegistration()));
  assert.equal(res.status, 404);
});

test("resume tells the caller a finalized registration is already paid", async () => {
  const res = await post({ registrationId: ID }, makeDb(makeRegistration({ adherent_id: "adh-1" })));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.paid, true);
  assert.equal(body.data.alreadyProcessed, true);
});

test("resume refuses an abandoned (purged) registration with 410", async () => {
  const db = makeDb(makeRegistration({ statut: "abandonnee" }));
  const res = await post({ registrationId: ID }, db);
  assert.equal(res.status, 410);
  assert.equal(db.state.updates, 0);
});

test("resume refuses a registration whose creation failed", async () => {
  const res = await post({ registrationId: ID }, makeDb(makeRegistration({ statut: "echec_creation" })));
  assert.equal(res.status, 409);
});

// ─── Cas nominal ─────────────────────────────────────────────────────────────

test("resume creates a new checkout, keeps the old id and honours a new installment count", async () => {
  const db = makeDb(makeRegistration());
  await withMockedHelloAsso({}, async (calls) => {
    const res = await post({ registrationId: ID, installmentCount: 3 }, db);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.data.helloAssoUrl, `https://pay.example/${NEW_INTENT}`);
    assert.equal(body.data.installmentCount, 3);

    // 1) l'ancien checkout a été vérifié avant d'en ouvrir un nouveau
    assert.deepEqual(calls.get, [OLD_INTENT]);

    // 2) le nouveau checkout : 3 échéances (initial + 2 termes), total inchangé, URLs de retour avec ref
    assert.equal(calls.post.length, 1);
    const sent = calls.post[0];
    assert.equal(sent.totalAmount, 25000);
    assert.equal(sent.initialAmount + sent.terms.reduce((sum, t) => sum + t.amount, 0), 25000);
    assert.equal(sent.terms.length, 2);
    assert.equal(sent.metadata.registrationId, ID);
    assert.equal(sent.backUrl, `https://inscription.example.org/?helloasso=cancel&ref=${ID}`);
    assert.equal(sent.errorUrl, `https://inscription.example.org/?helloasso=error&ref=${ID}`);
    assert.equal(sent.returnUrl, `https://inscription.example.org/?helloasso=success&ref=${ID}`);

    // 3) le dossier pointe sur le nouveau checkout et garde la trace de l'ancien
    assert.equal(db.state.row.helloasso_checkout_intent_id, NEW_INTENT);
    assert.equal(db.state.row.helloasso_url, `https://pay.example/${NEW_INTENT}`);
    const stored = JSON.parse(db.state.row.dossier_json);
    assert.deepEqual(stored.payment.previousCheckoutIntentIds, [OLD_INTENT]);
    assert.equal(stored.payment.resumeCount, 1);
    assert.equal(stored.payment.installmentCount, 3);
    assert.equal(db.state.row.statut, "paiement_en_attente");
    assert.equal(db.state.audit.length, 1);
  });
});

test("resume keeps the originally chosen installment count when none is sent", async () => {
  const db = makeDb(makeRegistration({}, makeDossier({ payment: { method: "helloasso", installmentCount: 2 } })));
  await withMockedHelloAsso({}, async (calls) => {
    const res = await post({ registrationId: ID }, db);
    assert.equal(res.status, 200);
    assert.equal(calls.post[0].terms.length, 1);
  });
});

// ─── Protection contre le double paiement ────────────────────────────────────

test("resume does NOT open a second payment when HelloAsso cannot confirm the previous one", async () => {
  const db = makeDb(makeRegistration());
  await withMockedHelloAsso({ getStatus: 500 }, async (calls) => {
    const res = await post({ registrationId: ID }, db);
    assert.equal(res.status, 502);
    assert.equal(calls.post.length, 0);
    assert.equal(db.state.updates, 0);
  });
});

test("resume detects a previous checkout that was actually paid (goes to finalization, no new checkout)", async () => {
  // Le verrou « traitement_paiement » n'est posé par status.js qu'une fois un
  // paiement constaté : l'atteindre prouve que le paiement a été détecté.
  let lockReached = false;
  const db = makeDb(makeRegistration(), { onLock: () => { lockReached = true; throw new Error("LOCK_REACHED"); } });
  await withMockedHelloAsso({ intents: { [OLD_INTENT]: PAID_ORDER } }, async (calls) => {
    const res = await post({ registrationId: ID }, db);
    assert.equal(lockReached, true);   // paiement détecté → finalisation engagée
    assert.equal(res.status, 502);     // la finalisation factice échoue → on n'ouvre PAS de nouveau paiement
    assert.equal(calls.post.length, 0);
  });
});

test("resume stops at the resume cap", async () => {
  const dossier = makeDossier({ payment: { method: "helloasso", installmentCount: 1, resumeCount: MAX_RESUMES } });
  const db = makeDb(makeRegistration({}, dossier));
  await withMockedHelloAsso({}, async (calls) => {
    const res = await post({ registrationId: ID }, db);
    assert.equal(res.status, 429);
    assert.equal(calls.post.length, 0);
  });
});

test("resume leaves the registration untouched when HelloAsso refuses the new checkout", async () => {
  const db = makeDb(makeRegistration());
  await withMockedHelloAsso({ createStatus: 400 }, async () => {
    const res = await post({ registrationId: ID }, db);
    assert.equal(res.status, 502);
    assert.equal(db.state.updates, 0);
    assert.equal(db.state.row.helloasso_checkout_intent_id, OLD_INTENT);
  });
});

test("resume does not overwrite a registration whose status changed meanwhile", async () => {
  const db = makeDb(makeRegistration(), { failUpdate: true });
  await withMockedHelloAsso({}, async () => {
    const res = await post({ registrationId: ID }, db);
    assert.equal(res.status, 409);
  });
});

// ─── status.js : anciens checkouts + statut du dossier ───────────────────────

function get(db) {
  return getStatus({
    request: new Request(`https://inscription.example.org/api/public/payment/helloasso/status?registrationId=${ID}`),
    env: { ...ENV_BASE, DB: db },
  });
}

test("status reports an unpaid registration together with its status", async () => {
  const db = makeDb(makeRegistration());
  await withMockedHelloAsso({}, async () => {
    const body = await (await get(db)).json();
    assert.equal(body.data.paid, false);
    assert.equal(body.data.registrationStatus, "paiement_en_attente");
  });
});

test("status also checks previous checkouts and finds a payment made on an old link", async () => {
  const dossier = makeDossier({ payment: { method: "helloasso", installmentCount: 1, previousCheckoutIntentIds: ["999"] } });
  let lockReached = false;
  const db = makeDb(makeRegistration({}, dossier), { onLock: () => { lockReached = true; throw new Error("LOCK_REACHED"); } });
  await withMockedHelloAsso({ intents: { [OLD_INTENT]: null, 999: PAID_ORDER } }, async (calls) => {
    await get(db);
    assert.deepEqual(calls.get, [OLD_INTENT, "999"]); // le checkout courant PUIS l'ancien
    assert.equal(lockReached, true);                  // paiement retrouvé → finalisation engagée
  });
});

test("status stays unpaid when neither the current nor the previous checkouts were paid", async () => {
  const dossier = makeDossier({ payment: { method: "helloasso", installmentCount: 1, previousCheckoutIntentIds: ["999"] } });
  const db = makeDb(makeRegistration({}, dossier));
  await withMockedHelloAsso({ intents: { [OLD_INTENT]: null, 999: null } }, async (calls) => {
    const body = await (await get(db)).json();
    assert.deepEqual(calls.get, [OLD_INTENT, "999"]);
    assert.equal(body.data.paid, false);
  });
});

// ─── Checkout initial + e-mail ───────────────────────────────────────────────

test("createHelloAssoCheckout gives back/error/return URLs carrying the registration id and no companyName", async () => {
  const db = null;
  await withMockedHelloAsso({}, async (calls) => {
    await createHelloAssoCheckout(
      { ...ENV_BASE, APP_NAME: "AFFBC" },
      makeDossier(),
      { total: 250 },
      ID,
    );
    const sent = calls.post[0];
    assert.match(sent.backUrl, new RegExp(`helloasso=cancel&ref=${ID}$`));
    assert.match(sent.errorUrl, new RegExp(`helloasso=error&ref=${ID}$`));
    assert.notEqual(sent.backUrl, sent.errorUrl);
    assert.equal("companyName" in sent.payer, false);
  });
  assert.equal(db, null);
});

test("the reception e-mail contains a link to resume the payment", () => {
  const url = `https://inscription.example.org/?helloasso=resume&ref=${ID}`;
  const payload = makeDossier();
  const totals = { total: 250 };
  assert.ok(buildConfirmationEmailHtml(payload, totals, ID, url).includes(`href="${url}"`));
  assert.ok(buildConfirmationEmailText(payload, totals, ID, url).includes(url));
  // sans URL (appel historique) : e-mail inchangé, aucun lien vide
  assert.ok(!buildConfirmationEmailHtml(payload, totals, ID).includes("reprendre mon paiement"));
});
