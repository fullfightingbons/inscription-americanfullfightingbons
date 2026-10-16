// Budget d'octets des pièces annexées au dossier PDF (cf. MAX_MERGED_ATTACHMENTS_BYTES dans pdf.js).
//
// Contexte : la fusion pdf-lib d'un justificatif volumineux (scan de plusieurs Mo) faisait dépasser
// les limites du Worker (erreur Cloudflare 1102) — un Worker tué ne passe dans aucun try/catch, donc
// ni PDF ni e-mail de confirmation. Une pièce qui ne rentre pas dans le budget n'est plus lue ni
// fusionnée : elle reste dans R2, et le dossier PDF comme l'e-mail le disent.

import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import crypto from "node:crypto";

import {
  MAX_MERGED_ATTACHMENTS_BYTES,
  planAttachmentMerge,
  fetchAttachedDocuments,
  generateAdherentPdf,
  generateAdherentPdfWithAttachments,
} from "../src/routes/_lib/pdf.js";
import { uint8ToBase64 } from "../src/routes/_lib/base64.js";

const MB = 1024 * 1024;
const latin1 = (buf) => Buffer.from(buf).toString("latin1");

const BASE_REGISTRATION = {
  id: "AFFBC-TEST-BUDGET-0001",
  identity: { lastName: "Test", firstName: "Adherent" },
  contact: {}, emergency: {}, practice: {}, health: {}, clothingOrder: {}, consents: {}, computedTotals: {}, payment: {},
};

async function fixturePdf(pageCount) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  return new Uint8Array(await doc.save());
}
const pageCountOf = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();

// Bucket R2 factice qui enregistre ce qui est réellement lu.
function spyBucket(files) {
  const log = { get: [], arrayBuffer: [] };
  return {
    log,
    async get(key) {
      log.get.push(key);
      const entry = files[key];
      if (!entry) return null;
      const bytes = entry.bytes;
      return {
        ...(entry.reportSize ? { size: bytes.byteLength } : {}),
        arrayBuffer: async () => { log.arrayBuffer.push(key); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      };
    },
  };
}

const ref = (key, name, size) => ({ bucket: "fullfighting-pdf", key, name, ...(size === undefined ? {} : { size }) });

// ── planAttachmentMerge ──────────────────────────────────────────────────────

test("le budget par défaut laisse de la marge sous les 4 Mo par pièce jointe de Brevo", () => {
  assert.ok(MAX_MERGED_ATTACHMENTS_BYTES < 4 * MB);
});

test("plan : tout rentre dans le budget → tout est fusionné", () => {
  const docs = { medicalCertificate: ref("c", "c.pdf", 1 * MB), passRegionDocument: ref("p", "p.pdf", 1 * MB) };
  const plan = planAttachmentMerge(JSON.stringify(docs));
  assert.deepEqual(plan.merge, ["medicalCertificate", "passRegionDocument"]);
  assert.deepEqual(plan.skipped, []);
});

test("plan : un justificatif Pass Région de 6 Mo est écarté, le certificat léger reste fusionné", () => {
  const docs = { medicalCertificate: ref("c", "c.pdf", 300_000), passRegionDocument: ref("p", "scan.pdf", 6 * MB) };
  const plan = planAttachmentMerge(docs);
  assert.deepEqual(plan.merge, ["medicalCertificate"]);
  assert.deepEqual(plan.skipped, [{ key: "passRegionDocument", label: "Justificatif Pass Region", name: "scan.pdf", size: 6 * MB }]);
});

test("plan : une pièce écartée n'empêche pas une pièce suivante plus légère de rentrer", () => {
  const docs = { medicalCertificate: ref("c", "c.pdf", 2 * MB), passRegionDocument: ref("p", "p.pdf", 2 * MB), proofDocument: ref("j", "j.pdf", 500_000) };
  const plan = planAttachmentMerge(docs, 3 * MB);
  assert.deepEqual(plan.merge, ["medicalCertificate", "proofDocument"]);
  assert.deepEqual(plan.skipped.map((s) => s.key), ["passRegionDocument"]);
});

test("plan : sans taille déclarée (anciens dossiers) la pièce est acceptée, JSON invalide ou vide toléré", () => {
  assert.deepEqual(planAttachmentMerge({ medicalCertificate: ref("c", "c.pdf") }).merge, ["medicalCertificate"]);
  assert.deepEqual(planAttachmentMerge("not-json{{"), { merge: [], skipped: [] });
  assert.deepEqual(planAttachmentMerge(null), { merge: [], skipped: [] });
});

// ── fetchAttachedDocuments ───────────────────────────────────────────────────

test("une pièce trop lourde d'après sa taille déclarée n'est même pas lue dans R2", async () => {
  const small = await fixturePdf(1);
  const bucket = spyBucket({ "c-key": { bytes: small }, "p-key": { bytes: await fixturePdf(1) } });
  const skipped = [];
  const docs = await fetchAttachedDocuments(
    { R2_PDF: bucket },
    JSON.stringify({ medicalCertificate: ref("c-key", "c.pdf", small.length), passRegionDocument: ref("p-key", "scan.pdf", 6 * MB) }),
    { skipped },
  );
  assert.deepEqual(docs.map((d) => d.key), ["medicalCertificate"]);
  assert.deepEqual(bucket.log.get, ["c-key"], "p-key n'a jamais été demandé à R2");
  assert.deepEqual(skipped.map((s) => s.key), ["passRegionDocument"]);
});

test("sans taille déclarée : la taille de l'objet R2 évite de charger la pièce en mémoire", async () => {
  const big = new Uint8Array(crypto.randomBytes(2 * MB));
  const bucket = spyBucket({ "p-key": { bytes: big, reportSize: true } });
  const skipped = [];
  const docs = await fetchAttachedDocuments({ R2_PDF: bucket }, { passRegionDocument: ref("p-key", "scan.pdf") }, { maxTotalBytes: 1 * MB, skipped });
  assert.deepEqual(docs, []);
  assert.deepEqual(bucket.log.arrayBuffer, [], "arrayBuffer() jamais appelé : la pièce n'a pas été chargée");
  assert.equal(skipped[0].size, 2 * MB);
});

test("sans aucune taille connue : le poids réel des octets lus fait foi", async () => {
  const big = new Uint8Array(crypto.randomBytes(2 * MB));
  const bucket = spyBucket({ "p-key": { bytes: big } });
  const skipped = [];
  const docs = await fetchAttachedDocuments({ R2_PDF: bucket }, { passRegionDocument: ref("p-key", "scan.pdf") }, { maxTotalBytes: 1 * MB, skipped });
  assert.deepEqual(docs, []);
  assert.equal(skipped.length, 1);
});

test("le cumul des pièces est borné : la seconde, qui ferait dépasser, est écartée", async () => {
  const a = new Uint8Array(crypto.randomBytes(600_000));
  const b = new Uint8Array(crypto.randomBytes(600_000));
  const bucket = spyBucket({ "a": { bytes: a }, "b": { bytes: b } });
  const skipped = [];
  const docs = await fetchAttachedDocuments({ R2_PDF: bucket }, { medicalCertificate: ref("a", "a.pdf"), passRegionDocument: ref("b", "b.pdf") }, { maxTotalBytes: 1 * MB, skipped });
  assert.deepEqual(docs.map((d) => d.key), ["medicalCertificate"]);
  assert.deepEqual(skipped.map((s) => s.key), ["passRegionDocument"]);
});

test("signature d'origine inchangée : sans options, comportement identique (tableau de pièces)", async () => {
  const pdf = await fixturePdf(1);
  const bucket = spyBucket({ k: { bytes: pdf } });
  const docs = await fetchAttachedDocuments({ R2_PDF: bucket }, { medicalCertificate: ref("k", "c.pdf") });
  assert.equal(docs.length, 1);
});

// ── generateAdherentPdfWithAttachments ───────────────────────────────────────

test("dossier complet : la pièce écartée n'ajoute aucune page, les autres sont fusionnées", async () => {
  const certif = await fixturePdf(1);
  const bucket = spyBucket({ "c-key": { bytes: certif }, "p-key": { bytes: await fixturePdf(3) } });
  const registration = {
    ...BASE_REGISTRATION,
    documentsJson: JSON.stringify({ medicalCertificate: ref("c-key", "c.pdf", certif.length), passRegionDocument: ref("p-key", "scan.pdf", 6 * MB) }),
  };
  const skipped = [];
  const base = await generateAdherentPdf({ ...registration, attachmentsNotMerged: ["passRegionDocument"] }, null, null);
  const merged = await generateAdherentPdfWithAttachments(registration, null, { R2_PDF: bucket }, { skipped });

  assert.equal(await pageCountOf(merged), (await pageCountOf(base)) + 1, "dossier + certificat (1 page), pas les 3 pages du scan");
  assert.deepEqual(skipped.map((s) => s.key), ["passRegionDocument"]);
  assert.ok(!bucket.log.get.includes("p-key"));
});

test("le dossier PDF dit honnêtement que la pièce volumineuse n'est pas annexée", async () => {
  const bucket = spyBucket({});
  const registration = {
    ...BASE_REGISTRATION,
    documentsJson: JSON.stringify({ passRegionDocument: ref("p-key", "scan.pdf", 6 * MB) }),
  };
  const pdf = latin1(await generateAdherentPdfWithAttachments(registration, null, { R2_PDF: bucket }));
  assert.ok(pdf.includes("non annexe"), "la ligne de la pièce porte la mention");
  assert.ok(pdf.includes("Les pieces trop volumineuses ne sont pas annexees ici"), "et l'en-tête de la section l'explique");
});

test("sans pièce écartée, le dossier est inchangé : aucune mention « non annexe »", async () => {
  const certif = await fixturePdf(1);
  const bucket = spyBucket({ "c-key": { bytes: certif } });
  const registration = { ...BASE_REGISTRATION, documentsJson: JSON.stringify({ medicalCertificate: ref("c-key", "c.pdf", certif.length) }) };
  const base = latin1(await generateAdherentPdf(registration, null, null));
  assert.ok(!base.includes("non annexe"));
  assert.ok(!base.includes("trop volumineuses"));
});

// ── Encodage base64 des pièces jointes ───────────────────────────────────────

test("uint8ToBase64 : identique à Buffer.toString('base64') sur toutes les longueurs utiles, bornes de blocs comprises", () => {
  assert.equal(uint8ToBase64(new Uint8Array(0)), "");
  assert.equal(uint8ToBase64(null), "");
  for (const n of [1, 2, 3, 4, 5, 29_998, 29_999, 30_000, 30_001, 30_002, 59_999, 60_000, 60_001, 100_003, 2 * MB + 1]) {
    const bytes = new Uint8Array(crypto.randomBytes(n));
    assert.equal(uint8ToBase64(bytes), Buffer.from(bytes).toString("base64"), `${n} octets`);
  }
});

test("uint8ToBase64 accepte un Buffer Node et une sous-vue d'un ArrayBuffer plus grand", () => {
  const big = crypto.randomBytes(1000);
  const view = new Uint8Array(big.buffer, big.byteOffset + 10, 500);
  assert.equal(uint8ToBase64(view), Buffer.from(view).toString("base64"));
  assert.equal(uint8ToBase64(big), big.toString("base64"));
});
