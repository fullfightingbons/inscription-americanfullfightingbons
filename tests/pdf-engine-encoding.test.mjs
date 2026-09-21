// Encodage du moteur PDF (src/routes/_lib/pdf-engine.js) : accents et symbole €.
//
// safe() supprimait TOUS les accents (« Mickaël » → « Mickael ») et remplaçait € par une espace :
// les noms et adresses des adhérents sortaient altérés et les montants sans devise, sur le dossier
// récapitulatif comme sur les reçus. Le moteur est le même pour les deux (cf. pdf.js et
// document-template.js), donc ces tests couvrent aussi le récapitulatif.
// Même correctif que la copie de gestion (gestion/src/lib/pdf/pdf-engine.ts) : garder en phase.

import test from "node:test";
import assert from "node:assert/strict";

import { safe, measureTextWidth, PdfBuilder, buildPdfDocument } from "../src/routes/_lib/pdf-engine.js";
import { generateAdherentPdf } from "../src/routes/_lib/pdf.js";

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

test("safe() conserve les lettres accentuées du français et traduit € en octet WinAnsi 0x80", () => {
  assert.equal(safe("Mickaël Élise Çelik Noël œuvre"), "Mickaël Élise Çelik Noël \u009Cuvre");
  assert.equal(safe("250,00 €"), "250,00 \u0080");
  assert.equal(safe("Reçu de cotisation — saison"), "Reçu de cotisation - saison"); // tiret long → '-' (inchangé)
});

test("safe() est idempotent : textWrapped() puis text() repassent chacun dans safe()", () => {
  for (const s of ["Mickaël — 12,50 €", "Œuvre  nº 3", "ő ł Nguyễn", "  espaces   multiples  "]) {
    assert.equal(safe(safe(s)), safe(s));
  }
});

test("hors WinAnsi : lettre de base si elle existe, sinon une espace ; jamais d'octet > 0xFF", () => {
  assert.equal(safe("Nguyễn"), "Nguyen");
  assert.equal(safe("A\u{1F600}B"), "A B"); // emoji
  for (const ch of safe("日本 Ł ő Ž ñ é €")) assert.ok(ch.charCodeAt(0) <= 0xff);
});

test("comportement inchangé pour l'ASCII, le degré et les espaces", () => {
  assert.equal(safe("N° 12 (A)  b"), "N° 12 (A) b");
  assert.equal(safe(null), "");
  assert.equal(safe(undefined), "");
  assert.equal(safe("  "), "");
});

test("une lettre accentuée se mesure comme sa lettre de base (alignements à droite exacts)", () => {
  const w = (s) => measureTextWidth(s, "F1", 10);
  assert.ok(Math.abs(w("é") - w("e")) < 1e-9);
  assert.ok(Math.abs(w("É") - w("E")) < 1e-9);
  assert.ok(w("\u0080") > 0); // €
});

test("la table xref reste exacte avec et sans métadonnées ; /Info n'apparaît que si demandé", () => {
  const p = new PdfBuilder();
  p.setFont("F1", 10);
  p.text("Mickaël 250,00 €", 20, 20, {});
  const check = (bytes) => {
    const txt = latin1(bytes);
    const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(txt)[1]);
    assert.equal(txt.slice(startxref, startxref + 4), "xref");
    const count = Number(/xref\s+0 (\d+)/.exec(txt.slice(startxref))[1]);
    [...txt.slice(startxref).matchAll(/(\d{10}) \d{5} ([nf]) /g)].forEach((m, i) => {
      if (m[2] === "n") assert.equal(txt.slice(Number(m[1]), Number(m[1]) + `${i} 0 obj`.length), `${i} 0 obj`);
    });
    assert.equal(Number(/\/Size (\d+)/.exec(txt)[1]), count);
    return txt;
  };
  const sans = check(buildPdfDocument(p.getStreams(), p.images));
  assert.ok(!sans.includes("/Info"), "sans métadonnées, le document est identique à avant");
  const avec = check(buildPdfDocument(p.getStreams(), p.images, { title: "Reçu — Mickaël", author: "AFFBC" }));
  assert.ok(avec.includes("/Info "));
  assert.ok(avec.includes("(Mickaël 250,00 \u0080)"));
});

test("dossier récapitulatif : noms, adresses et articles gardent leurs accents (non-régression du moteur partagé)", async () => {
  const registration = {
    id: "ab12cd34-5678-4abc-9def-0123456789ab",
    seasonLabel: "2026-2027",
    submittedAt: "2026-09-08",
    identity: { lastName: "ANDRIEU", firstName: "Mickaël", birthDate: "2012-03-14", birthPlace: "Thonon-les-Bains" },
    contact: { address1: "12 chemin des Grands Prés", postalCode: "74200", city: "Thonon-les-Bains", email: "mickael@example.com" },
    emergency: { lastName: "ANDRIEU", firstName: "Hélène", phonePrimary: "0611111111" },
    practice: { typeInscription: "nouvelle", formulaCode: "base", installmentCount: 3 },
    health: { qsSport: { chestPain: "yes" } },
    clothingOrder: { tshirtQty: 1, tshirtSize: "M", pantalonQty: 1, pantalonSize: "L" },
    consents: { rulesAccepted: true, imageRights: "no", applicantSignatureName: "Hélène Andrieu" },
    computedTotals: {
      formulaLabel: "Tarif standard", cotisation: 220, clothingTotal: 40, extraProductsTotal: 12, total: 272,
      orderItems: [{ name: "Protège-tibias", size: "M", unitPrice: 12, quantity: 1, total: 12 }],
    },
    payment: { installmentCount: 3 },
    documentsJson: "{}",
  };
  const bytes = await generateAdherentPdf(registration, null, null);
  const txt = latin1(bytes);
  for (const accented of ["Mickaël", "Grands Prés", "Hélène", "Protège-tibias"]) {
    assert.ok(txt.includes(accented), `« ${accented} » doit garder ses accents`);
  }
  // et la structure reste celle d'un PDF multi-pages valide
  assert.ok((txt.match(/\/Type\s*\/Page\b(?!s)/g) || []).length >= 2);
  assert.ok(txt.startsWith("%PDF-") && txt.trimEnd().endsWith("%%EOF"));
});
