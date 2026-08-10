import test from "node:test";
import assert from "node:assert/strict";

import { generateAdherentPdf, fetchPhotoDocument } from "../src/routes/_lib/pdf.js";

const MINIMAL_REGISTRATION = {
  id: "AFFBC-TEST-0001",
  identity: { lastName: "Test", firstName: "Adherent" },
  contact: {},
  emergency: {},
  practice: {},
  health: {},
  clothingOrder: {},
  consents: {},
  computedTotals: {},
  payment: {},
};

function isPdf(bytes) {
  const header = Buffer.from(bytes.slice(0, 5)).toString("latin1");
  const tail = Buffer.from(bytes.slice(-6)).toString("latin1");
  return header === "%PDF-" && tail.includes("%%EOF");
}

test("generateAdherentPdf produces a valid PDF with only the required minimum fields", async () => {
  const bytes = await generateAdherentPdf(MINIMAL_REGISTRATION, null, null);
  assert.ok(isPdf(bytes), "output should start with %PDF- and end with %%EOF");
  assert.ok(bytes.length > 1000, "output should not be a near-empty/broken document");
});

test("generateAdherentPdf works without a photo or env (logo/photo fallback paths)", async () => {
  // photo=null et env=null exercisent les deux replis (cadre "Photo d'identite"
  // vide, medaillon-texte a la place du logo) — ne doit jamais lever.
  await assert.doesNotReject(() => generateAdherentPdf(MINIMAL_REGISTRATION, null, null));
});

test("generateAdherentPdf handles a full multi-page dossier (health flags, 3x installments, extra order items)", async () => {
  const registration = {
    ...MINIMAL_REGISTRATION,
    seasonLabel: "2026-2027",
    submittedAt: "2026-08-09",
    identity: { lastName: "Dupont", firstName: "Emilie", birthDate: "14/03/2012", birthPlace: "Thonon-les-Bains" },
    contact: { address1: "12 rue Test", postalCode: "74890", city: "Bons-en-Chablais", phonePrimary: "0600000000", email: "test@example.com" },
    emergency: { lastName: "Dupont", firstName: "Marc", phonePrimary: "0611111111" },
    practice: { typeInscription: "nouvelle", practiceType: "loisir", formulaCode: "base", passportEnabled: true, installmentCount: 3 },
    health: { qsSport: { chestPain: "yes", wheezing: "yes" } }, // exercise the health-warning path
    clothingOrder: { tshirtQty: 1, tshirtSize: "M", pantalonQty: 1, pantalonSize: "L" },
    consents: { rulesAccepted: true, insuranceAcknowledged: true, imageRights: "yes", city: "Bons-en-Chablais", signedAt: "09/08/2026", applicantSignatureName: "Marc Dupont" },
    computedTotals: {
      formulaLabel: "Formule de base", cotisation: 220, clothingTotal: 40, extraProductsTotal: 0, total: 260,
      orderItems: [{ name: "Protege-tibias", size: "M", unitPrice: 25, quantity: 1, total: 25 }],
    },
    payment: { installmentCount: 3 },
  };
  const bytes = await generateAdherentPdf(registration, null, null);
  assert.ok(isPdf(bytes));
  // Deux "/Type /Page" attendus (S1-S6 + questionnaire + engagements deborde
  // sur une 2e page avec ce jeu de donnees, comme en production) — verifie
  // qu'on ne regresse pas vers un document tronque a une seule page.
  const asText = Buffer.from(bytes).toString("latin1");
  const pageObjectCount = (asText.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
  assert.ok(pageObjectCount >= 2, `expected a multi-page document, got ${pageObjectCount} page object(s)`);
});

test("fetchPhotoDocument returns null when documents_json has no photo reference", async () => {
  const result = await fetchPhotoDocument({}, "{}");
  assert.equal(result, null);
});
