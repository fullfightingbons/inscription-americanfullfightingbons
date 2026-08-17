import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

import { mergeAttachedPdfs } from "../src/routes/_lib/pdf-merge.js";
import { generateAdherentPdf } from "../src/routes/_lib/pdf.js";

const MINIMAL_REGISTRATION = {
  id: "AFFBC-TEST-MERGE-0001",
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

// Construit un mini PDF valide à N pages via pdf-lib, pour servir de pièce
// jointe factice (équivalent d'un certificat médical scanné en PDF).
async function makeFixturePdf(pageCount = 1, label = "fixture") {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`${label} page ${i + 1}`, { x: 10, y: 100 });
  }
  return doc.save();
}

async function pageCountOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

test("mergeAttachedPdfs returns the base bytes unchanged when there are no attachments", async () => {
  const base = await generateAdherentPdf(MINIMAL_REGISTRATION, null, null);
  const result = await mergeAttachedPdfs(base, []);
  assert.equal(result, base, "should be the exact same reference, not a re-encoded copy");
});

test("mergeAttachedPdfs appends the pages of every valid attachment, in order", async () => {
  const base = await generateAdherentPdf(MINIMAL_REGISTRATION, null, null);
  const baseCount = await pageCountOf(base);

  const certif = await makeFixturePdf(1, "certificat");
  const passRegion = await makeFixturePdf(2, "pass-region");

  const merged = await mergeAttachedPdfs(base, [
    { label: "Certificat medical", name: "certif.pdf", bytes: certif },
    { label: "Justificatif Pass Region", name: "pass.pdf", bytes: passRegion },
  ]);

  const mergedCount = await pageCountOf(merged);
  assert.equal(mergedCount, baseCount + 1 + 2, "base pages + 1 page (certif) + 2 pages (pass region)");
});

test("mergeAttachedPdfs skips a corrupted attachment but still merges the valid ones", async () => {
  const base = await generateAdherentPdf(MINIMAL_REGISTRATION, null, null);
  const baseCount = await pageCountOf(base);

  const valid = await makeFixturePdf(1, "valide");
  const corrupted = new Uint8Array([1, 2, 3, 4, 5]); // pas un PDF

  const merged = await mergeAttachedPdfs(base, [
    { label: "Piece corrompue", name: "corrompu.pdf", bytes: corrupted },
    { label: "Piece valide", name: "valide.pdf", bytes: valid },
  ]);

  const mergedCount = await pageCountOf(merged);
  assert.equal(mergedCount, baseCount + 1, "only the valid attachment's page should have been appended");
});

test("mergeAttachedPdfs falls back to the base bytes when the base document itself is unreadable", async () => {
  const brokenBase = new Uint8Array([9, 9, 9]);
  const valid = await makeFixturePdf(1, "valide");
  const result = await mergeAttachedPdfs(brokenBase, [{ label: "x", bytes: valid }]);
  assert.equal(result, brokenBase, "should return the input unchanged rather than throw");
});

test("mergeAttachedPdfs ignores attachments with no bytes", async () => {
  const base = await generateAdherentPdf(MINIMAL_REGISTRATION, null, null);
  const result = await mergeAttachedPdfs(base, [{ label: "vide", bytes: null }, { label: "vide2" }]);
  assert.equal(result, base);
});
