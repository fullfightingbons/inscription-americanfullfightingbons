import test from "node:test";
import assert from "node:assert/strict";

import { checkBlacklist } from "../src/routes/api/public/inscription.js";

// Faux D1 minimal : seule la forme utilisée par checkBlacklist compte
// (`db.prepare(sql).all()` → { results }), pas une vraie base.
function fakeDb(blacklistedRows) {
  return {
    prepare(_sql) {
      return {
        async all() {
          return { results: blacklistedRows };
        },
      };
    },
  };
}

function buildPayload(overrides = {}) {
  return {
    identity: {
      lastName: "Dupont",
      firstName: "Jean",
      birthDate: "1990-05-12",
      ...overrides.identity,
    },
  };
}

test("checkBlacklist : bloque une identité présente dans les adhérents blacklistés", async () => {
  const db = fakeDb([{ nom: "Dupont", prenom: "Jean", naissance: "1990-05-12" }]);
  assert.equal(await checkBlacklist(db, buildPayload()), true);
});

test("checkBlacklist : ne bloque pas une identité absente de la liste", async () => {
  const db = fakeDb([{ nom: "Martin", prenom: "Alice", naissance: "1985-01-01" }]);
  assert.equal(await checkBlacklist(db, buildPayload()), false);
});

test("checkBlacklist : ne bloque pas sur un simple homonyme de nom (prénom différent)", async () => {
  const db = fakeDb([{ nom: "Dupont", prenom: "Marie", naissance: "1990-05-12" }]);
  assert.equal(await checkBlacklist(db, buildPayload()), false);
});

test("checkBlacklist : ne bloque pas si la date de naissance diffère", async () => {
  const db = fakeDb([{ nom: "Dupont", prenom: "Jean", naissance: "1991-05-12" }]);
  assert.equal(await checkBlacklist(db, buildPayload()), false);
});

test("checkBlacklist : ignore les accents et la casse (même logique que findMatchingAdherent)", async () => {
  const db = fakeDb([{ nom: "héloïse", prenom: "danaï", naissance: "1990-05-12" }]);
  const payload = buildPayload({ identity: { lastName: "HÉLOÏSE", firstName: "Danai" } });
  assert.equal(await checkBlacklist(db, payload), true);
});

test("checkBlacklist : tolère un format de date FR stocké côté adhérent (JJ/MM/AAAA)", async () => {
  const db = fakeDb([{ nom: "Dupont", prenom: "Jean", naissance: "12/05/1990" }]);
  assert.equal(await checkBlacklist(db, buildPayload()), true);
});

test("checkBlacklist : renvoie false sans interroger la logique de correspondance si un champ d'identité manque", async () => {
  const db = fakeDb([{ nom: "Dupont", prenom: "Jean", naissance: "1990-05-12" }]);
  assert.equal(await checkBlacklist(db, buildPayload({ identity: { lastName: "" } })), false);
});

test("checkBlacklist : liste de blacklist vide → jamais bloqué", async () => {
  const db = fakeDb([]);
  assert.equal(await checkBlacklist(db, buildPayload()), false);
});
