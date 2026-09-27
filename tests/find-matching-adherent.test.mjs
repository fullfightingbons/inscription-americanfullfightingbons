import test from "node:test";
import assert from "node:assert/strict";

import { findMatchingAdherent as findMatchingAdherentFree } from "../src/routes/_lib/free-registration.js";
import { findMatchingAdherent as findMatchingAdherentHelloAsso } from "../src/routes/api/public/payment/helloasso/status.js";

// Faux D1 minimal : seule la forme utilisée par findMatchingAdherent compte
// (`db.prepare(sql).all()` → { results }), pas une vraie base. La requête
// n'a plus de paramètres liés (filtrage fait en JS, cf. commentaire dans
// free-registration.js/status.js), donc pas besoin de simuler `.bind()`.
function fakeDb(rows) {
  return {
    prepare(_sql) {
      return {
        async all() {
          return { results: rows };
        },
      };
    },
  };
}

function buildPayload(overrides = {}) {
  return {
    identity: {
      lastName: "Grallien",
      firstName: "Laurent",
      birthDate: "1980-05-12",
      ...overrides.identity,
    },
    contact: {
      email: "laurent@example.test",
      ...overrides.contact,
    },
  };
}

// Testé deux fois (free-registration.js et helloasso/status.js) : les deux
// modules ont exactement la même implémentation, dupliquée volontairement
// (cf. commentaire en tête de free-registration.js — indépendance du flux
// HelloAsso). On vérifie donc qu'elles se comportent bien à l'identique,
// plutôt que de supposer que l'une suit l'autre.
for (const [label, findMatchingAdherent] of [
  ["free-registration.js", findMatchingAdherentFree],
  ["payment/helloasso/status.js", findMatchingAdherentHelloAsso],
]) {
  test(`findMatchingAdherent (${label}) : reconnaît la même personne malgré une casse différente sur le prénom (cas GRALLIEN)`, async () => {
    const db = fakeDb([
      { id: "old", nom: "GRALLIEN", prenom: "Laurent", naissance: "1980-05-12", email: "laurent@example.test" },
    ]);
    const found = await findMatchingAdherent(db, buildPayload({ identity: { firstName: "LAURENT" } }));
    assert.equal(found?.id, "old");
  });

  test(`findMatchingAdherent (${label}) : ignore les accents en plus de la casse`, async () => {
    const db = fakeDb([
      { id: "old", nom: "HÉLOÏSE", prenom: "DANAÏ", naissance: "1990-05-12", email: "heloise@example.test" },
    ]);
    const found = await findMatchingAdherent(
      db,
      buildPayload({ identity: { lastName: "heloise", firstName: "danai", birthDate: "1990-05-12" }, contact: { email: "heloise@example.test" } }),
    );
    assert.equal(found?.id, "old");
  });

  test(`findMatchingAdherent (${label}) : tolère un format de date FR stocké côté adhérent (JJ/MM/AAAA)`, async () => {
    const db = fakeDb([
      { id: "old", nom: "GRALLIEN", prenom: "LAURENT", naissance: "12/05/1980", email: "laurent@example.test" },
    ]);
    const found = await findMatchingAdherent(db, buildPayload());
    assert.equal(found?.id, "old");
  });

  test(`findMatchingAdherent (${label}) : aucune fiche correspondante → null (nouvel adhérent)`, async () => {
    const db = fakeDb([
      { id: "other", nom: "MARTIN", prenom: "ALICE", naissance: "1985-01-01", email: "alice@example.test" },
    ]);
    const found = await findMatchingAdherent(db, buildPayload());
    assert.equal(found, null);
  });

  test(`findMatchingAdherent (${label}) : deux fiches partageant nom/prénom/naissance sans email correspondant → null (homonymie, on ne devine pas)`, async () => {
    const db = fakeDb([
      { id: "a", nom: "GRALLIEN", prenom: "LAURENT", naissance: "1980-05-12", email: "un-autre@example.test" },
      { id: "b", nom: "GRALLIEN", prenom: "LAURENT", naissance: "1980-05-12", email: "encore-un-autre@example.test" },
    ]);
    const found = await findMatchingAdherent(db, buildPayload());
    assert.equal(found, null);
  });

  test(`findMatchingAdherent (${label}) : l'email permet de lever l'ambiguïté entre deux homonymes`, async () => {
    const db = fakeDb([
      { id: "a", nom: "GRALLIEN", prenom: "LAURENT", naissance: "1980-05-12", email: "laurent@example.test" },
      { id: "b", nom: "GRALLIEN", prenom: "LAURENT", naissance: "1980-05-12", email: "un-homonyme@example.test" },
    ]);
    const found = await findMatchingAdherent(db, buildPayload());
    assert.equal(found?.id, "a");
  });

  test(`findMatchingAdherent (${label}) : email différent mais identité exacte et non ambiguë → repli sur nom/prénom/naissance`, async () => {
    const db = fakeDb([
      { id: "old", nom: "GRALLIEN", prenom: "LAURENT", naissance: "1980-05-12", email: "ancien-email@example.test" },
    ]);
    const found = await findMatchingAdherent(db, buildPayload({ contact: { email: "nouvel-email@example.test" } }));
    assert.equal(found?.id, "old");
  });
}
