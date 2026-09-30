import test from "node:test";
import assert from "node:assert/strict";

import {
  CSE_ACCESS_HEADER,
  isUsableCseCode,
  normalizeCseCode,
  verifyCseAccessCode,
} from "../src/routes/_lib/cse-access.js";
import { onRequestPost as postCseAccess } from "../src/routes/api/public/cse-access.js";
import { onRequestGet as getInscriptionConfig } from "../src/routes/api/public/inscription-config.js";
import { onRequestPost as postInscription } from "../src/routes/api/public/inscription.js";

const SECRET = "K7QM-2XPD-9TWE";

// Faux D1 minimal. `enabled` = valeur de public_inscription_enabled ;
// `cseCode` = valeur de public_inscription_cse_code (undefined = clé absente).
function fakeDb({ enabled = "0", cseCode } = {}) {
  const clubInfoRows = [
    { cle: "public_inscription_enabled", valeur: enabled },
    { cle: "public_inscription_closed_message", valeur: "Fermé pour la saison." },
  ];
  if (cseCode !== undefined) clubInfoRows.push({ cle: "public_inscription_cse_code", valeur: cseCode });
  return {
    prepare(_sql) {
      const stmt = {
        bind() { return stmt; },
        async all() { return { results: clubInfoRows }; },
        async first() { return cseCode === undefined ? null : { valeur: cseCode }; },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
}

const failingDb = {
  prepare() { throw new Error("D1 indisponible"); },
};

function jsonRequest(body, headers = {}) {
  return new Request("https://inscription.test/api/public/cse-access", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ─── Normalisation ───────────────────────────────────────────────────────────

test("normalizeCseCode : insensible à la casse, aux espaces et aux tirets", () => {
  assert.equal(normalizeCseCode("  K7QM-2XPD 9twe "), "k7qm2xpd9twe");
  assert.equal(normalizeCseCode(null), "");
  assert.equal(normalizeCseCode(undefined), "");
});

test("isUsableCseCode : refuse les codes vides ou trop courts", () => {
  assert.equal(isUsableCseCode(""), false);
  assert.equal(isUsableCseCode(undefined), false);
  assert.equal(isUsableCseCode("abc-123"), false); // 6 caractères utiles
  assert.equal(isUsableCseCode(SECRET), true);
});

// ─── Vérification du code ────────────────────────────────────────────────────

test("verifyCseAccessCode : accepte le bon code, quelle que soit sa mise en forme", async () => {
  const db = fakeDb({ cseCode: SECRET });
  assert.equal(await verifyCseAccessCode(db, SECRET), true);
  assert.equal(await verifyCseAccessCode(db, "k7qm2xpd9twe"), true);
  assert.equal(await verifyCseAccessCode(db, "  k7qm 2xpd 9twe  "), true);
});

test("verifyCseAccessCode : refuse un mauvais code, un code vide ou partiel", async () => {
  const db = fakeDb({ cseCode: SECRET });
  assert.equal(await verifyCseAccessCode(db, "K7QM-2XPD-9TWX"), false);
  assert.equal(await verifyCseAccessCode(db, "K7QM-2XPD"), false);
  assert.equal(await verifyCseAccessCode(db, ""), false);
  assert.equal(await verifyCseAccessCode(db, null), false);
});

test("verifyCseAccessCode : fermé par défaut si aucun code exploitable n'est configuré", async () => {
  assert.equal(await verifyCseAccessCode(fakeDb({}), "n'importe quoi"), false);
  assert.equal(await verifyCseAccessCode(fakeDb({ cseCode: "" }), ""), false);
  // Code trop court : fonctionnalité désactivée, même si le visiteur le saisit à l'identique.
  assert.equal(await verifyCseAccessCode(fakeDb({ cseCode: "abc123" }), "abc123"), false);
});

test("verifyCseAccessCode : erreur D1 → refus (jamais d'ouverture par défaut)", async () => {
  assert.equal(await verifyCseAccessCode(failingDb, SECRET), false);
});

// ─── Endpoint POST /api/public/cse-access ────────────────────────────────────

test("POST /api/public/cse-access : code valide → 200", async () => {
  const res = await postCseAccess({ request: jsonRequest({ code: SECRET }), env: { DB: fakeDb({ cseCode: SECRET }) } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.valid, true);
});

test("POST /api/public/cse-access : code faux → 403, sans rien révéler", async () => {
  const res = await postCseAccess({ request: jsonRequest({ code: "FAUX-FAUX-FAUX" }), env: { DB: fakeDb({ cseCode: SECRET }) } });
  assert.equal(res.status, 403);
  const text = await res.text();
  assert.ok(!text.toLowerCase().includes("k7qm"));
});

test("POST /api/public/cse-access : aucune configuration → 403 même avec un code", async () => {
  const res = await postCseAccess({ request: jsonRequest({ code: SECRET }), env: { DB: fakeDb({}) } });
  assert.equal(res.status, 403);
});

test("POST /api/public/cse-access : corps invalide → 400", async () => {
  const request = new Request("https://inscription.test/api/public/cse-access", { method: "POST", body: "pas du json" });
  const res = await postCseAccess({ request, env: { DB: fakeDb({ cseCode: SECRET }) } });
  assert.equal(res.status, 400);
});

// ─── Config publique : jamais le code, seulement un booléen ──────────────────

test("inscription-config : expose cseAccessEnabled sans jamais exposer le code", async () => {
  const res = await getInscriptionConfig({ request: new Request("https://inscription.test/inscription-config"), env: { DB: fakeDb({ cseCode: SECRET }) } });
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.data.isOpen, false);
  assert.equal(body.data.cseAccessEnabled, true);
  assert.ok(!raw.toLowerCase().includes("k7qm"), "le code ne doit jamais apparaître dans la config publique");
  assert.ok(!raw.includes("public_inscription_cse_code"));
});

test("inscription-config : cseAccessEnabled=false sans code ou avec un code trop court", async () => {
  for (const cseCode of [undefined, "", "abc123"]) {
    const res = await getInscriptionConfig({ request: new Request("https://inscription.test/inscription-config"), env: { DB: fakeDb({ cseCode }) } });
    const body = await res.json();
    assert.equal(body.data.cseAccessEnabled, false, `cseCode=${JSON.stringify(cseCode)}`);
  }
});

// ─── Verrou de /api/public/inscription ───────────────────────────────────────

function submitRequest({ code, formulaCode, honeypot = "" } = {}) {
  const headers = {};
  if (code !== undefined) headers[CSE_ACCESS_HEADER] = encodeURIComponent(code);
  const form = new FormData();
  form.append("website", honeypot);
  if (formulaCode !== undefined) {
    // Payload volontairement minimal : on teste le verrou et le contrôle de formule,
    // qui interviennent avant tout le reste du traitement.
    form.append("payload", JSON.stringify({
      identity: { lastName: "Dupont", firstName: "Jean", birthDate: "1990-01-01" },
      practice: { formulaCode },
    }));
  }
  return new Request("https://inscription.test/api/public/inscription/", { method: "POST", headers, body: form });
}

test("inscription fermée : sans code → 423", async () => {
  const res = await postInscription({ request: submitRequest({ formulaCode: "cse_thales" }), env: { DB: fakeDb({ cseCode: SECRET }) } });
  assert.equal(res.status, 423);
  const body = await res.json();
  assert.equal(body.closed, true);
});

test("inscription fermée : mauvais code → 423", async () => {
  const res = await postInscription({ request: submitRequest({ code: "FAUX-FAUX-FAUX", formulaCode: "cse_thales" }), env: { DB: fakeDb({ cseCode: SECRET }) } });
  assert.equal(res.status, 423);
});

test("inscription fermée : aucun code configuré → 423 même si un en-tête est envoyé", async () => {
  const res = await postInscription({ request: submitRequest({ code: SECRET, formulaCode: "cse_thales" }), env: { DB: fakeDb({}) } });
  assert.equal(res.status, 423);
});

test("inscription fermée : bon code mais autre formule que CSE Thalès → 403", async () => {
  for (const formulaCode of ["base", "family", "pro", "bureau", ""]) {
    const res = await postInscription({ request: submitRequest({ code: SECRET, formulaCode }), env: { DB: fakeDb({ cseCode: SECRET }) } });
    assert.equal(res.status, 403, `formule ${JSON.stringify(formulaCode)}`);
    const body = await res.json();
    assert.match(body.error, /CSE Thalès/);
  }
});

test("inscription fermée : bon code + formule CSE Thalès → dépasse le verrou (ni 423, ni refus de formule)", async () => {
  const res = await postInscription({ request: submitRequest({ code: SECRET, formulaCode: "cse_thales" }), env: { DB: fakeDb({ cseCode: SECRET }) } });
  // Le payload minimal échoue ensuite à la validation métier (400) : ce qui compte
  // ici, c'est qu'on ne soit plus bloqué par le verrou ni par la restriction de formule.
  assert.notEqual(res.status, 423);
  const body = await res.json();
  assert.ok(!/seule l'inscription au tarif CSE/.test(String(body.error || "")));
});

test("inscription ouverte : le comportement habituel est inchangé (pas de code requis)", async () => {
  const res = await postInscription({ request: submitRequest({ formulaCode: "base" }), env: { DB: fakeDb({ enabled: "1", cseCode: SECRET }) } });
  assert.notEqual(res.status, 423);
  const body = await res.json();
  assert.ok(!/seule l'inscription au tarif CSE/.test(String(body.error || "")));
});
