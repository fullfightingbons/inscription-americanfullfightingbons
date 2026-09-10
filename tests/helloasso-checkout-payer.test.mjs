import test from "node:test";
import assert from "node:assert/strict";

import { createHelloAssoCheckout } from "../src/routes/api/public/inscription.js";

// Bug du 10/09/2026 : payer.dateOfBirth envoyée à HelloAsso reprenait
// toujours payload.identity.birthDate (le pratiquant), y compris pour un
// mineur — dont le payeur réel est le représentant légal. HelloAsso rejette
// alors le checkout avec l'erreur 400 "L'acheteur doit être majeur". Ces
// tests interceptent l'appel réseau (mock de global.fetch) pour vérifier le
// corps envoyé à /checkout-intents, sans dépendre d'un vrai compte HelloAsso.

const ENV = {
  HELLOASSO_CLIENT_ID: "test-id",
  HELLOASSO_CLIENT_SECRET: "test-secret",
  HELLOASSO_ORGANIZATION_SLUG: "affbc-test",
  HELLOASSO_ENV: "sandbox",
  PUBLIC_ORIGIN: "https://inscription.example.org",
};

const TOTALS = { total: 250 };

function isoDateYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// Installe un mock de fetch qui répond au call OAuth puis capture le corps
// envoyé à /checkout-intents ; restitue le fetch original après le test.
async function withMockedFetch(run) {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "fake-token" }), { status: 200 });
    }
    if (href.includes("/checkout-intents")) {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 1, redirectUrl: "https://example.org/pay", checkoutIntentId: 1 }), { status: 200 });
    }
    throw new Error(`URL inattendue dans le test : ${href}`);
  };
  try {
    await run();
    return capturedBody;
  } finally {
    global.fetch = originalFetch;
  }
}

test("createHelloAssoCheckout omits payer.dateOfBirth for a minor registrant", async () => {
  const payload = {
    identity: { firstName: "Léa", lastName: "Dupont", birthDate: isoDateYearsAgo(10) },
    contact: { email: "parent@example.com", address1: "1 rue X", city: "Ville", postalCode: "74000" },
    legalRepresentative: { firstName: "Marie", lastName: "Dupont" },
    payment: { payerFirstName: "Marie", payerLastName: "Dupont", installmentCount: 1 },
    practice: { formulaCode: "base" },
  };
  const body = await withMockedFetch(() => createHelloAssoCheckout(ENV, payload, TOTALS, "reg-123"));
  assert.equal(body.payer.dateOfBirth, undefined);
  assert.equal(body.payer.firstName, "Marie");
  assert.equal(body.payer.lastName, "Dupont");
});

test("createHelloAssoCheckout still sends payer.dateOfBirth for an adult registrant paying for themselves", async () => {
  const birthDate = isoDateYearsAgo(30);
  const payload = {
    identity: { firstName: "Jean", lastName: "Dupont", birthDate },
    contact: { email: "jean@example.com", address1: "1 rue X", city: "Ville", postalCode: "74000" },
    legalRepresentative: {},
    payment: { payerFirstName: "Jean", payerLastName: "Dupont", installmentCount: 1 },
    practice: { formulaCode: "base" },
  };
  const body = await withMockedFetch(() => createHelloAssoCheckout(ENV, payload, TOTALS, "reg-456"));
  assert.equal(body.payer.dateOfBirth, birthDate);
});
