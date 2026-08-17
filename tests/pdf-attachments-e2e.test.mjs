import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

import {
  generateAdherentPdf,
  generateAdherentPdfWithAttachments,
  fetchAttachedDocuments,
} from "../src/routes/_lib/pdf.js";

const BASE_REGISTRATION = {
  id: "AFFBC-TEST-E2E-0001",
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

async function makeFixturePdf(pageCount, label) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]);
  return doc.save();
}

async function pageCountOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

// Reproduit la forme minimale d'un bucket R2 (binding.get(key) -> objet avec
// arrayBuffer(), ou null si absent) — cf. usage réel dans fetchPhotoDocument
// et fetchAttachedDocuments.
function fakeBucket(filesByKey) {
  return {
    async get(key) {
      const bytes = filesByKey[key];
      if (bytes === undefined) return null;
      if (bytes === "THROW") throw new Error("R2 indisponible (simulation)");
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  };
}

test("fetchAttachedDocuments returns the 3 non-photo documents when present in documents_json", async () => {
  const certif = new Uint8Array(await makeFixturePdf(1));
  const pass = new Uint8Array(await makeFixturePdf(1));
  const env = {
    R2_PDF: fakeBucket({ "certif-key": certif, "pass-key": pass }),
    R2_STORAGE: fakeBucket({}),
  };
  const documentsJson = JSON.stringify({
    photoIdentity: { bucket: "storage", key: "photo-key", name: "photo.jpg" }, // exclu volontairement (S1)
    medicalCertificate: { bucket: "fullfighting-pdf", key: "certif-key", name: "certif.pdf" },
    passRegionDocument: { bucket: "fullfighting-pdf", key: "pass-key", name: "pass.pdf" },
  });

  const docs = await fetchAttachedDocuments(env, documentsJson);
  assert.equal(docs.length, 2, "photoIdentity must not be included, it's already embedded in S1");
  assert.deepEqual(docs.map((d) => d.key).sort(), ["medicalCertificate", "passRegionDocument"]);
});

test("fetchAttachedDocuments skips a document whose R2 read fails, without throwing", async () => {
  const pass = new Uint8Array(await makeFixturePdf(1));
  const env = {
    R2_PDF: fakeBucket({ "certif-key": "THROW", "pass-key": pass }),
    R2_STORAGE: fakeBucket({}),
  };
  const documentsJson = {
    medicalCertificate: { bucket: "fullfighting-pdf", key: "certif-key", name: "certif.pdf" },
    passRegionDocument: { bucket: "fullfighting-pdf", key: "pass-key", name: "pass.pdf" },
  };

  const docs = await fetchAttachedDocuments(env, documentsJson);
  assert.deepEqual(docs.map((d) => d.key), ["passRegionDocument"]);
});

test("fetchAttachedDocuments returns [] gracefully with no env, no documents_json, or invalid JSON", async () => {
  assert.deepEqual(await fetchAttachedDocuments(null, null), []);
  assert.deepEqual(await fetchAttachedDocuments({}, "{}"), []);
  assert.deepEqual(await fetchAttachedDocuments({}, "not-json{{"), []);
});

test("generateAdherentPdfWithAttachments merges real attached PDF pages into the final document", async () => {
  const certif = new Uint8Array(await makeFixturePdf(1));
  const proof = new Uint8Array(await makeFixturePdf(2));
  const env = {
    R2_PDF: fakeBucket({ "certif-key": certif, "proof-key": proof }),
    R2_STORAGE: fakeBucket({}),
  };
  const registration = {
    ...BASE_REGISTRATION,
    documentsJson: JSON.stringify({
      medicalCertificate: { bucket: "fullfighting-pdf", key: "certif-key", name: "certif.pdf" },
      proofDocument: { bucket: "fullfighting-pdf", key: "proof-key", name: "justif-cse.pdf" },
    }),
  };

  const baseOnly = await generateAdherentPdf(registration, null, null);
  const baseCount = await pageCountOf(baseOnly);

  const withAttachments = await generateAdherentPdfWithAttachments(registration, null, env);
  const finalCount = await pageCountOf(withAttachments);

  assert.equal(finalCount, baseCount + 1 + 2, "base + certificat (1p) + justificatif (2p)");
});

test("generateAdherentPdfWithAttachments falls back to the base dossier when there is no env/documents at all", async () => {
  const bytes = await generateAdherentPdfWithAttachments(BASE_REGISTRATION, null, null);
  const expected = await generateAdherentPdf(BASE_REGISTRATION, null, null);
  assert.equal(await pageCountOf(bytes), await pageCountOf(expected));
});

test("generateAdherentPdfWithAttachments degrades gracefully when R2 throws for every document", async () => {
  const env = {
    R2_PDF: fakeBucket({ "certif-key": "THROW" }),
    R2_STORAGE: fakeBucket({}),
  };
  const registration = {
    ...BASE_REGISTRATION,
    documentsJson: JSON.stringify({
      medicalCertificate: { bucket: "fullfighting-pdf", key: "certif-key", name: "certif.pdf" },
    }),
  };
  const bytes = await generateAdherentPdfWithAttachments(registration, null, env);
  const expected = await generateAdherentPdf(registration, null, null);
  assert.equal(await pageCountOf(bytes), await pageCountOf(expected), "should equal the base-only page count");
});
