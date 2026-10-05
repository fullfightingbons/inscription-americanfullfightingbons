import test from "node:test";
import assert from "node:assert/strict";

import {
  CERTIFICATE_COMMITMENT_TEXT,
  certificateValidityMonths,
  evaluateCertificateReuse,
  findReusableCertificate,
  resolveCertificateSubmission,
} from "../src/routes/_lib/medical-certificate.js";

test("certificat non exigé : rien à fournir, aucun engagement conservé", () => {
  const r = resolveCertificateSubmission({ required: false, hasFile: false, commitment: true });
  assert.deepEqual(r, { deferred: false, reused: false, commitment: false, error: null });
});

test("certificat exigé + pièce jointe : pas de report, l'engagement éventuel est écarté", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: true, commitment: true });
  assert.deepEqual(r, { deferred: false, reused: false, commitment: false, error: null });
});

test("certificat exigé sans pièce mais case d'engagement cochée : report accepté", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: false, commitment: true });
  assert.deepEqual(r, { deferred: true, reused: false, commitment: true, error: null });
});

test("certificat exigé, ni pièce ni engagement : refus avec un message explicite", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: false, commitment: false });
  assert.equal(r.deferred, false);
  assert.equal(r.commitment, false);
  assert.match(r.error, /certificat médical est obligatoire/);
  assert.match(r.error, /case d'engagement/);
});

test("seule la valeur booléenne true vaut engagement (pas de chaîne « false » interprétée comme vraie)", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: false, commitment: "false" });
  assert.equal(r.deferred, false);
  assert.ok(r.error);
});

test("le libellé d'engagement conservé pour les e-mails/PDF est celui demandé par le bureau", () => {
  assert.equal(
    CERTIFICATE_COMMITMENT_TEXT,
    "Je m'engage à fournir le certificat médical au plus vite, à défaut, l'accès aux entraînements me sera refusé",
  );
});

// ── Réutilisation d'un certificat déjà validé (renouvellement) ──────────────

test("certificat réutilisable : accepté sans pièce ni engagement, et l'engagement éventuel est écarté", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: false, commitment: true, reusable: true });
  assert.deepEqual(r, { deferred: false, reused: true, commitment: false, error: null });
});

test("une pièce jointe l'emporte sur un certificat réutilisable (plus récente)", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: true, commitment: false, reusable: true });
  assert.deepEqual(r, { deferred: false, reused: false, commitment: false, error: null });
});

test("certificat non exigé : rien n'est « réutilisé » même si un certificat existe", () => {
  const r = resolveCertificateSubmission({ required: false, hasFile: false, commitment: false, reusable: true });
  assert.equal(r.reused, false);
});

test("durée de validité : celle de gestion, plafonnée à 3 ans, repli 12 mois comme gestion", () => {
  assert.equal(certificateValidityMonths("36"), 36);
  assert.equal(certificateValidityMonths("24"), 24);
  assert.equal(certificateValidityMonths("120"), 36);
  assert.equal(certificateValidityMonths(undefined), 12);
  assert.equal(certificateValidityMonths("abc"), 12);
  assert.equal(certificateValidityMonths("0"), 12);
});

const TODAY = "2026-10-05";
const joined = (day) => ({ submitted_at: `${day}T10:00:00.000Z`, documents_json: JSON.stringify({ medicalCertificate: { key: "k" } }), dossier_json: "{}" });
const reusedFrom = (day) => ({ submitted_at: "2026-09-01T10:00:00.000Z", documents_json: "{}", dossier_json: JSON.stringify({ computedTotals: { certificateReused: true, certificateReferenceDate: day } }) });
const evalReuse = (over) => evaluateCertificateReuse({ certificat: 1, certificatDate: null, registrations: [], validityMonths: 36, today: TODAY, ...over });

test("réutilisable : certificat joint à l'inscription de la saison précédente, validé, dans les 3 ans", () => {
  const r = evalReuse({ registrations: [joined("2025-09-10")] });
  assert.deepEqual(r, { reusable: true, reason: "reusable", referenceDate: "2025-09-10", validUntil: "2028-09-10" });
});

test("réutilisable en N+2 grâce à la date d'origine reportée, sans jamais prolonger la validité", () => {
  const r = evalReuse({ registrations: [joined("2024-09-10"), reusedFrom("2024-09-10")] });
  assert.equal(r.reusable, true);
  assert.equal(r.validUntil, "2027-09-10");
});

test("plus réutilisable au-delà de 3 ans : un nouveau certificat est demandé", () => {
  const r = evalReuse({ registrations: [joined("2023-10-04")] });
  assert.equal(r.reusable, false);
  assert.equal(r.reason, "expired");
  assert.equal(r.validUntil, "2026-10-04");
});

test("limite : encore valable le jour exact de l'échéance", () => {
  assert.equal(evalReuse({ registrations: [joined("2023-10-05")] }).reusable, true);
});

test("durée plus courte configurée dans gestion : respectée (on ne réutilise pas ce que gestion juge expiré)", () => {
  assert.equal(evalReuse({ validityMonths: 12, registrations: [joined("2025-10-10")] }).reusable, true);
  assert.equal(evalReuse({ validityMonths: 12, registrations: [joined("2025-10-01")] }).reusable, false);
});

test("fiche non validée (case « Certificat » décochée) : pas de réutilisation", () => {
  assert.equal(evalReuse({ certificat: 0, registrations: [joined("2025-09-10")] }).reason, "not_validated");
  assert.equal(evalReuse({ certificat: null, registrations: [joined("2025-09-10")] }).reusable, false);
});

test("adulte dispensé (Certificat = 1 sans aucun certificat, sans date) : rien à réutiliser", () => {
  const r = evalReuse({ registrations: [{ submitted_at: "2025-09-10T10:00:00.000Z", documents_json: "{}", dossier_json: "{}" }] });
  assert.equal(r.reusable, false);
  assert.equal(r.reason, "no_date");
});

test("date saisie sur la fiche (dépôt espace membre) : utilisée, et la plus récente des sources l'emporte", () => {
  assert.equal(evalReuse({ certificatDate: "2025-12-01" }).validUntil, "2028-12-01");
  const r = evalReuse({ certificatDate: "2022-01-15", registrations: [joined("2025-09-10")] });
  assert.equal(r.referenceDate, "2025-09-10");
  assert.equal(r.reusable, true);
});

test("dates incohérentes (futur, illisible) ou JSON cassé : ignorés sans planter", () => {
  assert.equal(evalReuse({ certificatDate: "2030-01-01" }).reason, "no_date");
  assert.equal(evalReuse({ certificatDate: "n'importe quoi" }).reason, "no_date");
  const broken = { submitted_at: "2025-09-10T10:00:00.000Z", documents_json: "{pas du json", dossier_json: "[" };
  assert.equal(evalReuse({ registrations: [broken] }).reason, "no_date");
});

test("accepte les colonnes déjà parsées (objets) comme les chaînes JSON", () => {
  const reg = { submitted_at: "2025-09-10T10:00:00.000Z", documents_json: { medicalCertificate: { key: "k" } }, dossier_json: {} };
  assert.equal(evalReuse({ registrations: [reg] }).reusable, true);
});

// Mini D1 simulée : une seule table de réponses par motif de requête.
function fakeDb({ adherent, registrations = [], duree = { valeur: "36" }, boom = false }) {
  return {
    prepare(sql) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (boom) throw new Error("D1 indisponible");
          if (/FROM adherents/.test(sql)) return adherent;
          if (/FROM club_info/.test(sql)) return duree;
          return null;
        },
        async all() { if (boom) throw new Error("D1 indisponible"); return { results: registrations }; },
      };
      return stmt;
    },
  };
}
const NOW = new Date("2026-10-05T08:00:00Z");

test("findReusableCertificate : lit fiche, inscriptions et durée de validité", async () => {
  const db = fakeDb({ adherent: { certificat: 1, certificat_date: null }, registrations: [joined("2025-09-10")] });
  const r = await findReusableCertificate(db, "adh-1", NOW);
  assert.equal(r.reusable, true);
  assert.equal(r.validUntil, "2028-09-10");
});

test("findReusableCertificate : durée du club inférieure à 3 ans respectée", async () => {
  const db = fakeDb({ adherent: { certificat: 1, certificat_date: null }, registrations: [joined("2025-09-10")], duree: { valeur: "12" } });
  assert.equal((await findReusableCertificate(db, "adh-1", NOW)).reusable, false);
});

test("findReusableCertificate : fiche introuvable, identifiant absent ou erreur D1 → jamais de réutilisation, jamais d'exception", async () => {
  assert.equal((await findReusableCertificate(fakeDb({ adherent: null }), "adh-1", NOW)).reason, "no_adherent");
  assert.equal((await findReusableCertificate(fakeDb({ adherent: {} }), "", NOW)).reason, "no_adherent");
  assert.equal((await findReusableCertificate(fakeDb({ adherent: {}, boom: true }), "adh-1", NOW)).reason, "lookup_failed");
});
