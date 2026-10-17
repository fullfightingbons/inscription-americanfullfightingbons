// Plafonds de taille des pièces déposées à l'inscription (cf. src/routes/_lib/upload-limits.js).
//
// Objectif de ces tests : tant que les plafonds sont respectés, TOUTES les pièces d'un dossier sont
// annexées au PDF et le mail part — et rien ne peut dériver sans que la suite ne rougisse (valeurs
// serveur / navigateur, pire cas sous les limites Brevo, refus avant toute écriture).

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { PDFDocument, PDFName } from "pdf-lib";

import {
  MB,
  MAX_PHOTO_BYTES,
  MAX_MEDICAL_CERTIFICATE_BYTES,
  MAX_PASS_REGION_BYTES,
  MAX_PROOF_BYTES,
  MAX_MERGED_ATTACHMENTS_BYTES,
  BREVO_MAX_MESSAGE_BYTES,
  UPLOAD_FIELDS,
  uploadLimitFor,
  formatSize,
  oversizeMessage,
  findOversizedUpload,
} from "../src/routes/_lib/upload-limits.js";
import { generateAdherentPdfWithAttachments, MAX_MERGED_ATTACHMENTS_BYTES as PDF_BUDGET } from "../src/routes/_lib/pdf.js";
import { onRequestPost as postInscription } from "../src/routes/api/public/inscription.js";

const clientSource = readFileSync(new URL("../public/assets/inscription.js", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// ── Cohérence des valeurs ────────────────────────────────────────────────────

test("plafonds : certificat médical 3 Mo, Pass Région et tarif réduit 1,5 Mo, photo 2 Mo", () => {
  assert.equal(MAX_MEDICAL_CERTIFICATE_BYTES, 3 * MB);
  assert.equal(MAX_PASS_REGION_BYTES, 1.5 * MB);
  assert.equal(MAX_PROOF_BYTES, 1.5 * MB);
  assert.equal(MAX_PHOTO_BYTES, 2 * MB);
});

test("le certificat médical, pièce la plus lourde, a le plafond le plus large des justificatifs", () => {
  assert.ok(MAX_MEDICAL_CERTIFICATE_BYTES > MAX_PASS_REGION_BYTES);
  assert.ok(MAX_MEDICAL_CERTIFICATE_BYTES > MAX_PROOF_BYTES);
});

test("budget de fusion = pire cas autorisé = somme des trois plafonds de justificatifs (6 Mo)", () => {
  assert.equal(MAX_MERGED_ATTACHMENTS_BYTES, MAX_MEDICAL_CERTIFICATE_BYTES + MAX_PASS_REGION_BYTES + MAX_PROOF_BYTES);
  assert.equal(MAX_MERGED_ATTACHMENTS_BYTES, 6 * MB);
  assert.equal(PDF_BUDGET, MAX_MERGED_ATTACHMENTS_BYTES, "pdf.js utilise bien la valeur centrale");
});

test("pire cas autorisé : le message Brevo (base64 compris) reste largement sous la limite de 20 Mo", () => {
  const dossierEtReçu = 1 * MB + 128 * 1024;                       // dossier de synthèse + logo + reçu : très large
  const pieces = MAX_MERGED_ATTACHMENTS_BYTES + MAX_PHOTO_BYTES + dossierEtReçu;
  const messageBase64 = pieces * (4 / 3);
  assert.ok(messageBase64 < BREVO_MAX_MESSAGE_BYTES * 0.75, `${(messageBase64 / MB).toFixed(1)} Mo contre 20 Mo`);
});

test("uploadLimitFor : plafond propre à chaque pièce ; pièce inconnue → plafond le plus strict", () => {
  assert.equal(uploadLimitFor("certificat-medical", false), 3 * MB);
  assert.equal(uploadLimitFor("pass-region", false), 1.5 * MB);
  assert.equal(uploadLimitFor("justificatif-tarif", false), 1.5 * MB);
  assert.equal(uploadLimitFor("photo-identite", true), 2 * MB);
  assert.equal(uploadLimitFor("piece-inconnue", false), 1.5 * MB);
  assert.equal(uploadLimitFor("photo-inconnue", true), 2 * MB);
});

// ── Navigateur et formulaire : mêmes valeurs que le serveur ──────────────────

function loadClientLimits() {
  const block = clientSource.match(/const UPLOAD_MAX_BYTES = \{[\s\S]*?\n\};/);
  const label = clientSource.match(/const uploadLimitLabel = [^\n]+;/);
  assert.ok(block && label, "UPLOAD_MAX_BYTES / uploadLimitLabel introuvables côté navigateur");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${block[0]}\n${label[0]}\nglobalThis.__limits = UPLOAD_MAX_BYTES; globalThis.__label = uploadLimitLabel;`, sandbox);
  return { limits: sandbox.__limits, label: sandbox.__label };
}

test("le navigateur applique, pour chaque champ, exactement le plafond du serveur", () => {
  const { limits } = loadClientLimits();
  for (const { field, maxBytes } of UPLOAD_FIELDS) {
    assert.equal(limits[field], maxBytes, `plafond de ${field}`);
  }
  assert.equal(Object.keys(limits).length, UPLOAD_FIELDS.length, "aucun champ en trop ni en moins");
});

test("le libellé de plafond affiché par le navigateur est identique à celui du serveur", () => {
  const { label } = loadClientLimits();
  for (const { maxBytes } of UPLOAD_FIELDS) assert.equal(label(maxBytes), formatSize(maxBytes));
});

test("chaque règle de fichier du navigateur porte son plafond", () => {
  for (const { field } of UPLOAD_FIELDS) {
    assert.match(clientSource, new RegExp(`${field}:\\s+\\{[^}]*maxBytes: UPLOAD_MAX_BYTES\\.${field}`), `FILE_RULES.${field}`);
  }
});

test("le formulaire annonce, sous chacun des 4 champs fichier, le plafond propre à ce champ", () => {
  for (const { field, maxBytes } of UPLOAD_FIELDS) {
    const block = htmlSource.slice(htmlSource.indexOf(`id="${field}"`));
    const hint = block.slice(0, block.indexOf("</label>"));
    assert.ok(hint.includes(`${formatSize(maxBytes)} maximum`), `${field} : « ${formatSize(maxBytes)} maximum » attendu`);
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────

test("formatSize : entier sans décimale, arrondi vers le haut sinon (jamais « 2 Mo » pour un fichier qui dépasse 2 Mo)", () => {
  assert.equal(formatSize(2 * MB), "2 Mo");
  assert.equal(formatSize(1.5 * MB), "1,5 Mo");
  assert.equal(formatSize(2 * MB + 1), "2,1 Mo");
  assert.equal(formatSize(3.4 * MB), "3,4 Mo");
  assert.equal(formatSize(500 * 1024), "0,5 Mo");
});

test("oversizeMessage : lisible, sous la limite de 200 caractères (affiché tel quel à l'adhérent)", () => {
  const doc = oversizeMessage("justificatif de tarif réduit", 5.2 * MB, 1.5 * MB, { photo: false });
  const photo = oversizeMessage("photo d'identité", 5.2 * MB, 2 * MB, { photo: true });
  assert.match(doc, /^Le document justificatif de tarif réduit dépasse la taille maximale de 1,5 Mo \(fichier reçu : 5,2 Mo\)\. Réduisez le PDF ou joignez-le en photo/);
  assert.match(photo, /Choisissez une photo plus légère\.$/);
  assert.ok(doc.length < 200 && photo.length < 200);
});

// ── Contrôle précoce des pièces d'un formulaire ──────────────────────────────

const fileOfSize = (size, name = "piece.pdf", type = "application/pdf") => new File([new Uint8Array(Math.round(size))], name, { type });

test("findOversizedUpload : chaque pièce est jugée selon SON plafond", () => {
  const form = new FormData();
  form.append("photoIdentity", fileOfSize(100 * 1024, "p.jpg", "image/jpeg"));
  form.append("medicalCertificate", fileOfSize(2.9 * MB));          // < 3 Mo : ok pour un certificat
  form.append("passRegionDocument", fileOfSize(2 * MB));            // > 1,5 Mo : trop lourd pour ce justificatif
  form.append("proProofDocument", fileOfSize(3 * MB));
  const found = findOversizedUpload(form);
  assert.equal(found.field, "passRegionDocument");
  assert.match(found.message, /justificatif Pass Région dépasse la taille maximale de 1,5 Mo \(fichier reçu : 2 Mo\)/);
});

test("findOversizedUpload : un certificat de 2,9 Mo passe, 3 Mo + 1 octet non", () => {
  const ok = new FormData();
  ok.append("medicalCertificate", fileOfSize(2.9 * MB));
  assert.equal(findOversizedUpload(ok), null);
  const ko = new FormData();
  ko.append("medicalCertificate", fileOfSize(3 * MB + 1));
  assert.match(findOversizedUpload(ko).message, /certificat médical dépasse la taille maximale de 3 Mo/);
});

test("findOversizedUpload : pièces à la limite, absentes ou vides → rien à signaler", () => {
  const form = new FormData();
  form.append("photoIdentity", fileOfSize(2 * MB, "p.jpg", "image/jpeg"));
  form.append("medicalCertificate", fileOfSize(3 * MB));
  form.append("passRegionDocument", fileOfSize(1.5 * MB));
  form.append("proProofDocument", "");        // champ texte vide
  assert.equal(findOversizedUpload(form), null);
  assert.equal(findOversizedUpload(new FormData()), null);
});

test("photo trop lourde : message propre à la photo, pas celui des PDF", () => {
  const form = new FormData();
  form.append("photoIdentity", fileOfSize(2 * MB + 1, "p.jpg", "image/jpeg"));
  assert.match(findOversizedUpload(form).message, /photo d'identité dépasse.*photo plus légère/);
});

// ── Le serveur refuse AVANT toute écriture ───────────────────────────────────

function recordingDb() {
  const statements = [];
  const rows = [
    { cle: "public_inscription_enabled", valeur: "1" },
    { cle: "public_inscription_closed_message", valeur: "Fermé." },
  ];
  return {
    statements,
    prepare(sql) {
      statements.push(sql);
      const stmt = {
        bind() { return stmt; },
        async all() { return { results: rows }; },
        async first() { return null; },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
}
function submit(files) {
  const form = new FormData();
  form.append("payload", JSON.stringify({ identity: { lastName: "Dupont", firstName: "Jean", birthDate: "1990-01-01" }, practice: { formulaCode: "base" } }));
  for (const [name, file] of Object.entries(files)) form.append(name, file);
  return new Request("https://inscription.test/api/public/inscription/", { method: "POST", body: form });
}

test("inscription : un certificat de 4 Mo est refusé en 400 avec le bon message, sans rien écrire en base ni sur R2", async () => {
  const db = recordingDb();
  const puts = [];
  const bucket = { async put(...args) { puts.push(args); } };
  const res = await postInscription({ request: submit({ medicalCertificate: fileOfSize(4 * MB) }), env: { DB: db, R2_PDF: bucket, R2_STORAGE: bucket } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /certificat médical dépasse la taille maximale de 3 Mo \(fichier reçu : 4 Mo\)/);
  assert.ok(!db.statements.some((sql) => /INSERT INTO inscriptions_publiques/i.test(sql)), "aucune ligne brouillon créée");
  assert.equal(puts.length, 0, "aucun fichier envoyé sur R2");
});

test("inscription : un justificatif Pass Région de 2 Mo est refusé (plafond 1,5 Mo), sans rien écrire", async () => {
  const db = recordingDb();
  const res = await postInscription({ request: submit({ passRegionDocument: fileOfSize(2 * MB) }), env: { DB: db } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /justificatif Pass Région dépasse la taille maximale de 1,5 Mo/);
  assert.ok(!db.statements.some((sql) => /INSERT INTO inscriptions_publiques/i.test(sql)));
});

test("inscription : un certificat de 3 Mo pile passe le contrôle de taille (le refus éventuel vient d'ailleurs)", async () => {
  const res = await postInscription({ request: submit({ medicalCertificate: fileOfSize(3 * MB) }), env: { DB: recordingDb() } });
  const body = await res.json();
  assert.ok(!/taille maximale/.test(String(body.error || "")));
});

// ── Pire cas : TOUTES les pièces sont annexées ───────────────────────────────

async function heavyPdf(size) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  page.node.set(PDFName.of("ScanData"), doc.context.register(doc.context.stream(new Uint8Array(crypto.randomBytes(size)))));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

test("dossier au pire cas autorisé (certificat 3 Mo + Pass Région 1,5 Mo + tarif réduit 1,5 Mo) : les 3 pièces sont annexées", async () => {
  const limits = { medicalCertificate: MAX_MEDICAL_CERTIFICATE_BYTES, passRegionDocument: MAX_PASS_REGION_BYTES, proofDocument: MAX_PROOF_BYTES };
  const pieces = {};
  for (const [key, max] of Object.entries(limits)) {
    pieces[key] = await heavyPdf(max - 4096);
    assert.ok(pieces[key].length <= max, `${key} conforme à son plafond`);
  }

  const store = {};
  const documentsJson = {};
  Object.entries(pieces).forEach(([key, bytes], i) => {
    store[`k${i}`] = bytes;
    documentsJson[key] = { bucket: "fullfighting-pdf", key: `k${i}`, name: `${key}.pdf`, size: bytes.length };
  });
  const bucket = { async get(key) { const b = store[key]; return b && { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; } };

  const registration = {
    id: "AFFBC-PIRE-CAS", identity: { lastName: "Test", firstName: "Adherent" },
    contact: {}, emergency: {}, practice: {}, health: {}, clothingOrder: {}, consents: {}, computedTotals: {}, payment: {},
    documentsJson: JSON.stringify(documentsJson),
  };
  const skipped = [];
  const merged = await generateAdherentPdfWithAttachments(registration, null, { R2_PDF: bucket }, { skipped });
  const base = await generateAdherentPdfWithAttachments({ ...registration, documentsJson: "{}" }, null, null);

  assert.deepEqual(skipped, [], "aucune pièce conforme n'est écartée");
  assert.equal((await PDFDocument.load(merged)).getPageCount(), (await PDFDocument.load(base)).getPageCount() + 3, "les 3 pièces sont annexées");
  assert.ok(merged.length < BREVO_MAX_MESSAGE_BYTES * 0.75 * 0.75, "et le PDF reste très en dessous de la limite d'envoi");
});

// ── Compression adaptative des photos de justificatif (navigateur) ───────────
// Le code du navigateur ne tourne pas sous Node (canvas) : on en extrait les constantes et la fonction
// de décision, et on les exécute avec un « réencodeur » simulé qui renvoie des poids choisis.

function loadPrepareDocumentFile() {
  const take = (re, what) => { const m = clientSource.match(re); assert.ok(m, `${what} introuvable dans le code du navigateur`); return m[0]; };
  const code = [
    take(/const DOCUMENT_MAX_DIMENSION[\s\S]*?const UPLOAD_SAFETY_MARGIN_BYTES[^\n]*\n/, "constantes de compression"),
    take(/async function prepareDocumentFile\(file, maxBytes\) \{[\s\S]*?\n\}\n/, "prepareDocumentFile"),
    "globalThis.__prepare = prepareDocumentFile;",
  ].join("\n");
  const calls = [];
  let plan = [];
  const sandbox = {
    File,
    isPdfFile: (f) => f.type === "application/pdf",
    looksLikeImage: (f) => (f.type || "").startsWith("image/"),
    reencodeImageAsJpeg: async (file, options) => {
      calls.push(options);
      const next = plan.shift();
      return next === null || next === undefined ? null : new File([new Uint8Array(Math.round(next))], "x.jpg", { type: "image/jpeg" });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { prepare: sandbox.__prepare, calls, setPlan: (sizes) => { plan = [...sizes]; calls.length = 0; } };
}

const photoFile = () => new File([new Uint8Array(5 * MB)], "scan.heic", { type: "image/heic" });

test("photo de justificatif : un premier essai sous le plafond est gardé tel quel (comportement d'origine : 2200 px, qualité 0,85)", async () => {
  const { prepare, calls, setPlan } = loadPrepareDocumentFile();
  setPlan([900 * 1024]);
  const out = await prepare(photoFile(), 1.5 * MB);
  assert.equal(out.size, 900 * 1024);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxDimension, 2200);
  assert.equal(calls[0].quality, 0.85);
  assert.equal(calls[0].flatten, true);
});

test("photo trop lourde au 1er essai : on réessaie plus bas jusqu'à passer sous le plafond de la pièce", async () => {
  const { prepare, calls, setPlan } = loadPrepareDocumentFile();
  setPlan([2.4 * MB, 1.9 * MB, 1.4 * MB]);
  const out = await prepare(photoFile(), 1.5 * MB);
  assert.equal(out.size, Math.round(1.4 * MB));
  assert.deepEqual(calls.map((c) => [c.maxDimension, c.quality]), [[2200, 0.85], [1800, 0.75], [1500, 0.65]]);
});

test("le plafond du certificat (3 Mo) laisse passer une photo qu'un justificatif de 1,5 Mo aurait dû réduire", async () => {
  const cert = loadPrepareDocumentFile();
  cert.setPlan([2.4 * MB]);
  assert.equal((await cert.prepare(photoFile(), 3 * MB)).size, Math.round(2.4 * MB));
  assert.equal(cert.calls.length, 1, "1 seul essai pour un certificat");

  const pass = loadPrepareDocumentFile();
  pass.setPlan([2.4 * MB, 1.4 * MB]);
  assert.equal((await pass.prepare(photoFile(), 1.5 * MB)).size, Math.round(1.4 * MB));
  assert.equal(pass.calls.length, 2, "2 essais pour un justificatif plus strict");
});

test("photo pile à la limite : refusée par l'essai (la marge couvre l'enveloppe PDF du serveur), on continue", async () => {
  const { prepare, calls, setPlan } = loadPrepareDocumentFile();
  setPlan([3 * MB, 1.2 * MB]);
  const out = await prepare(photoFile(), 3 * MB);
  assert.equal(out.size, Math.round(1.2 * MB));
  assert.equal(calls.length, 2);
});

test("photo impossible à faire rentrer : la plus légère obtenue est renvoyée (le contrôle final affichera le message)", async () => {
  const { prepare, calls, setPlan } = loadPrepareDocumentFile();
  setPlan([9 * MB, 6 * MB, 5 * MB, 5.5 * MB]);
  const out = await prepare(photoFile(), 3 * MB);
  assert.equal(out.size, Math.round(5 * MB));
  assert.equal(calls.length, 4);
});

test("image non décodable : on n'insiste pas, le fichier d'origine part tel quel", async () => {
  const { prepare, calls, setPlan } = loadPrepareDocumentFile();
  setPlan([null]);
  const original = photoFile();
  assert.equal(await prepare(original, 3 * MB), original);
  assert.equal(calls.length, 1);
});

test("un PDF n'est jamais retouché (pas recompressible dans le navigateur)", async () => {
  const { prepare, calls, setPlan } = loadPrepareDocumentFile();
  setPlan([100]);
  const pdf = new File([new Uint8Array(5 * MB)], "gros.pdf", { type: "application/pdf" });
  assert.equal(await prepare(pdf, 3 * MB), pdf);
  assert.equal(calls.length, 0);
});
