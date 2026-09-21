// E-mail de confirmation de paiement (sendPaymentConfirmedAlert, payment/helloasso/status.js) :
// le reçu de cotisation part dans le MÊME e-mail que le dossier récapitulatif, en pièce jointe
// séparée, à l'adhérent et au club.
//
// Brevo (api.brevo.com) est simulé en remplaçant fetch ; la base D1 et le binding ASSETS sont des
// doublures minimales. Chaque cas vérifie ce que Brevo REÇOIT réellement (destinataires, pièces
// jointes décodées, corps) — pas seulement que la fonction ne lève pas.

import test, { mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { sendPaymentConfirmedAlert } from "../src/routes/api/public/payment/helloasso/status.js";
import { calculateTotals } from "../src/routes/_lib/helpers.js";

const latin1 = (buf) => Buffer.from(buf).toString("latin1");

afterEach(() => mock.restoreAll());

// ── Doublures ────────────────────────────────────────────────────────────────
const LOGO_PNG = fs.readFileSync(new URL("../public/assets/Logo_1_nnoir_copie-removebg-preview.png", import.meta.url));
const ASSETS = { fetch: async () => new Response(LOGO_PNG) };

const PRICING = { base: 250, family: 200, pro: 125, cseThales: 39, bureau: 0, newMemberKit: 40, passport: 25, tshirt: 25, pantalon: 15 };
const totalsFor = (practice, clothing) => calculateTotals(practice, PRICING, clothing, [], []);

const ADHERENT_ID = "ad-0123456789abcdef";
function adherentRow(over = {}) {
  return {
    id: ADHERENT_ID, nom: "ANDRIEU", prenom: "Mickaël", adresse: "12 chemin des Grands Prés", code_postal: "74200", ville: "Thonon-les-Bains",
    discipline: "Club", cotisation: 250, montant_pass_region: 0, paiement: "HelloAsso", date_inscription: "2026-09-08", date_fin_adhesion: "2027-06-30", ...over,
  };
}

function makeDossier({ health = {}, practice = { formulaCode: "base", typeInscription: "nouvelle" }, clothing = { tshirtQty: 1, tshirtSize: "M", pantalonQty: 1, pantalonSize: "L" } } = {}) {
  const totals = totalsFor(practice, clothing);
  return {
    identity: { lastName: "ANDRIEU", firstName: "Mickaël", birthDate: "1990-05-12" },
    contact: { email: "mickael@example.com", address1: "12 chemin des Grands Prés", postalCode: "74200", city: "Thonon-les-Bains" },
    emergency: {}, practice, health, consents: { rulesAccepted: true, imageRights: "yes" },
    clothingOrder: { ...clothing, tshirtQty: totals.tshirtQty, pantalonQty: totals.pantalonQty },
    computedTotals: totals, payment: { installmentCount: 1 },
  };
}

const REGISTRATION = {
  id: "11111111-2222-4333-8444-555555555555", nom: "ANDRIEU", prenom: "Mickaël", email: "Mickael@Example.com", montant_total: 290,
  // Statut lu au début de la requête : le verrou anti-concurrence l'a posé à « traitement_paiement ».
  statut: "traitement_paiement", submitted_at: "2026-09-08T10:00:00.000Z", created_at: "2026-09-08T10:00:00.000Z",
  updated_at: "2026-09-08T10:01:00.000Z", exercice_id: "ex27", documents_json: "{}",
};
const EXERCISE = { id: "ex27", libelle: "2026-2027", date_fin: "2027-06-30" };
const SNAPSHOT_PAID = { status: "payee", installmentCount: 1, paidAmountCents: 29000, remainingAmountCents: 0 };

function makeEnv({ adherent = adherentRow(), dbThrows = false, brevoKey = "test-key" } = {}) {
  return {
    BREVO_API_KEY: brevoKey, SIGNUP_ALERT_TO: "club@example.com", SIGNUP_ALERT_FROM: "contact@example.com", ASSETS,
    DB: {
      prepare(sql) {
        let binds = [];
        const stmt = {
          bind(...args) { binds = args; return stmt; },
          async first() {
            if (dbThrows) throw new Error("D1 indisponible");
            if (/FROM adherents WHERE id/.test(sql)) return adherent && binds[0] === adherent.id ? adherent : null;
            return null;
          },
        };
        return stmt;
      },
    },
  };
}

// Remplace fetch : chaque réponse de `responses` est renvoyée à tour de rôle (la dernière se répète).
function mockBrevo(responses = [{ status: 201 }]) {
  const calls = [];
  const fn = mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r.throws) throw new Error(r.throws);
    return new Response(r.text ?? '{"messageId":"m1"}', { status: r.status });
  });
  return { calls, fn };
}
const silence = () => mock.method(console, "error", () => {});
const decode = (attachment) => Buffer.from(attachment.content, "base64");
const isPdf = (buf) => latin1(buf.subarray(0, 5)) === "%PDF-" && latin1(buf.subarray(-8)).includes("%%EOF");

// ── Cas nominal ──────────────────────────────────────────────────────────────

test("le reçu part dans le même e-mail que le récapitulatif : 2 pièces jointes, club et adhérent en destinataires", async () => {
  const { calls } = mockBrevo();
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);

  assert.equal(calls.length, 1, "un seul envoi : les deux documents partent en simultané");
  const { url, body } = calls[0];
  assert.equal(url, "https://api.brevo.com/v3/smtp/email");
  assert.deepEqual(body.to.map((t) => t.email), ["club@example.com", "mickael@example.com"]);

  assert.deepEqual(body.attachment.map((a) => a.name), ["inscription-affbc-11111111.pdf", "Recu-cotisation-Mickael-ANDRIEU-2026-2027.pdf"]);
  for (const a of body.attachment) assert.ok(isPdf(decode(a)), `${a.name} est un PDF valide`);
});

test("le reçu joint est celui du bouton « Reçu » : articles avec tailles, total facturé, numéro stable", async () => {
  const { calls } = mockBrevo();
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  const receipt = latin1(decode(calls[0].body.attachment[1]));

  assert.ok(receipt.includes("(Mickaël ANDRIEU)"));
  assert.ok(receipt.includes("(T-shirt club AFFBC \\(taille M\\))"));
  assert.ok(receipt.includes("(Pantalon club AFFBC \\(taille L\\))"));
  assert.ok(receipt.includes("290,00 \u0080"));
  assert.ok(receipt.includes("REC-2026-2027-AD012345"), "REC-<saison>-<8 premiers caractères de l'id>");
  assert.ok(receipt.includes("/Subtype /Image"), "avec le vrai logo du club");
  // le statut « traitement_paiement » lu au début de la requête n'a pas exclu l'inscription
  assert.ok(!receipt.includes("Autres articles"));
});

test("le corps de l'e-mail annonce le reçu (numéro, total) et le distingue du récapitulatif", async () => {
  const { calls } = mockBrevo();
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  const { htmlContent, textContent } = calls[0].body;
  assert.ok(htmlContent.includes("le dossier PDF récapitulatif est joint à cet email"));
  assert.ok(htmlContent.includes("Reçu de cotisation :</strong> joint à cet email dans un fichier séparé"));
  assert.ok(htmlContent.includes("REC-2026-2027-AD012345"));
  assert.ok(textContent.includes("PDF joint : inscription-affbc-11111111.pdf"));
  assert.ok(textContent.includes("Reçu joint : Recu-cotisation-Mickael-ANDRIEU-2026-2027.pdf"));
  assert.ok(!htmlContent.includes("n'a pas pu"), "aucun avertissement quand tout s'est bien passé");
});

test("séparation voulue : le récapitulatif contient les données de santé, le reçu n'en contient aucune", async () => {
  const { calls } = mockBrevo();
  const dossier = makeDossier({ health: { qsSport: { chestPain: "yes", fainting: "yes" } } });
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, dossier, ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  const [recap, receipt] = calls[0].body.attachment.map((a) => latin1(decode(a)).toLowerCase());
  assert.ok(recap.includes("affirmative"), "le récapitulatif signale les réponses positives du questionnaire de santé");
  for (const forbidden of ["affirmative", "poitrine", "questionnaire", "certificat"]) {
    assert.ok(!receipt.includes(forbidden), `« ${forbidden} » ne doit pas figurer sur le reçu`);
  }
});

test("sans état de paiement transmis (ancien appel), le reçu est quand même produit depuis le dossier", async () => {
  const { calls } = mockBrevo();
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE);
  assert.equal(calls[0].body.attachment.length, 2);
  assert.ok(latin1(decode(calls[0].body.attachment[1])).includes("(T-shirt club AFFBC \\(taille M\\))"));
});

test("l'e-mail n'annonce pas un second montant : le total du reçu (Pass Région inclus) reste sur le reçu", async () => {
  // « Montant » (ligne existante) = ce que paie l'adhérent ; le total du reçu inclut le Pass Région.
  // Deux montants différents dans le même message prêteraient à confusion.
  const { calls } = mockBrevo();
  const practice = { formulaCode: "base", typeInscription: "nouvelle", passRegionEnabled: true, passRegionAmount: 30 };
  const dossier = makeDossier({ practice });
  const registration = { ...REGISTRATION, montant_total: dossier.computedTotals.total };
  await sendPaymentConfirmedAlert(makeEnv({ adherent: adherentRow({ cotisation: dossier.computedTotals.cotisation, montant_pass_region: 30 }) }), registration, dossier, ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  const { htmlContent } = calls[0].body;
  assert.ok(htmlContent.includes(`Montant :</strong> ${dossier.computedTotals.total.toFixed(2)} €`));
  assert.ok(!htmlContent.includes((dossier.computedTotals.total + 30).toFixed(2)), "le total du reçu (Pass Région inclus) n'apparaît pas dans le corps");
  assert.ok(latin1(decode(calls[0].body.attachment[1])).includes(`${(dossier.computedTotals.total + 30).toFixed(2).replace(".", ",")} \u0080`), "il figure sur le reçu");
});

// ── Paiement en plusieurs fois ───────────────────────────────────────────────

test("paiement en 3 fois : le reçu dit ce qui est réglé à ce jour et ce qui reste à prélever", async () => {
  const { calls } = mockBrevo();
  const snapshot = { status: "paiement_planifie", installmentCount: 3, paidAmountCents: 9667, remainingAmountCents: 19333 };
  const dossier = { ...makeDossier(), payment: { installmentCount: 3 } };
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, dossier, ADHERENT_ID, EXERCISE, snapshot);
  const receipt = latin1(decode(calls[0].body.attachment[1]));
  assert.ok(receipt.includes("en 3 fois - 96,67 \u0080 r\u00e9gl\u00e9s \u00e0 ce jour, 193,33 \u0080 \u00e0 pr\u00e9lever"));
  assert.ok(receipt.includes("290,00 \u0080"), "le total reste la valeur de l'adhésion");
});

// ── Robustesse : le reçu ne doit JAMAIS empêcher l'e-mail de partir ──────────

test("échec de génération du reçu : l'e-mail part avec le récapitulatif seul, et le dit", async () => {
  const { calls } = mockBrevo();
  const err = silence();
  await sendPaymentConfirmedAlert(makeEnv({ dbThrows: true }), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.attachment.map((a) => a.name), ["inscription-affbc-11111111.pdf"]);
  assert.ok(calls[0].body.htmlContent.includes("Le reçu de cotisation n'a pas pu être joint automatiquement"));
  assert.ok(calls[0].body.htmlContent.includes("bouton « Reçu »"));
  assert.ok(calls[0].body.textContent.includes("Reçu non joint automatiquement"));
  assert.ok(err.mock.calls.some((c) => String(c.arguments[0]).includes("Génération du reçu impossible")), "l'échec est journalisé");
});

test("fiche adhérent introuvable : même traitement (anomalie signalée, e-mail envoyé)", async () => {
  const { calls } = mockBrevo();
  silence();
  await sendPaymentConfirmedAlert(makeEnv({ adherent: null }), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  assert.equal(calls[0].body.attachment.length, 1);
  assert.ok(calls[0].body.htmlContent.includes("n'a pas pu être joint"));
});

test("rien à recevoir (total nul) : pas de reçu, et surtout pas de message d'erreur", async () => {
  const { calls } = mockBrevo();
  const dossier = { ...makeDossier(), computedTotals: { ...makeDossier().computedTotals, cotisation: 0, total: 0, clothingTotal: 0, tshirtQty: 0, pantalonQty: 0 } };
  await sendPaymentConfirmedAlert(makeEnv({ adherent: adherentRow({ cotisation: 0 }) }), REGISTRATION, dossier, ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  assert.deepEqual(calls[0].body.attachment.map((a) => a.name), ["inscription-affbc-11111111.pdf"]);
  assert.ok(!calls[0].body.htmlContent.includes("n'a pas pu"));
  assert.ok(!calls[0].body.textContent.includes("Reçu"));
});

test("Brevo refuse l'envoi (4xx) avec le reçu : nouvel envoi SANS le reçu, avec la mention", async () => {
  const { calls } = mockBrevo([{ status: 400, text: '{"code":"invalid_parameter"}' }, { status: 201 }]);
  const err = silence();
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.attachment.length, 2, "1er essai : récapitulatif + reçu");
  assert.deepEqual(calls[1].body.attachment.map((a) => a.name), ["inscription-affbc-11111111.pdf"], "2e essai : récapitulatif seul");
  assert.ok(calls[1].body.htmlContent.includes("n'a pas pu être joint automatiquement"), "l'adhérent sait que le reçu manque");
  assert.ok(!calls[1].body.htmlContent.includes("joint à cet email dans un fichier séparé"));
  assert.ok(err.mock.calls.some((c) => String(c.arguments[0]).includes("nouvel essai sans le reçu")));
});

test("erreur 5xx ou réseau : aucun nouvel essai (l'e-mail a pu partir, un second envoi le doublerait)", async () => {
  silence();
  const a = mockBrevo([{ status: 503 }]);
  await sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  assert.equal(a.calls.length, 1);
  mock.restoreAll();
  silence();
  const b = mockBrevo([{ throws: "ECONNRESET" }]);
  await assert.doesNotReject(() => sendPaymentConfirmedAlert(makeEnv(), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID));
  assert.equal(b.calls.length, 1);
});

test("4xx sans reçu joint : pas de nouvel essai inutile", async () => {
  silence();
  const { calls } = mockBrevo([{ status: 400 }]);
  await sendPaymentConfirmedAlert(makeEnv({ adherent: adherentRow({ cotisation: 0 }) }), REGISTRATION,
    { ...makeDossier(), computedTotals: { ...makeDossier().computedTotals, cotisation: 0, total: 0, clothingTotal: 0, tshirtQty: 0, pantalonQty: 0 } },
    ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  assert.equal(calls.length, 1);
});

test("sans clé Brevo : aucun envoi, aucune génération (comportement d'origine)", async () => {
  const { calls } = mockBrevo();
  await sendPaymentConfirmedAlert(makeEnv({ brevoKey: "" }), REGISTRATION, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  assert.equal(calls.length, 0);
});

test("adhérent sans e-mail : le reçu part au moins au club (comportement d'origine conservé)", async () => {
  const { calls } = mockBrevo();
  await sendPaymentConfirmedAlert(makeEnv(), { ...REGISTRATION, email: "" }, makeDossier(), ADHERENT_ID, EXERCISE, SNAPSHOT_PAID);
  assert.deepEqual(calls[0].body.to.map((t) => t.email), ["club@example.com"]);
  assert.equal(calls[0].body.attachment.length, 2);
});
