import test from "node:test";
import assert from "node:assert/strict";

import { validatePayload } from "../src/routes/api/public/inscription.js";

// Formate une date ISO relative à aujourd'hui (en jours) plutôt que des
// dates en dur : un test avec "demain"/"il y a 20 ans" codé en dur sur une
// date fixe finirait par se dérégler avec le temps (dates qui glissent dans
// le passé/futur par rapport à ce que le test voulait vérifier).
function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const YEAR_DAYS = 365;

const BASE_HEALTH_QS = {
  familyCardiacDeath: "no",
  chestPain: "no",
  wheezing: "no",
  fainting: "no",
  sportStop: "no",
  longTermTreatment: "no",
  bonePain: "no",
  practiceInterrupted: "no",
  medicalAdviceNeeded: "no",
};

// Construit un payload adulte valide, avec possibilité de surcharger chaque
// section (fusion superficielle par section, cohérent avec la façon dont
// validatePayload lit chaque bloc du payload public).
function buildPayload(overrides = {}) {
  return {
    identity: {
      lastName: "Dupont",
      firstName: "Jean",
      birthDate: isoDate(-30 * YEAR_DAYS),
      birthPlace: "Thonon-les-Bains",
      ...overrides.identity,
    },
    contact: {
      address1: "1 rue du Chablais",
      postalCode: "74200",
      city: "Thonon-les-Bains",
      phonePrimary: "0600000000",
      email: "jean.dupont@example.com",
      ...overrides.contact,
    },
    emergency: {
      lastName: "Dupont",
      firstName: "Marie",
      phonePrimary: "0600000001",
      ...overrides.emergency,
    },
    legalRepresentative: { ...overrides.legalRepresentative },
    practice: {
      typeInscription: "nouvelle",
      practiceType: "loisir",
      formulaCode: "base",
      passRegionEnabled: false,
      ...overrides.practice,
    },
    health: {
      qsSport: { ...BASE_HEALTH_QS, ...(overrides.health?.qsSport || {}) },
    },
    consents: {
      rulesAccepted: true,
      imageRights: "yes",
      applicantSignatureName: "Jean Dupont",
      signedAt: isoDate(0),
      ...overrides.consents,
    },
    payment: {
      method: "helloasso",
      installmentCount: 1,
      ...overrides.payment,
    },
  };
}

// Variante mineure : date de naissance ~10 ans + représentant légal complet,
// toujours surchargeable section par section.
function buildMinorPayload(overrides = {}) {
  return buildPayload({
    ...overrides,
    identity: { birthDate: isoDate(-10 * YEAR_DAYS), ...overrides.identity },
    legalRepresentative: {
      lastName: "Dupont",
      firstName: "Marie",
      role: "mere",
      signatureName: "Marie Dupont",
      city: "Thonon-les-Bains",
      signedAt: isoDate(0),
      ...overrides.legalRepresentative,
    },
    // Payload mineur réaliste : le formulaire (validateStep case 6) ne
    // collecte jamais applicantSignatureName pour un mineur, seulement
    // legalConsentSignatureName (signature du représentant légal pour le
    // droit à l'image — distincte de legalRepresentative.signatureName
    // ci-dessus, qui couvre l'autorisation parentale elle-même).
    consents: { applicantSignatureName: "", legalConsentSignatureName: "Marie Dupont", ...overrides.consents },
  });
}

test("validatePayload accepts a coherent adult payload", () => {
  const result = validatePayload(buildPayload());
  assert.equal(result.minor, false);
});

test("validatePayload accepts a coherent minor payload with same-day signatures", () => {
  const result = validatePayload(buildMinorPayload());
  assert.equal(result.minor, true);
});

test("validatePayload rejects a birth date in the future", () => {
  assert.throws(
    () => validatePayload(buildPayload({ identity: { birthDate: isoDate(1) } })),
    /naissance ne peut pas être dans le futur/,
  );
});

test("validatePayload rejects an implausibly old birth date", () => {
  assert.throws(
    () => validatePayload(buildPayload({ identity: { birthDate: "1900-01-01" } })),
    /date de naissance semble incorrecte/,
  );
});

test("validatePayload rejects a parental authorization signed in the future", () => {
  assert.throws(
    () => validatePayload(buildMinorPayload({ legalRepresentative: { signedAt: isoDate(1) } })),
    /autorisation parentale ne peut pas être dans le futur/,
  );
});

test("validatePayload rejects a parental authorization signed before the child's birth date", () => {
  assert.throws(
    () =>
      validatePayload(
        buildMinorPayload({
          identity: { birthDate: isoDate(-10 * YEAR_DAYS) },
          legalRepresentative: { signedAt: isoDate(-20 * YEAR_DAYS) },
        }),
      ),
    /autorisation parentale ne peut pas être antérieure à la date de naissance/,
  );
});

test("validatePayload rejects a final consent signed in the future", () => {
  assert.throws(
    () => validatePayload(buildPayload({ consents: { signedAt: isoDate(1) } })),
    /signature ne peut pas être dans le futur/,
  );
});

test("validatePayload rejects a final consent signed before the applicant's birth date", () => {
  assert.throws(
    () =>
      validatePayload(
        buildPayload({
          identity: { birthDate: isoDate(-30 * YEAR_DAYS) },
          consents: { signedAt: isoDate(-40 * YEAR_DAYS) },
        }),
      ),
    /signature ne peut pas être antérieure à la date de naissance/,
  );
});

// Bug du 10/09/2026 : validatePayload exigeait toujours
// consents.applicantSignatureName, même pour un mineur — alors que le
// formulaire public (validateStep case 6) ne collecte QUE
// legalConsentSignatureName dans ce cas. Un dossier mineur valide côté
// formulaire était donc rejeté à l'envoi avec "Signature du pratiquant
// obligatoire". Le fixture buildMinorPayload() ci-dessus fournit toujours
// applicantSignatureName (hérité de buildPayload) : il masquait ce bug côté
// tests. Les trois tests suivants reflètent un payload mineur réaliste (sans
// applicantSignatureName) pour éviter de régresser silencieusement.
test("validatePayload accepts a minor payload without the applicant's own signature", () => {
  const result = validatePayload(
    buildMinorPayload({
      consents: { applicantSignatureName: "", legalConsentSignatureName: "Marie Dupont" },
    }),
  );
  assert.equal(result.minor, true);
});

test("validatePayload rejects a minor payload missing the legal representative's consent signature", () => {
  assert.throws(
    () =>
      validatePayload(
        buildMinorPayload({
          consents: { applicantSignatureName: "", legalConsentSignatureName: "" },
        }),
      ),
    /Signature du représentant légal \(droit à l'image\) obligatoire/,
  );
});

test("validatePayload still rejects an adult payload missing the applicant's own signature", () => {
  assert.throws(
    () => validatePayload(buildPayload({ consents: { applicantSignatureName: "" } })),
    /Signature du pratiquant obligatoire/,
  );
});

test("validatePayload rejects a final consent signed before the parental authorization", () => {
  assert.throws(
    () =>
      validatePayload(
        buildMinorPayload({
          legalRepresentative: { signedAt: isoDate(0) },
          consents: { signedAt: isoDate(-1) },
        }),
      ),
    /signature ne peut pas être antérieure à la date de l'autorisation parentale/,
  );
});
