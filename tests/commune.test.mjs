import test from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "../src/routes/api/public/commune.js";

// Même principe de mock que helloasso-checkout-payer.test.mjs / helloasso-
// resume.test.mjs : on intercepte global.fetch pour ne jamais dépendre d'un
// vrai appel réseau vers geo.api.gouv.fr dans les tests.
async function withMockedFetch(impl, run) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await run();
  } finally {
    global.fetch = original;
  }
}

function makeRequest(cp) {
  const url = new URL("https://inscription.example.org/api/public/commune");
  if (cp !== undefined) url.searchParams.set("cp", cp);
  return { request: new Request(url), env: {} };
}

test("rejette un code postal absent ou mal formé (400), sans jamais appeler le fournisseur", async () => {
  let called = false;
  await withMockedFetch(
    async () => { called = true; throw new Error("ne devrait pas être appelé"); },
    async () => {
      for (const cp of [undefined, "", "1234", "123456", "abcde", "7489O"]) {
        const res = await onRequestGet(makeRequest(cp));
        assert.equal(res.status, 400);
      }
    },
  );
  assert.equal(called, false);
});

test("interroge geo.api.gouv.fr avec le bon code postal et renvoie les noms de commune triés", async () => {
  let requestedUrl = null;
  const body = await withMockedFetch(
    async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify([{ nom: "Margencel" }, { nom: "Anthy-sur-Léman" }, { nom: "Thonon-les-Bains" }]),
        { status: 200 },
      );
    },
    async () => (await onRequestGet(makeRequest("74200"))).json(),
  );

  assert.match(requestedUrl, /^https:\/\/geo\.api\.gouv\.fr\/communes\?/);
  const upstream = new URL(requestedUrl);
  assert.equal(upstream.searchParams.get("codePostal"), "74200");
  assert.equal(upstream.searchParams.get("format"), "json");

  assert.deepEqual(body, {
    data: { communes: ["Anthy-sur-Léman", "Margencel", "Thonon-les-Bains"] },
    error: null,
  });
});

test("dédoublonne les noms de commune identiques", async () => {
  const body = await withMockedFetch(
    async () => new Response(JSON.stringify([{ nom: "Thonon-les-Bains" }, { nom: "Thonon-les-Bains" }]), { status: 200 }),
    async () => (await onRequestGet(makeRequest("74200"))).json(),
  );
  assert.deepEqual(body.data.communes, ["Thonon-les-Bains"]);
});

test("dégrade en liste vide (200) si le fournisseur répond en erreur, plutôt que de faire échouer le formulaire", async () => {
  const res = await withMockedFetch(
    async () => new Response("erreur", { status: 500 }),
    async () => onRequestGet(makeRequest("74200")),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: { communes: [] }, error: null });
});

test("dégrade en liste vide si le fournisseur ne répond pas (timeout / réseau coupé)", async () => {
  const res = await withMockedFetch(
    async () => { throw new Object.getPrototypeOf(Error).constructor("network down"); },
    async () => onRequestGet(makeRequest("74200")),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: { communes: [] }, error: null });
});

test("dégrade en liste vide si le fournisseur renvoie un contenu inattendu (pas un tableau)", async () => {
  const res = await withMockedFetch(
    async () => new Response(JSON.stringify({ error: "not found" }), { status: 200 }),
    async () => onRequestGet(makeRequest("74200")),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: { communes: [] }, error: null });
});

test("met en cache la réponse valide 24h, mais jamais une réponse dégradée", async () => {
  const ok = await withMockedFetch(
    async () => new Response(JSON.stringify([{ nom: "Thonon-les-Bains" }]), { status: 200 }),
    async () => onRequestGet(makeRequest("74200")),
  );
  assert.match(ok.headers.get("Cache-Control") || "", /max-age=86400/);

  const degraded = await withMockedFetch(
    async () => new Response("erreur", { status: 500 }),
    async () => onRequestGet(makeRequest("74200")),
  );
  assert.equal(degraded.headers.get("Cache-Control"), "no-store");
});
