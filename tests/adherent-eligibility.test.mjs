import test from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "../src/routes/api/public/adherent-eligibility.js";

// Faux D1 : la requête d'éligibilité lit toute la table `adherents` (`.all()`), le calcul de
// réutilisation du certificat lit ensuite fiche (`.first()`), inscriptions (`.all()` après `.bind()`)
// et durée de validité du club (`.first()`).
function fakeDb({ adherents, certificat = 1, certificatDate = null, registrations = [], duree = { valeur: "36" } }) {
  return {
    prepare(sql) {
      let bound = false;
      const stmt = {
        bind() { bound = true; return stmt; },
        async first() {
          if (/FROM club_info/.test(sql)) return duree;
          if (/FROM adherents/.test(sql)) return { certificat, certificat_date: certificatDate };
          return null;
        },
        async all() { return { results: bound ? registrations : adherents }; },
      };
      return stmt;
    },
  };
}

const ADHERENT = { id: "adh-1", nom: "Dupont", prenom: "Léa", naissance: "2012-04-03", email: "parent@example.com", discipline: "Full Fighting" };
const JOINED_LAST_SEASON = { submitted_at: "2025-09-10T10:00:00.000Z", documents_json: JSON.stringify({ medicalCertificate: { key: "k" } }), dossier_json: "{}" };

async function check(params, dbOpts) {
  const url = new URL("https://inscription.test/api/public/adherent-eligibility");
  for (const [k, v] of Object.entries({
    typeInscription: "renouvellement", lastName: "DUPONT", firstName: "Léa", birthDate: "2012-04-03", email: "Parent@Example.com", ...params,
  })) url.searchParams.set(k, v);
  const res = await onRequestGet({ request: new Request(url), env: { DB: fakeDb({ adherents: [ADHERENT], ...dbOpts }) } });
  return (await res.json()).data;
}

test("renouvellement vérifié + certificat validé encore valable : réutilisable, avec sa date de fin de validité", async () => {
  const data = await check({}, { registrations: [JOINED_LAST_SEASON] });
  assert.equal(data.renewalVerified, true);
  assert.equal(data.certificateReusable, true);
  assert.equal(data.certificateValidUntil, "2028-09-10");
});

test("certificat non validé, ou impossible à dater : pas de réutilisation", async () => {
  assert.equal((await check({}, { certificat: 0, registrations: [JOINED_LAST_SEASON] })).certificateReusable, false);
  assert.equal((await check({}, { registrations: [] })).certificateReusable, false);
});

test("certificat expiré (> 3 ans) : pas de réutilisation, aucune date divulguée", async () => {
  const old = { ...JOINED_LAST_SEASON, submitted_at: "2022-09-10T10:00:00.000Z" };
  const data = await check({}, { registrations: [old] });
  assert.equal(data.certificateReusable, false);
  assert.equal(data.certificateValidUntil, null);
});

test("identité non vérifiée (date de naissance ou e-mail faux) : rien n'est divulgué sur le certificat", async () => {
  for (const wrong of [{ birthDate: "2012-04-04" }, { email: "autre@example.com" }]) {
    const data = await check(wrong, { registrations: [JOINED_LAST_SEASON] });
    assert.equal(data.renewalVerified, false);
    assert.equal("certificateReusable" in data, false);
    assert.equal("certificateValidUntil" in data, false);
  }
});

test("première inscription : aucune information de certificat", async () => {
  const data = await check({ typeInscription: "nouvelle" }, { registrations: [JOINED_LAST_SEASON] });
  assert.equal(data.reason, "not_renewal");
  assert.equal("certificateReusable" in data, false);
});

test("l'éligibilité au tarif Bureau n'est pas modifiée par le calcul du certificat", async () => {
  const bureau = { ...ADHERENT, discipline: "Membre du Bureau" };
  const data = await check({}, { adherents: [bureau], registrations: [] });
  assert.equal(data.eligibleForBureauRate, true);
  assert.equal(data.certificateReusable, false);
});
