import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

import { uploadRequiredFile } from "../src/routes/api/public/inscription.js";
import { jpegBytes, pngBytes, withExifOrientation } from "./image-fixtures.mjs";

const REG_ID = "11111111-2222-3333-4444-555555555555";

// Faux bucket R2 : enregistre ce qui est écrit.
function fakeBucket() {
  const puts = [];
  return {
    puts,
    async put(key, body, options) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      puts.push({ key, bytes, options });
    },
  };
}
function fakeEnv() {
  return { R2_STORAGE: fakeBucket(), R2_PDF: fakeBucket() };
}

async function makePdf(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 200]);
  return new Uint8Array(await doc.save());
}
const fileOf = (bytes, name, type) => new File([bytes], name, { type });

// ─── Chemin historique : PDF — doit rester STRICTEMENT identique ─────────────

test("PDF normal (certificat) : stocké tel quel, même nom, même type, extension du fichier", async () => {
  const env = fakeEnv();
  const pdf = await makePdf(2);
  const ref = await uploadRequiredFile(env, REG_ID, fileOf(pdf, "Certificat Dr Martin.PDF", "application/pdf"), "certificat-medical", false);

  const [put] = env.R2_PDF.puts;
  assert.equal(put.key, `public-inscriptions/${REG_ID}/certificat-medical.pdf`);
  assert.deepEqual(put.bytes, pdf, "octets inchangés");
  assert.equal(put.options.httpMetadata.contentType, "application/pdf");
  assert.deepEqual(ref, { bucket: "fullfighting-pdf", key: put.key, name: "Certificat Dr Martin.PDF", contentType: "application/pdf", size: pdf.byteLength });
  assert.equal(env.R2_STORAGE.puts.length, 0);
});

test("photo d'identité JPEG/PNG typée : stockée telle quelle dans R2_STORAGE (chemin historique)", async () => {
  const env = fakeEnv();
  const jpg = jpegBytes();
  const ref = await uploadRequiredFile(env, REG_ID, fileOf(jpg, "moi.jpeg", "image/jpeg"), "photo-identite", true);
  const [put] = env.R2_STORAGE.puts;
  assert.equal(put.key, `public-inscriptions/${REG_ID}/photo-identite.jpeg`);
  assert.deepEqual(put.bytes, jpg);
  assert.equal(put.options.httpMetadata.contentType, "image/jpeg");
  assert.deepEqual(ref, { bucket: "storage", key: put.key, name: "moi.jpeg", contentType: "image/jpeg", size: jpg.byteLength });

  const env2 = fakeEnv();
  await uploadRequiredFile(env2, REG_ID, fileOf(pngBytes(), "moi.png", "image/png"), "photo-identite", true);
  assert.equal(env2.R2_STORAGE.puts[0].options.httpMetadata.contentType, "image/png");
});

// ─── Nouveau : photo d'un justificatif → PDF ─────────────────────────────────

test("certificat médical envoyé en photo JPEG → stocké en PDF (clé .pdf, type PDF, nom .pdf)", async () => {
  const env = fakeEnv();
  const photo = jpegBytes();
  const ref = await uploadRequiredFile(env, REG_ID, fileOf(photo, "IMG_2031.JPG", "image/jpeg"), "certificat-medical", false);

  const [put] = env.R2_PDF.puts;
  assert.equal(put.key, `public-inscriptions/${REG_ID}/certificat-medical.pdf`);
  assert.equal(put.options.httpMetadata.contentType, "application/pdf");
  const stored = await PDFDocument.load(put.bytes); // c'est bien un PDF lisible, 1 page
  assert.equal(stored.getPageCount(), 1);
  assert.equal(ref.contentType, "application/pdf");
  assert.equal(ref.name, "IMG_2031.pdf");
  assert.equal(ref.size, put.bytes.byteLength);
  assert.equal(put.options.customMetadata.originalName, "IMG_2031.JPG", "nom d'origine conservé en métadonnée");
});

test("justificatif Pass Région en PNG, et photo EXIF orientée → PDF, aval compatible (page unique)", async () => {
  const env = fakeEnv();
  await uploadRequiredFile(env, REG_ID, fileOf(pngBytes(), "capture.png", "image/png"), "pass-region", false);
  await uploadRequiredFile(env, REG_ID, fileOf(withExifOrientation(jpegBytes(), 6), "photo.jpg", "image/jpeg"), "justificatif-tarif", false);
  assert.equal(env.R2_PDF.puts.length, 2);
  for (const put of env.R2_PDF.puts) {
    assert.ok(put.key.endsWith(".pdf"));
    assert.equal((await PDFDocument.load(put.bytes)).getPageCount(), 1);
  }
});

test("type déclaré vide ou générique mais contenu réellement JPEG → accepté et converti", async () => {
  for (const type of ["", "application/octet-stream"]) {
    const env = fakeEnv();
    const ref = await uploadRequiredFile(env, REG_ID, fileOf(jpegBytes(), "image", type), "certificat-medical", false);
    assert.equal(ref.contentType, "application/pdf", `type déclaré « ${type} »`);
    assert.equal(ref.name, "image.pdf");
  }
});

test("vrai PDF déclaré avec un mauvais type → accepté et stocké tel quel", async () => {
  const env = fakeEnv();
  const pdf = await makePdf();
  const ref = await uploadRequiredFile(env, REG_ID, fileOf(pdf, "doc", "application/octet-stream"), "pass-region", false);
  assert.deepEqual(env.R2_PDF.puts[0].bytes, pdf);
  assert.equal(ref.contentType, "application/pdf");
  assert.ok(ref.key.endsWith("pass-region.pdf"));
});

test("photo d'identité au type vide mais contenu JPEG/PNG → acceptée avec l'extension réelle", async () => {
  const env = fakeEnv();
  const ref = await uploadRequiredFile(env, REG_ID, fileOf(jpegBytes(), "blob", ""), "photo-identite", true);
  assert.equal(ref.contentType, "image/jpeg");
  assert.ok(ref.key.endsWith("photo-identite.jpg"));
  const ref2 = await uploadRequiredFile(env, REG_ID, fileOf(pngBytes(), "blob", ""), "photo-identite", true);
  assert.equal(ref2.contentType, "image/png");
  assert.ok(ref2.key.endsWith("photo-identite.png"));
});

// ─── Refus (avec libellés lisibles) ──────────────────────────────────────────

test("formats non pris en charge : refus avec un libellé lisible, rien n'est écrit", async () => {
  const env = fakeEnv();
  const heic = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypheic"), 0, 0, 0, 0]);
  await assert.rejects(
    () => uploadRequiredFile(env, REG_ID, fileOf(heic, "IMG.HEIC", "image/heic"), "certificat-medical", false),
    /Le document certificat médical doit être un PDF ou une photo \(JPEG ou PNG\)/,
  );
  await assert.rejects(
    () => uploadRequiredFile(env, REG_ID, fileOf(heic, "IMG.HEIC", "image/heic"), "photo-identite", true),
    /Le document photo d'identité doit être une image JPEG ou PNG/,
  );
  const somePdf = await makePdf();
  await assert.rejects(
    () => uploadRequiredFile(env, REG_ID, fileOf(somePdf, "x.pdf", "application/pdf"), "photo-identite", true),
    /photo d'identité doit être une image JPEG ou PNG/,
    "un PDF n'est toujours pas une photo d'identité valide",
  );
  assert.equal(env.R2_PDF.puts.length + env.R2_STORAGE.puts.length, 0);
});

test("image corrompue : message clair (pas d'erreur technique), rien n'est écrit", async () => {
  const env = fakeEnv();
  const broken = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
  await assert.rejects(
    () => uploadRequiredFile(env, REG_ID, fileOf(broken, "cassee.jpg", "image/jpeg"), "justificatif-tarif", false),
    /justificatif de tarif réduit n'a pas pu être lu/,
  );
  assert.equal(env.R2_PDF.puts.length, 0);
});

test("fichier absent, vide ou trop gros (> 8 Mo) : mêmes refus qu'avant, libellés lisibles", async () => {
  const env = fakeEnv();
  await assert.rejects(() => uploadRequiredFile(env, REG_ID, null, "certificat-medical", false), /certificat médical est obligatoire/);
  await assert.rejects(() => uploadRequiredFile(env, REG_ID, new File([], "vide.pdf", { type: "application/pdf" }), "pass-region", false), /Pass Région est obligatoire/);
  const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "gros.pdf", { type: "application/pdf" });
  await assert.rejects(() => uploadRequiredFile(env, REG_ID, big, "certificat-medical", false), /certificat médical dépasse 8 Mo/);
});
