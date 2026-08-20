import test from "node:test";
import assert from "node:assert/strict";

import { disciplineFromFormula } from "../src/routes/_lib/helpers.js";

// Régression du 20/08/2026 : status.js ne reconnaissait que la formule
// 'bureau' et renvoyait 'Club' pour toutes les autres, y compris
// 'cse_thales' — alors que ADH_TYPES (gestion) prévoit bien un type
// "CSE Thalès" dédié. Un adhérent inscrit avec ce tarif se retrouvait donc
// classé "Club", invisible du filtre "CSE Thalès" côté gestion.
test("disciplineFromFormula maps cse_thales to CSE Thalès", () => {
  assert.equal(disciplineFromFormula("cse_thales"), "CSE Thalès");
});

test("disciplineFromFormula maps bureau to Membre du Bureau", () => {
  assert.equal(disciplineFromFormula("bureau"), "Membre du Bureau");
});

test("disciplineFromFormula defaults base/family/pro to Club", () => {
  assert.equal(disciplineFromFormula("base"), "Club");
  assert.equal(disciplineFromFormula("family"), "Club");
  assert.equal(disciplineFromFormula("pro"), "Club");
});

test("disciplineFromFormula defaults unknown/empty/missing formulas to Club", () => {
  assert.equal(disciplineFromFormula("une-formule-future-pas-encore-mappee"), "Club");
  assert.equal(disciplineFromFormula(""), "Club");
  assert.equal(disciplineFromFormula(undefined), "Club");
  assert.equal(disciplineFromFormula(null), "Club");
});
