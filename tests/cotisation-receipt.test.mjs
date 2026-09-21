// Reçu de cotisation joint à l'e-mail de confirmation (src/routes/_lib/cotisation-receipt.js).
//
// Ce module est une COPIE de gestion/src/lib/pdf/cotisation-receipt.ts (les deux repos ne
// partagent aucun module) : les valeurs de référence ci-dessous sont les mêmes que celles de
// gestion/test/pdf-cotisation-receipt.test.ts. Si l'un de ces tests change ici, il doit changer
// là-bas — sinon le reçu joint à l'e-mail et celui du bouton « Reçu » divergeraient.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildCotisationReceipt,
  buildReceiptContent,
  generateCotisationReceiptPdf,
  paymentNote,
  registrationGoodsLines,
  registrationSeason,
  seasonLabelFromIso,
} from "../src/routes/_lib/cotisation-receipt.js";
import { calculateTotals } from "../src/routes/_lib/helpers.js";
import { measureTextWidth } from "../src/routes/_lib/pdf-engine.js";

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const NOW = new Date("2026-09-21T09:00:00Z");

const ADH = {
  id: "ab12cd34-5678-4abc-9def-0123456789ab",
  nom: "andrieu",
  prenom: "Mickaël",
  adresse: "12 chemin des Grands Prés",
  code_postal: "74200",
  ville: "Thonon-les-Bains",
  discipline: "Club",
  cotisation: 250,
  montant_pass_region: 0,
  paiement: "HelloAsso",
  date_inscription: "2026-09-08",
  date_fin_adhesion: "2027-06-30",
};

const reg = (dossier, over = {}) => ({
  id: "r1",
  statut: "payee",
  submitted_at: "2026-09-08T10:00:00.000Z",
  created_at: "2026-09-08T10:00:00.000Z",
  updated_at: "2026-09-08T10:05:00.000Z",
  dossier_json: typeof dossier === "string" ? dossier : JSON.stringify(dossier),
  ...over,
});

// Ce que calculateTotals() stocke pour un nouvel adhérent : 1 t-shirt + 1 pantalon obligatoires.
const NEW_MEMBER = {
  clothingOrder: { tshirtQty: 1, tshirtSize: "M", pantalonQty: 1, pantalonSize: "L" },
  computedTotals: {
    cotisation: 250, passRegionAmount: 0, passport: 0, clothingTotal: 40, extraProductsTotal: 0,
    tshirtQty: 1, pantalonQty: 1, pricingTshirt: 25, pricingPantalon: 15, orderItems: [], total: 290,
  },
};
const lines = (r) => {
  assert.ok(r.ok, r.message);
  return r.doc.lignes.map((l) => [l.designation, l.qte, l.pu, l.total]);
};

// ── Contenu : mêmes valeurs de référence que gestion ─────────────────────────

test("nouvel adhérent : t-shirt et pantalon (avec tailles) s'ajoutent à la cotisation, le total est ce qui a été facturé", () => {
  const r = buildCotisationReceipt(ADH, NOW, [reg(NEW_MEMBER)]);
  assert.deepEqual(lines(r), [
    ["Cotisation Club — saison 2026-2027", 1, 250, 250],
    ["T-shirt club AFFBC (taille M)", 1, 25, 25],
    ["Pantalon club AFFBC (taille L)", 1, 15, 15],
  ]);
  assert.equal(r.doc.total, 290);
  assert.equal(r.doc.total, NEW_MEMBER.computedTotals.total);
  assert.equal(r.doc.objet, "Inscription saison 2026-2027 : cotisation et articles commandés (inscription du 08/09/2026)");
  assert.equal(r.doc.numero, "REC-2026-2027-AB12CD34");
  assert.equal(r.doc.destinataire.nom, "Mickaël ANDRIEU");
  assert.deepEqual(r.doc.destinataire.lignes, ["12 chemin des Grands Prés", "74200 Thonon-les-Bains", "Adhérent n°AB12CD34", "Saison 2026-2027"]);
  assert.equal(r.doc.footerNote, "Mode de paiement : HelloAsso");
  assert.equal(r.filename, "Recu-cotisation-Mickael-ANDRIEU-2026-2027.pdf");
});

test("passeport + produit en option + Pass Région : tout figure ; le pied indique le réglé par l'adhérent", () => {
  const d = {
    clothingOrder: { tshirtQty: 1, tshirtSize: "S", pantalonQty: 1, pantalonSize: "M" },
    computedTotals: {
      cotisation: 220, passRegionAmount: 30, passport: 25, clothingTotal: 40, extraProductsTotal: 12,
      tshirtQty: 1, pantalonQty: 1, pricingTshirt: 25, pricingPantalon: 15,
      orderItems: [{ id: "p1", name: "Gourde AFFBC", quantity: 1, unitPrice: 12, size: "", total: 12 }],
      total: 220 + 25 + 40 + 12,
    },
  };
  const r = buildCotisationReceipt({ ...ADH, cotisation: 220, montant_pass_region: 30 }, NOW, [reg(d)]);
  assert.deepEqual(lines(r).map((l) => l[0]), [
    "Cotisation Club — saison 2026-2027", "Pass Région", "Passeport sportif",
    "T-shirt club AFFBC (taille S)", "Pantalon club AFFBC (taille M)", "Gourde AFFBC",
  ]);
  assert.equal(r.doc.total, 327);
  assert.equal(r.doc.total - 30, d.computedTotals.total); // = montant payé en ligne
  assert.equal(r.doc.footerNote, "Mode de paiement : HelloAsso (dont Pass Région : 30,00 €, soit 297,00 € réglés par l'adhérent)");
});

test("sans inscription en ligne : cotisation seule ; rien à recevoir : refusé", () => {
  assert.deepEqual(lines(buildCotisationReceipt(ADH, NOW, [])), [["Cotisation Club — saison 2026-2027", 1, 250, 250]]);
  assert.equal(buildCotisationReceipt({ ...ADH, cotisation: 0 }, NOW, []).ok, false);
});

test("cotisation à 0 mais articles payés : reçu des articles seulement", () => {
  const r = buildCotisationReceipt({ ...ADH, cotisation: 0 }, NOW, [reg(NEW_MEMBER)]);
  assert.deepEqual(lines(r).map((l) => l[0]), ["T-shirt club AFFBC (taille M)", "Pantalon club AFFBC (taille L)"]);
  assert.equal(r.doc.total, 40);
});

test("kit nouvel adhérent d'avant le 10/09/2026 repris ; ancien format sans prix : « Autres articles »", () => {
  const legacy = structuredClone(NEW_MEMBER);
  legacy.computedTotals.newMemberKit = 40;
  legacy.computedTotals.total = 330;
  assert.ok(lines(buildCotisationReceipt(ADH, NOW, [reg(legacy)])).map((l) => l[0]).includes("Kit nouvel adhérent"));

  const noPrice = structuredClone(NEW_MEMBER);
  delete noPrice.computedTotals.pricingTshirt;
  delete noPrice.computedTotals.pricingPantalon;
  assert.deepEqual(lines(buildCotisationReceipt(ADH, NOW, [reg(noPrice)])), [
    ["Cotisation Club — saison 2026-2027", 1, 250, 250],
    ["Autres articles", 1, 40, 40],
  ]);
});

test("inscription d'une autre saison, non aboutie ou illisible : ignorée", () => {
  const one = [["Cotisation Club — saison 2026-2027", 1, 250, 250]];
  assert.deepEqual(lines(buildCotisationReceipt(ADH, NOW, [reg(NEW_MEMBER, { submitted_at: "2025-09-10T09:00:00.000Z", created_at: "2025-09-10T09:00:00.000Z" })])), one);
  for (const statut of ["brouillon", "paiement_en_attente", "traitement_paiement", "echec_creation", "abandonnee"]) {
    assert.equal(lines(buildCotisationReceipt(ADH, NOW, [reg(NEW_MEMBER, { statut })])).length, 1, statut);
  }
  // statuts d'une inscription validée : « payee » et « paiement_planifie » (paiement en plusieurs fois)
  for (const statut of ["payee", "paiement_planifie"]) {
    assert.equal(lines(buildCotisationReceipt(ADH, NOW, [reg(NEW_MEMBER, { statut })])).length, 3, statut);
  }
  for (const bad of ["{pas du json", "", null, "[]", JSON.stringify({ clothingOrder: {} })]) {
    assert.equal(lines(buildCotisationReceipt(ADH, NOW, [reg(bad)])).length, 1);
  }
});

test("inscription déposée en JUIN pour la saison suivante : rattachée via son exercice", () => {
  const june = reg(NEW_MEMBER, { submitted_at: "2026-06-20T09:00:00.000Z", created_at: "2026-06-20T09:00:00.000Z", exercice_date_fin: "2027-06-30" });
  assert.equal(registrationSeason(june), "2026-2027");
  assert.equal(lines(buildCotisationReceipt(ADH, NOW, [june])).length, 3);
  assert.equal(registrationSeason(reg(NEW_MEMBER, { exercice_date_fin: "2026-06-30" })), "2025-2026");
  assert.equal(registrationSeason(reg(NEW_MEMBER, { exercice_date_fin: "n/a" })), "2026-2027");
  assert.equal(seasonLabelFromIso("2027-06-30"), "2026-2027");
  assert.equal(seasonLabelFromIso("2027-07-01"), "2027-2028");
});

test("plusieurs inscriptions dans la saison : la plus récente fait foi ; la cotisation suit la fiche", () => {
  const d2 = structuredClone(NEW_MEMBER);
  d2.clothingOrder.tshirtSize = "XL";
  const first = reg(NEW_MEMBER, { id: "r1", updated_at: "2026-09-08T10:05:00.000Z" });
  const second = reg(d2, { id: "r2", updated_at: "2026-09-12T08:00:00.000Z" });
  assert.equal(lines(buildCotisationReceipt(ADH, NOW, [first, second]))[1][0], "T-shirt club AFFBC (taille XL)");
  assert.equal(lines(buildCotisationReceipt(ADH, NOW, [second, first]))[1][0], "T-shirt club AFFBC (taille XL)");
  const corrected = buildCotisationReceipt({ ...ADH, cotisation: 200 }, NOW, [reg(NEW_MEMBER)]);
  assert.deepEqual(lines(corrected)[0], ["Cotisation Club — saison 2026-2027", 1, 200, 200]);
  assert.equal(corrected.doc.total, 240);
});

test("le numéro du reçu est stable (même adhérent + même saison), quel que soit le jour d'émission", () => {
  const a = buildCotisationReceipt(ADH, NOW, [reg(NEW_MEMBER)]);
  const b = buildCotisationReceipt(ADH, new Date("2027-02-03T08:00:00Z"), [reg(NEW_MEMBER)]);
  assert.equal(a.doc.numero, b.doc.numero);
  assert.notEqual(a.doc.dateLabel, b.doc.dateLabel);
  assert.equal(a.doc.dateLabel, "Émis le 21/09/2026");
});

test("adresse longue coupée (≤ 44 caractères, 3 lignes max) ; nom de fichier ASCII sûr", () => {
  const r = buildCotisationReceipt({ ...ADH, adresse: "Résidence Les Alpages Bâtiment B appartement 12 chemin des Grands Prés lieu-dit Les Vignes Hautes" }, NOW, []);
  assert.ok(r.ok);
  const addr = r.doc.destinataire.lignes.slice(0, -3);
  assert.ok(addr.length > 1 && addr.length <= 3);
  addr.forEach((l) => assert.ok(l.length <= 44, l));
  const f = buildCotisationReceipt({ ...ADH, nom: "d'Aubigné Müller", prenom: "Zoé" }, NOW, []);
  assert.equal(f.filename, "Recu-cotisation-Zoe-D-AUBIGNE-MULLER-2026-2027.pdf");
});

// ── Paiement en plusieurs fois (mêmes valeurs de référence que gestion) ───────

test("paiement en 3 fois, 1re échéance réglée : « réglés à ce jour » et « à prélever »", () => {
  const withPayment = (payment, statut = "paiement_planifie") => reg({ ...NEW_MEMBER, payment }, { statut });
  const footer = (r) => { assert.ok(r.ok); return r.doc.footerNote; };

  const r = buildCotisationReceipt(ADH, NOW, [withPayment({ installmentCount: 3, paidAmountCents: 9667, remainingAmountCents: 19333 })]);
  assert.equal(footer(r), "Mode de paiement : HelloAsso en 3 fois - 96,67 € réglés à ce jour, 193,33 € à prélever");
  assert.equal(r.doc.total, 290); // valeur de l'adhésion, pas le montant déjà encaissé

  assert.equal(footer(buildCotisationReceipt(ADH, NOW, [withPayment({ installmentCount: 3, paidAmountCents: 29000, remainingAmountCents: 0 }, "payee")])),
    "Mode de paiement : HelloAsso en 3 fois - intégralement réglé");
  assert.equal(footer(buildCotisationReceipt(ADH, NOW, [withPayment({ installmentCount: 3 })])), "Mode de paiement : HelloAsso en 3 fois");
  assert.equal(footer(buildCotisationReceipt(ADH, NOW, [withPayment({ installmentCount: 1 }, "payee")])), "Mode de paiement : HelloAsso");

  const d = { ...NEW_MEMBER, computedTotals: { ...NEW_MEMBER.computedTotals, cotisation: 220, passRegionAmount: 30, total: 260 }, payment: { installmentCount: 2, paidAmountCents: 13000, remainingAmountCents: 13000 } };
  assert.equal(footer(buildCotisationReceipt({ ...ADH, cotisation: 220, montant_pass_region: 30 }, NOW, [reg(d, { statut: "paiement_planifie" })])),
    "Mode de paiement : HelloAsso en 2 fois - 130,00 € réglés à ce jour, 130,00 € à prélever - dont Pass Région : 30,00 €");
});

test("l'état du paiement fourni par l'appelant (envoi juste après le paiement) prime sur celui du dossier", () => {
  const r = buildCotisationReceipt(ADH, NOW, [reg({ ...NEW_MEMBER, payment: { installmentCount: 3 } }, { statut: "paiement_planifie" })], {
    payment: { installmentCount: 3, paidAmountCents: 9667, remainingAmountCents: 19333 },
  });
  assert.ok(r.doc.footerNote.includes("96,67 € réglés à ce jour"));
});

test("le pied de page ne déborde jamais de la page, même dans le pire cas", () => {
  const limit = 182 * 2.8346; // 210 mm − 2 × 14 mm de marge, en points
  const worst = paymentNote("Virement bancaire", 60, 1234.5, { installmentCount: 3, paidAmountCents: 123450, remainingAmountCents: 246900 });
  assert.ok(measureTextWidth(worst, "F1", 7.3) <= limit, worst);
  for (const paiement of ["HelloAsso", "Chèque", "Espèces", ""]) {
    for (const pr of [0, 30, 60]) {
      const n = paymentNote(paiement, pr, 999.99, { installmentCount: 3, paidAmountCents: 33333, remainingAmountCents: 66666 });
      assert.ok(measureTextWidth(n, "F1", 7.3) <= limit, n);
    }
  }
});

// ── Réconciliation avec le VRAI calculateTotals() de ce projet ───────────────
// Le reçu doit toujours égaler ce qui a été facturé à l'adhérent (computedTotals.total = le montant
// du paiement HelloAsso), Pass Région en plus : c'est ce que les tests ci-dessus supposent.

test("pour des dossiers produits par le vrai calculateTotals(), total du reçu − Pass Région = montant facturé", () => {
  const pricing = { base: 250, family: 200, pro: 125, cseThales: 39, bureau: 0, newMemberKit: 40, passport: 25, tshirt: 25, pantalon: 15 };
  const catalog = [
    { id: "gourde", source: "gestion", active: true, name: "Gourde AFFBC", description: "", price: 12, requiresSize: false, defaultQtyNew: 0 },
    { id: "gants", source: "gestion", active: true, name: "Gants de boxe", description: "", price: 30, requiresSize: true, defaultQtyNew: 0 },
  ];
  const scenarios = [
    { practice: { formulaCode: "base", typeInscription: "nouvelle" }, clothing: {}, extra: [] }, // le serveur impose 1 + 1
    { practice: { formulaCode: "base", typeInscription: "nouvelle", passRegionEnabled: true, passRegionAmount: 30, passportEnabled: true },
      clothing: { tshirtQty: 1, tshirtSize: "M", pantalonQty: 1, pantalonSize: "L" }, extra: [{ id: "gourde", quantity: 2 }, { id: "gants", quantity: 1, size: "L" }] },
    { practice: { formulaCode: "base", typeInscription: "renouvellement" }, clothing: {}, extra: [] },
    { practice: { formulaCode: "family", typeInscription: "renouvellement" }, clothing: { tshirtQty: 2, tshirtSize: "S", pantalonQty: 1, pantalonSize: "S" }, extra: [] },
    { practice: { formulaCode: "cse_thales", typeInscription: "nouvelle" }, clothing: { tshirtQty: 1, tshirtSize: "XL", pantalonQty: 1, pantalonSize: "XL" }, extra: [] },
  ];
  for (const sc of scenarios) {
    const totals = calculateTotals(sc.practice, pricing, sc.clothing, sc.extra, catalog);
    // exactement comme inscription.js : { ...payload, clothingOrder: effectiveClothingOrder, computedTotals: totals }
    const dossier = { practice: sc.practice, clothingOrder: { ...sc.clothing, tshirtQty: totals.tshirtQty, pantalonQty: totals.pantalonQty }, computedTotals: totals };
    const adherent = { ...ADH, cotisation: totals.cotisation, montant_pass_region: totals.passRegionAmount || 0 };
    const r = buildCotisationReceipt(adherent, NOW, [reg(dossier)]);
    assert.ok(r.ok);
    assert.equal(euros(r.doc.total - (totals.passRegionAmount || 0)), totals.total, JSON.stringify(sc.practice));
  }
});
const euros = (n) => Math.round(n * 100) / 100;

// ── PDF ──────────────────────────────────────────────────────────────────────

const LOGO_PNG = fs.readFileSync(new URL("../public/assets/Logo_1_nnoir_copie-removebg-preview.png", import.meta.url));
const ENV_WITH_LOGO = {
  ASSETS: {
    fetch: async (url) => {
      assert.match(String(url), /Logo_1_nnoir_copie-removebg-preview\.png$/);
      return new Response(LOGO_PNG);
    },
  },
};

// Chaque entrée de la table xref doit pointer sur « N 0 obj » : ajouter le bloc /Info ne doit
// décaler aucun octet.
function assertXrefIsConsistent(bytes) {
  const txt = latin1(bytes);
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(txt)?.[1]);
  assert.ok(Number.isFinite(startxref));
  assert.equal(txt.slice(startxref, startxref + 4), "xref");
  const count = Number(/xref\s+0 (\d+)/.exec(txt.slice(startxref))[1]);
  const entries = [...txt.slice(startxref).matchAll(/(\d{10}) \d{5} ([nf]) /g)];
  assert.equal(entries.length, count);
  entries.forEach((m, i) => {
    if (m[2] === "n") assert.equal(txt.slice(Number(m[1]), Number(m[1]) + `${i} 0 obj`.length), `${i} 0 obj`);
  });
  assert.equal(Number(/\/Size (\d+)/.exec(txt)[1]), count);
}

test("PDF du reçu : nom accentué, titre « REÇU », articles avec taille et montants en €, logo embarqué", async () => {
  const out = await generateCotisationReceiptPdf(ADH, [reg(NEW_MEMBER)], ENV_WITH_LOGO, { now: NOW });
  assert.ok(out);
  assert.equal(out.numero, "REC-2026-2027-AB12CD34");
  assert.equal(out.total, 290);
  assert.equal(out.filename, "Recu-cotisation-Mickael-ANDRIEU-2026-2027.pdf");
  const txt = latin1(out.bytes);
  assert.ok(txt.startsWith("%PDF-") && txt.trimEnd().endsWith("%%EOF"));
  assert.ok(txt.includes("(Mickaël ANDRIEU)"), "le nom garde son tréma");
  assert.ok(txt.includes("REÇU DE COTISATION"));
  assert.ok(txt.includes("(T-shirt club AFFBC \\(taille M\\))"));
  assert.ok(txt.includes("(Pantalon club AFFBC \\(taille L\\))"));
  for (const amount of ["250,00", "25,00", "15,00", "290,00"]) assert.ok(txt.includes(`${amount} \u0080`), `${amount} € (octet WinAnsi 0x80)`);
  assert.ok(txt.includes("/Subtype /Image"), "le vrai logo du club est embarqué (pas le médaillon-texte)");
  assertXrefIsConsistent(out.bytes);
});

test("PDF du reçu : titre dans les métadonnées (UTF-16BE), lisible dans l'onglet du navigateur", async () => {
  const out = await generateCotisationReceiptPdf(ADH, [reg(NEW_MEMBER)], ENV_WITH_LOGO, { now: NOW });
  const hex = /\/Title <FEFF([0-9A-F]+)>/.exec(latin1(out.bytes))?.[1];
  assert.ok(hex);
  const title = Buffer.from(hex, "hex").swap16().toString("utf16le");
  assert.equal(title, "Reçu de cotisation REC-2026-2027-AB12CD34 — Mickaël ANDRIEU");
});

test("PDF du reçu : sans binding ASSETS (ou asset illisible), repli sur le médaillon-texte sans jamais lever", async () => {
  for (const env of [null, {}, { ASSETS: { fetch: async () => new Response("", { status: 404 }) } }, { ASSETS: { fetch: async () => { throw new Error("boom"); } } }]) {
    const out = await generateCotisationReceiptPdf(ADH, [reg(NEW_MEMBER)], env, { now: NOW });
    assert.ok(out, "un PDF est produit");
    const txt = latin1(out.bytes);
    assert.ok(txt.includes("REÇU DE COTISATION"));
    assert.ok(!txt.includes("/Subtype /Image"));
    assertXrefIsConsistent(out.bytes);
  }
});

test("PDF du reçu : null quand il n'y a rien à recevoir (inscription gratuite, total nul)", async () => {
  assert.equal(await generateCotisationReceiptPdf({ ...ADH, cotisation: 0 }, [], ENV_WITH_LOGO, { now: NOW }), null);
});

test("PDF du reçu : le pied de page décrit le paiement en 3 fois (octets WinAnsi corrects)", async () => {
  const out = await generateCotisationReceiptPdf(ADH, [reg(NEW_MEMBER, { statut: "paiement_planifie" })], ENV_WITH_LOGO, {
    now: NOW,
    payment: { installmentCount: 3, paidAmountCents: 9667, remainingAmountCents: 19333 },
  });
  const txt = latin1(out.bytes);
  assert.ok(txt.includes("en 3 fois - 96,67 \u0080 r\u00e9gl\u00e9s \u00e0 ce jour, 193,33 \u0080 \u00e0 pr\u00e9lever"));
});

test("le reçu ne contient aucune information de santé du dossier (contrairement au récapitulatif)", async () => {
  const withHealth = { ...NEW_MEMBER, health: { qsSport: { chestPain: "yes", fainting: "yes" } }, consents: { imageRights: "no" } };
  const out = await generateCotisationReceiptPdf(ADH, [reg(withHealth)], ENV_WITH_LOGO, { now: NOW });
  const txt = latin1(out.bytes).toLowerCase();
  for (const forbidden of ["poitrine", "affirmative", "questionnaire", "certificat", "droit a l'image", "droit à l'image", "malaise"]) {
    assert.ok(!txt.includes(forbidden), `« ${forbidden} » ne doit pas figurer sur le reçu`);
  }
});

test("registrationGoodsLines : dossier vide ou absent → aucune ligne, sans lever", () => {
  assert.deepEqual(registrationGoodsLines(null), []);
  assert.deepEqual(registrationGoodsLines({}), []);
  assert.deepEqual(registrationGoodsLines({ computedTotals: "x" }), []);
  assert.equal(buildReceiptContent({ ...ADH }, [], NOW).ok, true);
});
