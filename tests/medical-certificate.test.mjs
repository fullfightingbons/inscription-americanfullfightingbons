import test from "node:test";
import assert from "node:assert/strict";

import {
  CERTIFICATE_COMMITMENT_TEXT,
  resolveCertificateSubmission,
} from "../src/routes/_lib/medical-certificate.js";

test("certificat non exigé : rien à fournir, aucun engagement conservé", () => {
  const r = resolveCertificateSubmission({ required: false, hasFile: false, commitment: true });
  assert.deepEqual(r, { deferred: false, commitment: false, error: null });
});

test("certificat exigé + pièce jointe : pas de report, l'engagement éventuel est écarté", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: true, commitment: true });
  assert.deepEqual(r, { deferred: false, commitment: false, error: null });
});

test("certificat exigé sans pièce mais case d'engagement cochée : report accepté", () => {
  const r = resolveCertificateSubmission({ required: true, hasFile: false, commitment: true });
  assert.deepEqual(r, { deferred: true, commitment: true, error: null });
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
