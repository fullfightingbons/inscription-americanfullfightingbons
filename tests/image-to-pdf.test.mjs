import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

import { imageToPdfBytes, readJpegOrientation, sniffFileKind } from "../src/routes/_lib/image-to-pdf.js";
import { jpegBytes, pngBytes, withExifOrientation } from "./image-fixtures.mjs";

async function pdfOf(bytes) {
  return PDFDocument.load(bytes);
}

// ─── sniffFileKind ───────────────────────────────────────────────────────────

test("sniffFileKind reconnaît PDF, JPEG et PNG d'après le contenu, pas le nom", async () => {
  const pdf = await (await PDFDocument.create()).save();
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  assert.equal(sniffFileKind(new Uint8Array(await doc.save())), "pdf");
  assert.equal(sniffFileKind(jpegBytes()), "jpeg");
  assert.equal(sniffFileKind(pngBytes()), "png");
  assert.ok(pdf.length > 0);
});

test("sniffFileKind tolère quelques octets avant l'en-tête PDF", () => {
  const bytes = new Uint8Array([0x0a, 0x0a, ...Buffer.from("%PDF-1.4\n")]);
  assert.equal(sniffFileKind(bytes), "pdf");
});

test("sniffFileKind renvoie null pour du texte, du HEIC, du vide ou trop court", () => {
  assert.equal(sniffFileKind(new Uint8Array(Buffer.from("bonjour, ceci n'est pas un fichier"))), null);
  // HEIC : « ftypheic » après 4 octets de taille
  assert.equal(sniffFileKind(new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypheic")])), null);
  assert.equal(sniffFileKind(new Uint8Array()), null);
  assert.equal(sniffFileKind(new Uint8Array([0xff, 0xd8])), null);
  assert.equal(sniffFileKind(null), null);
});

// ─── readJpegOrientation ─────────────────────────────────────────────────────

test("readJpegOrientation vaut 1 sans EXIF", () => {
  assert.equal(readJpegOrientation(jpegBytes()), 1);
});

test("readJpegOrientation lit l'orientation EXIF (little et big endian)", () => {
  for (const orientation of [1, 3, 6, 8]) {
    assert.equal(readJpegOrientation(withExifOrientation(jpegBytes(), orientation)), orientation);
    assert.equal(readJpegOrientation(withExifOrientation(jpegBytes(), orientation, { bigEndian: true })), orientation);
  }
});

test("readJpegOrientation ne lève jamais d'exception sur un EXIF tronqué ou invalide", () => {
  const full = withExifOrientation(jpegBytes(), 6);
  for (const cut of [3, 5, 8, 12, 20, 28]) {
    assert.equal(readJpegOrientation(full.slice(0, cut)), 1, `coupé à ${cut} octets`);
  }
  assert.equal(readJpegOrientation(new Uint8Array([1, 2, 3])), 1);
  assert.equal(readJpegOrientation(null), 1);
  assert.equal(readJpegOrientation(withExifOrientation(jpegBytes(), 42)), 1, "valeur hors 1–8 ignorée");
});

// ─── imageToPdfBytes ─────────────────────────────────────────────────────────

test("imageToPdfBytes : JPEG → PDF d'une page ~A4 (côté long 842 pt), sans rotation", async () => {
  const out = await imageToPdfBytes(jpegBytes(), "jpeg");
  assert.equal(sniffFileKind(out), "pdf");
  const doc = await pdfOf(out);
  assert.equal(doc.getPageCount(), 1);
  const page = doc.getPage(0);
  assert.equal(Math.round(page.getWidth()), 842);   // 40×20 → paysage
  assert.equal(Math.round(page.getHeight()), 421);
  assert.equal(page.getRotation().angle, 0);
});

test("imageToPdfBytes : l'orientation EXIF 6 (portrait pris à la verticale) devient une rotation de page de 90°", async () => {
  const doc = await pdfOf(await imageToPdfBytes(withExifOrientation(jpegBytes(), 6), "jpeg"));
  const page = doc.getPage(0);
  assert.equal(page.getRotation().angle, 90);
  // Pixels 40×20 bruts, affichés pivotés : côté long = 842 pt dans les deux cas.
  assert.equal(Math.round(page.getWidth()), 842);
  assert.equal(Math.round(page.getHeight()), 421);
});

test("imageToPdfBytes : EXIF 3 → 180°, EXIF 8 → 270°", async () => {
  for (const [orientation, angle] of [[3, 180], [8, 270]]) {
    const doc = await pdfOf(await imageToPdfBytes(withExifOrientation(jpegBytes(), orientation), "jpeg"));
    assert.equal(doc.getPage(0).getRotation().angle, angle);
  }
});

test("imageToPdfBytes : PNG (avec transparence) → PDF d'une page", async () => {
  const doc = await pdfOf(await imageToPdfBytes(pngBytes(), "png"));
  assert.equal(doc.getPageCount(), 1);
  assert.equal(Math.round(doc.getPage(0).getWidth()), 842);
  assert.equal(Math.round(doc.getPage(0).getHeight()), 281); // 30×10
});

test("imageToPdfBytes rejette une image corrompue et un type inconnu", async () => {
  await assert.rejects(() => imageToPdfBytes(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]), "jpeg"));
  await assert.rejects(() => imageToPdfBytes(new Uint8Array([1, 2, 3, 4]), "png"));
  await assert.rejects(() => imageToPdfBytes(jpegBytes(), "gif"), /non pris en charge/);
});
