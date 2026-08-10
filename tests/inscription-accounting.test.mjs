import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInscriptionSaleLines,
  buildVenteTenueJournalCreditLines,
} from "../src/routes/api/public/payment/helloasso/status.js";

const TOTALS = {
  newMemberKit: 40,
  passport: 25,
  tshirtQty: 2,
  pantalonQty: 1,
  pricingTshirt: 25,
  pricingPantalon: 15,
  extraProductsTotal: 30,
  orderItems: [
    { name: "Protege-tibias", size: "M", quantity: 1, unitPrice: 30 },
  ],
};

test("buildInscriptionSaleLines details every inscription add-on", () => {
  const lignes = buildInscriptionSaleLines(TOTALS);

  assert.deepEqual(
    lignes.map((ligne) => ligne.desc),
    [
      "Vente kit nouvel adhérent",
      "Vente passeport sportif",
      "Vente t-shirt club AFFBC",
      "Vente pantalon club AFFBC",
      "Vente Protege-tibias (M)",
    ],
  );
  assert.equal(
    lignes.reduce((sum, ligne) => sum + ligne.qte * ligne.pu, 0),
    160,
  );
});

test("buildVenteTenueJournalCreditLines keeps accounting compact by account", () => {
  const entries = buildVenteTenueJournalCreditLines(
    TOTALS,
    {
      date_op: "2026-08-10",
      pieceBase: "VTE-abc12345",
      source_type: "facture",
      source_id: "facture-1",
      source_logiciel: "inscription-web",
      exercice_id: "exo-1",
      created_at: "2026-08-10T00:00:00.000Z",
      updated_at: "2026-08-10T00:00:00.000Z",
    },
    "Vente - Test",
  );

  assert.deepEqual(
    entries.map((entry) => [entry.piece, entry.compte, entry.credit]),
    [
      ["VTE-abc12345-ART", "707 - Ventes vêtements et équipements", 135],
      ["VTE-abc12345-PAS", "7562 - Cotisations licences et adhésions annexes", 25],
    ],
  );
  assert.equal(entries.some((entry) => "pieceBase" in entry), false);
});
