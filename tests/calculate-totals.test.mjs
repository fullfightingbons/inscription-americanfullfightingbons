import test from "node:test";
import assert from "node:assert/strict";

import { calculateTotals } from "../src/routes/_lib/helpers.js";

const PRICING = {
  base: 250,
  family: 200,
  pro: 125,
  cseThales: 39,
  bureau: 0,
  newMemberKit: 40,
  passport: 25,
  tshirt: 25,
  pantalon: 15,
};

test("calculateTotals accepts the two whitelisted Pass Région amounts", () => {
  const totalsGarcon = calculateTotals(
    { formulaCode: "base", typeInscription: "renouvellement", passRegionEnabled: true, passRegionAmount: 30 },
    PRICING,
  );
  assert.equal(totalsGarcon.cotisation, 220);

  const totalsFille = calculateTotals(
    { formulaCode: "base", typeInscription: "renouvellement", passRegionEnabled: true, passRegionAmount: 60 },
    PRICING,
  );
  assert.equal(totalsFille.cotisation, 190);
});

test("calculateTotals rejects a Pass Région amount that is not one of the allowed values", () => {
  assert.throws(
    () =>
      calculateTotals(
        { formulaCode: "base", typeInscription: "renouvellement", passRegionEnabled: true, passRegionAmount: 250 },
        PRICING,
      ),
    /Montant de remise Pass Région invalide/,
  );
});

test("calculateTotals rejects an arbitrary client-supplied Pass Région amount even if smaller than the base fee", () => {
  // Régression du bug : avant correctif, n'importe quelle valeur entre 0 et le
  // tarif de base était acceptée sans validation, permettant de réduire la
  // cotisation à volonté en modifiant simplement la requête.
  assert.throws(
    () =>
      calculateTotals(
        { formulaCode: "base", typeInscription: "renouvellement", passRegionEnabled: true, passRegionAmount: 1 },
        PRICING,
      ),
    /Montant de remise Pass Région invalide/,
  );
});

test("calculateTotals ignores passRegionAmount entirely when passRegionEnabled is false", () => {
  const totals = calculateTotals(
    { formulaCode: "base", typeInscription: "renouvellement", passRegionEnabled: false, passRegionAmount: 999 },
    PRICING,
  );
  assert.equal(totals.cotisation, 250);
  assert.equal(totals.passRegionAmount, 0);
});

test("calculateTotals computes clothing totals for a new member using server-side prices", () => {
  const totals = calculateTotals(
    { formulaCode: "base", typeInscription: "nouvelle", passRegionEnabled: false, passportEnabled: false },
    PRICING,
    {},
  );
  // Nouvel adhérent : t-shirt + pantalon par défaut (quantité 1 chacun),
  // plus le supplément "tenue nouvel adhérent" (newMemberKit) qui s'ajoute
  // toujours au total tel que défini par la tarification du club.
  assert.equal(totals.tshirtQty, 1);
  assert.equal(totals.pantalonQty, 1);
  assert.equal(totals.clothingTotal, 25 + 15);
  assert.equal(totals.total, 250 + PRICING.newMemberKit + 25 + 15);
});

test("calculateTotals throws on an unknown formulaCode", () => {
  assert.throws(
    () => calculateTotals({ formulaCode: "inconnu", typeInscription: "nouvelle" }, PRICING),
    /Formule tarifaire invalide/,
  );
});
