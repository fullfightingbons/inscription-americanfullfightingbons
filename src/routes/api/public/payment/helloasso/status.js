/**
 * AFFBC — Worker Cloudflare Pages : vérification du statut de paiement HelloAsso
 *
 * GET /api/public/payment/helloasso/status?registrationId=xxx
 *
 * Ce handler :
 *   1. Récupère l'inscription dans `inscriptions_publiques`
 *   2. Interroge l'API HelloAsso pour connaître l'état du paiement
 *   3. Si paid === true ET que la fiche adhérent n'existe pas encore :
 *        a. Crée la fiche dans `adherents`
 *        b. Crée la vente de tenue dans `factures` (si commande de vêtements)
 *        c. Met à jour `inscriptions_publiques` avec adherent_id et statut "payee"
 *   4. Retourne { paid, registrationId, adherentId }
 */

import { badRequest, json } from "../../../../_lib/data.js";
import {
  badPaymentRequest,
  getRegistration,
  helloAssoRequest,
  parseDossierJson,
  updateRegistrationPayment,
} from "../../../../_lib/public-payments.js";
import { generateAdherentPdf } from "../../../../_lib/pdf.js";
import { isMinor, toBool } from "../../../../_lib/helpers.js";
function getActiveExerciseDate(endDate) {
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return endDate;
  }
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-07-31`;
}

function toAmountCents(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number.isInteger(amount) ? amount : Math.round(amount * 100);
}

function buildPaymentSnapshot(order, dossier, checkoutIntentId) {
  const installmentCount = Math.max(1, Math.min(3, Number(dossier?.payment?.installmentCount || 1)));
  const totalAmountCents = toAmountCents(dossier?.computedTotals?.total || 0);
  const payments = Array.isArray(order?.payments) ? order.payments.filter(Boolean) : [];
  const paidAmountCents = payments.reduce((sum, payment) => sum + toAmountCents(payment?.amount), 0);
  const paidInstallments = Math.min(
    installmentCount,
    payments.filter((payment) => toAmountCents(payment?.amount) > 0).length,
  );
  const hasInitialPayment = Boolean(order?.id) && paidInstallments > 0;
  const fullyPaid = installmentCount === 1
  ? hasInitialPayment
  : paidInstallments >= installmentCount || (totalAmountCents > 0 && paidAmountCents >= totalAmountCents);
  return {
    status: fullyPaid ? "payee" : "paiement_planifie",
    hasInitialPayment,
    fullyPaid,
    installmentCount,
    paidInstallments,
    remainingInstallments: Math.max(0, installmentCount - paidInstallments),
    paidAmountCents,
    remainingAmountCents: Math.max(0, totalAmountCents - paidAmountCents),
    reference: String(order?.payments?.[0]?.cashOutState || order?.id || checkoutIntentId),
  };
}

function normalizeCheckoutIntentId(value) {
  return String(value || "").trim().replace(/\.0+$/, "");
}

async function findActiveExercise(db) {
  const active = await db
  .prepare(`SELECT * FROM exercices WHERE statut = 'actif' ORDER BY date_debut DESC LIMIT 1`)
  .first();
  if (active?.id) return active;
  return db
  .prepare(`SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1`)
  .first();
}

async function findMatchingAdherent(db, payload) {
  const identity = payload?.identity || {};
  const contact = payload?.contact || {};
  const nom = String(identity.lastName || "").trim().toUpperCase();
  const prenom = String(identity.firstName || "").trim();
  const birthDate = String(identity.birthDate || "").trim();
  const email = String(contact.email || "").trim().toLowerCase();
  if (!nom || !prenom || !birthDate || !email) return null;
  const matches = await db
  .prepare(
    `SELECT *
    FROM adherents
    WHERE nom = ? AND prenom = ? AND naissance = ? AND lower(email) = lower(?)
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1`,
  )
  .bind(nom, prenom, birthDate, email)
  .all();
  return matches?.results?.[0] || null;
}

// ─── Création de la fiche adhérent ───────────────────────────────────────────

async function upsertAdherent(db, payload, totals, exercise) {
  const now = new Date().toISOString();
  const existing = await findMatchingAdherent(db, payload);
  const adherentId = existing?.id ? String(existing.id) : crypto.randomUUID();

  const identity = payload.identity || {};
  const contact = payload.contact || {};
  const emergency = payload.emergency || {};
  const practice = payload.practice || {};
  const legalRep = payload.legalRepresentative || {};
  const minor = isMinor(identity.birthDate);

  const notes = [
    "Inscription web publique — paiement HelloAsso confirmé",
    `Pratique : ${practice.practiceType}`,
    `Formule : ${practice.formulaCode}`,
    `Montant total dossier : ${totals.total.toFixed(2)} €`,
    practice.passRegionEnabled
    ? `Pass Région : ${totals.passRegionAmount.toFixed(2)} €`
    : "",
    practice.passRegionEnabled && practice.passRegionCode
    ? `Code Pass Région : ${practice.passRegionCode}`
    : "",
    practice.passportEnabled ? "Passeport sportif demandé" : "",
    minor
    ? `Représentant légal : ${legalRep.firstName || ""} ${legalRep.lastName || ""}`.trim()
    : "",
  ]
  .filter(Boolean)
  .join(" | ");

  const row = {
    id: adherentId,
    nom: String(identity.lastName || "").trim().toUpperCase(),
    prenom: String(identity.firstName || "").trim(),
    naissance: identity.birthDate,
    email: String(contact.email || "").trim().toLowerCase(),
    telephone: `${contact.phonePrimary || ""} / ${contact.phoneSecondary || ""}`.trim(),
    adresse: [contact.address1 || "", contact.address2 || ""].filter(Boolean).join(", "),
    code_postal: String(contact.postalCode || "").trim(),
    ville: String(contact.city || "").trim(),
    discipline: existing?.discipline || (String(practice.formulaCode || "") === "bureau" ? "Membre du Bureau" : "Club"),
    droit_image: (payload.consents?.imageRights === "yes") ? 1 : 0,
    certificat: totals.certificateRequired ? 0 : 1,
    pass_region: practice.passRegionEnabled ? 1 : 0,
    montant_pass_region: totals.passRegionAmount || 0,
    reglement: 1,
    cotisation: totals.cotisation,
    paiement: "HelloAsso",
    statut: "Actif",
    date_inscription: now.slice(0, 10),
    date_fin_adhesion: getActiveExerciseDate(exercise?.date_fin),
    urgence_nom: String(emergency.lastName || "").trim(),
    urgence_telephone: `${emergency.phonePrimary || ""} / ${emergency.phoneSecondary || ""}`.trim(),
    urgence_lien: minor ? String(legalRep.role || "").trim() : "Contact d'urgence",
    notes,
    pdf_storage_path: null,
    pdf_public_url: null,
    pdf_nom_fichier: null,
    pdf_uploaded_at: null,
    source_logiciel: "inscription-web",
    exercice_id: exercise?.id || null,
    created_at: existing?.created_at || now,
    updated_at: now,
    couleur_ceinture: existing?.couleur_ceinture || "",
    numero_licence: existing?.numero_licence || "",
  };

  const columns = Object.keys(row);
  if (existing?.id) {
    const assignments = columns.filter((column) => column !== "id").map((column) => `"${column}" = ?`).join(", ");
    await db
    .prepare(`UPDATE adherents SET ${assignments} WHERE id = ?`)
    .bind(...columns.filter((column) => column !== "id").map((column) => row[column]), adherentId)
    .run();
  } else {
    await db
    .prepare(
      `INSERT INTO adherents (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`,
    )
    .bind(...columns.map((c) => row[c]))
    .run();
  }

  return adherentId;
}

// ─── Création des ventes annexes dans factures ────────────────────────────────
//
// La table `factures` utilise :
//   id, numero, date_op, destinataire, adresse, objet, lignes (JSON),
//   statut, notes, exercice_id, created_at, updated_at
//
// `lignes` est un tableau JSON : [{ desc, qte, pu }]

async function nextFactureNumero(db, exercice_id) {
  const year = new Date().getFullYear();
  const result = await db.prepare(`SELECT COUNT(*) as cnt FROM factures WHERE exercice_id = ?`).bind(exercice_id).first();
  const n = (result?.cnt || 0) + 1;
  const ts = Date.now().toString(36).slice(-4).toUpperCase(); // suffixe anti-collision
  return `VTE-${year}-${String(n).padStart(3, "0")}-${ts}`;
}

async function insertInscriptionSales(db, registrationId, adherentId, nom, prenom, adresse, totals, exercise) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const numero = await nextFactureNumero(db, exercise?.id);

  const lignes = [];
  if (Number(totals.newMemberKit || 0) > 0) {
    lignes.push({
      desc: "Supplément tenue nouvel adhérent",
      qte: 1,
      pu: Number(totals.newMemberKit || 0),
    });
  }
  if (Number(totals.passport || 0) > 0) {
    lignes.push({
      desc: "Passeport sportif",
      qte: 1,
      pu: Number(totals.passport || 0),
    });
  }
  if (totals.tshirtQty > 0) {
    lignes.push({
      desc: "T-shirt club AFFBC",
      qte: totals.tshirtQty,
      pu: totals.pricingTshirt,
    });
  }
  if (totals.pantalonQty > 0) {
    lignes.push({
      desc: "Pantalon club AFFBC",
      qte: totals.pantalonQty,
      pu: totals.pricingPantalon,
    });
  }

  if (lignes.length === 0) return null; // rien à créer

  const row = {
    id,
    numero,
    date_op: now.slice(0, 10),
    destinataire: `${prenom} ${nom}`.trim(),
    adresse: adresse || "",
    objet: "Ventes liées à l'inscription web",
    lignes: JSON.stringify(lignes),
    statut: "Payée", // paiement HelloAsso déjà confirmé
    notes: `Vente générée automatiquement lors de l'inscription web. Paiement HelloAsso validé. Registration ID : ${registrationId}. Adhérent ID : ${adherentId}`,
    exercice_id: exercise?.id || null,
    created_at: now,
    updated_at: now,
  };

  const columns = Object.keys(row);
  await db
  .prepare(
    `INSERT INTO factures (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`,
  )
  .bind(...columns.map((c) => row[c]))
  .run();

  return id;
}

async function insertJournalEntryPair(db, entries) {
  for (const entry of entries) {
    const columns = Object.keys(entry);
    await db
    .prepare(
      `INSERT INTO journal_comptable (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`,
    )
    .bind(...columns.map((c) => entry[c]))
    .run();
  }
}

async function findHelloAssoBankAccountId(db) {
  const configRows = await db
  .prepare(
    `SELECT cle, valeur
    FROM club_info
    WHERE cle IN ('helloasso_bank_account_id', 'public_inscription_bank_account_id', 'default_bank_account_id')`,
  )
  .all();
  const preferredId = (configRows?.results || []).map((row) => String(row?.valeur || "").trim()).find(Boolean);
  if (preferredId) {
    const preferred = await db
    .prepare(`SELECT id FROM comptes_bancaires WHERE id = ? LIMIT 1`)
    .bind(preferredId)
    .first();
    if (preferred?.id) return String(preferred.id);
  }
  const fallback = await db
  .prepare(`SELECT id FROM comptes_bancaires ORDER BY created_at ASC, nom ASC LIMIT 1`)
  .first();
  return fallback?.id ? String(fallback.id) : null;
}

async function upsertJournalEntryByPiece(db, entry) {
  const existing = await db
  .prepare(`SELECT id FROM journal_comptable WHERE piece = ? LIMIT 1`)
  .bind(entry.piece)
  .first();
  const columns = Object.keys(entry);
  if (existing?.id) {
    const assignments = columns.map((column) => `"${column}" = ?`).join(", ");
    await db
    .prepare(`UPDATE journal_comptable SET ${assignments} WHERE id = ?`)
    .bind(...columns.map((column) => entry[column]), existing.id)
    .run();
    return String(existing.id);
  }
  await db
  .prepare(
    `INSERT INTO journal_comptable (${columns.map((column) => `"${column}"`).join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})`,
  )
  .bind(...columns.map((column) => entry[column]))
  .run();
  return String(entry.id);
}

async function upsertHelloAssoPaymentJournal(db, registrationId, adherentId, nom, prenom, paidAmount, exercise, paidAt) {
  if (!(paidAmount > 0)) return null;
  const now = new Date().toISOString();
  const dateOp = String(paidAt || now).slice(0, 10);
  const pieceBase = `PAY-${String(registrationId).slice(0, 8).toUpperCase()}`;
  const labelName = `${nom} ${prenom}`.trim();
  const common = {
    date_op: dateOp,
    source_type: "inscription_publique",
    source_id: registrationId,
    source_logiciel: "inscription-web",
    exercice_id: exercise?.id || null,
    updated_at: now,
  };

  await upsertJournalEntryByPiece(db, {
    id: crypto.randomUUID(),
                                  ...common,
                                  piece: `${pieceBase}-BNQ`,
                                  compte: "512 - Banque",
                                  libelle: `Encaissement HelloAsso - ${labelName}`,
                                  debit: paidAmount,
                                  credit: 0,
                                  created_at: now,
  });
  await upsertJournalEntryByPiece(db, {
    id: crypto.randomUUID(),
                                  ...common,
                                  piece: `${pieceBase}-CLI`,
                                  compte: "411 - Adhérents et clients",
                                  libelle: `Règlement HelloAsso - ${labelName}`,
                                  debit: 0,
                                  credit: paidAmount,
                                  created_at: now,
  });

  return pieceBase;
}

async function upsertHelloAssoBankTransaction(db, registrationId, nom, prenom, paidAmount, paidAt, piece) {
  if (!(paidAmount > 0)) return null;
  const compteId = await findHelloAssoBankAccountId(db);
  if (!compteId) return null;
  const now = new Date().toISOString();
  const dateOp = String(paidAt || now).slice(0, 10);
  const sourceDocument = `helloasso:${registrationId}`;
  const libelle = `Encaissement HelloAsso - ${`${nom} ${prenom}`.trim()}`;
  const row = {
    compte_id: compteId,
    date_op: dateOp,
    date_valeur: dateOp,
    libelle,
    debit: 0,
    credit: paidAmount,
    rapproche: 1,
    ecriture_piece: piece || null,
    source_document: sourceDocument,
    source_format: "helloasso",
    updated_at: now,
  };
  const existing = await db
  .prepare(`SELECT id FROM transactions WHERE source_document = ? LIMIT 1`)
  .bind(sourceDocument)
  .first();
  const columns = Object.keys(row);
  if (existing?.id) {
    const assignments = columns.map((column) => `"${column}" = ?`).join(", ");
    await db
    .prepare(`UPDATE transactions SET ${assignments} WHERE id = ?`)
    .bind(...columns.map((column) => row[column]), existing.id)
    .run();
    return String(existing.id);
  }
  const insertRow = {
    id: crypto.randomUUID(),
    ...row,
    created_at: now,
  };
  const insertColumns = Object.keys(insertRow);
  await db
  .prepare(
    `INSERT INTO transactions (${insertColumns.map((column) => `"${column}"`).join(", ")})
    VALUES (${insertColumns.map(() => "?").join(", ")})`,
  )
  .bind(...insertColumns.map((column) => insertRow[column]))
  .run();
  return insertRow.id;
}

async function insertCotisationJournal(db, adherentId, nom, prenom, totals, exercise, paidAt) {
  if (!Number(totals.cotisation || 0)) return null;
  const now = new Date().toISOString();
  const dateOp = String(paidAt || now).slice(0, 10);
  const piece = `ADH-${String(adherentId).slice(0, 8)}`;
  const labelName = `${nom} ${prenom}`.trim();
  const common = {
    date_op: dateOp,
    piece,
    source_type: "adherent",
    source_id: adherentId,
    source_logiciel: "inscription-web",
    exercice_id: exercise?.id || null,
    created_at: now,
    updated_at: now,
  };

  await insertJournalEntryPair(db, [
    {
      id: crypto.randomUUID(),
                               ...common,
                               compte: "411 - Adhérents et clients",
                               libelle: `Adhésion ${labelName}`,
                               debit: Number(totals.cotisation || 0),
                               credit: 0,
    },
    {
      id: crypto.randomUUID(),
                               ...common,
                               compte: "7561 - Cotisations membres actifs",
                               libelle: `Cotisation ${labelName}`,
                               debit: 0,
                               credit: Number(totals.cotisation || 0),
    },
  ]);

  return piece;
}

async function insertVenteTenueJournal(db, factureId, nom, prenom, totals, exercise, paidAt) {
  const clothingTotal = Number(totals.clothingTotal || 0);
  const newMemberKitTotal = Number(totals.newMemberKit || 0);
  const passportTotal = Number(totals.passport || 0);
  const totalSales = clothingTotal + newMemberKitTotal + passportTotal;
  if (!factureId || !totalSales) return null;
  const now = new Date().toISOString();
  const dateOp = String(paidAt || now).slice(0, 10);
  const piece = `VTE-${String(factureId).slice(0, 8)}`;
  const labelName = `${nom} ${prenom}`.trim();
  const factureNumero = await db
  .prepare(`SELECT numero FROM factures WHERE id = ? LIMIT 1`)
  .bind(factureId)
  .first();
  const suffix = factureNumero?.numero ? ` - ${factureNumero.numero}` : "";
  const libelleBase = `Vente - ${labelName}${suffix}`;
  const common = {
    date_op: dateOp,
    piece,
    source_type: "facture",
    source_id: factureId,
    source_logiciel: "inscription-web",
    exercice_id: exercise?.id || null,
    created_at: now,
    updated_at: now,
  };

  const entries = [
    {
      id: crypto.randomUUID(),
      ...common,
      compte: "411 - Adhérents et clients",
      libelle: `${libelleBase} - Vente inscription`,
      debit: totalSales,
      credit: 0,
    },
  ];
  if (clothingTotal > 0 || newMemberKitTotal > 0) {
    entries.push({
      id: crypto.randomUUID(),
                 ...common,
                 compte: "707 - Ventes vêtements et équipements",
                 libelle: `${libelleBase} - Vente de Tenue`,
                 debit: 0,
                 credit: clothingTotal + newMemberKitTotal,
    });
  }
  if (passportTotal > 0) {
    entries.push({
      id: crypto.randomUUID(),
                 ...common,
                 compte: "7562 - Cotisations licences et adhésions annexes",
                 libelle: `${libelleBase} - Passeport sportif`,
                 debit: 0,
                 credit: passportTotal,
    });
  }

  await insertJournalEntryPair(db, entries);

  return piece;
}

async function insertPassRegionJournal(db, adherentId, nom, prenom, totals, exercise, paidAt) {
  const amount = Number(totals.passRegionAmount || 0);
  if (!amount) return null;
  const now = new Date().toISOString();
  const dateOp = String(paidAt || now).slice(0, 10);
  const piece = `SUB-${String(adherentId).slice(0, 8)}`;
  const labelName = `${nom} ${prenom}`.trim();
  const common = {
    date_op: dateOp,
    piece,
    source_type: "adherent",
    source_id: adherentId,
    source_logiciel: "inscription-web",
    exercice_id: exercise?.id || null,
    created_at: now,
    updated_at: now,
  };

  await insertJournalEntryPair(db, [
    {
      id: crypto.randomUUID(),
                               ...common,
                               compte: "471 - Comptes d attente",
                               libelle: `Pass Région ${labelName}`,
                               debit: amount,
                               credit: 0,
    },
    {
      id: crypto.randomUUID(),
                               ...common,
                               compte: "7410 - Remboursements Pass Région",
                               libelle: `Subvention Pass Région ${labelName}`,
                               debit: 0,
                               credit: amount,
    },
  ]);

  return piece;
}

// ─── Encodage base64 binaire (Cloudflare Workers — pas de btoa sur bytes > 127) ─

function uint8ToBase64(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < len ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    result += i + 2 < len ? chars[b2 & 63] : "=";
  }
  return result;
}

// ─── Construction du dossier normalisé pour generateAdherentPdf ───────────────

function buildRegistrationPayload(registration, dossier, adherentId) {
  const totals = dossier.computedTotals || {};
  const pay    = dossier.payment        || {};
  return {
    id:            registration.id,
    submittedAt:   new Date().toISOString().slice(0, 10),
    identity:      dossier.identity             || {},
    contact:       dossier.contact              || {},
    emergency:     dossier.emergency            || {},
    practice:      dossier.practice             || {},
    health:        dossier.health               || {},
    clothingOrder: dossier.clothingOrder        || {},
    consents:      dossier.consents             || {},
    legalRepresentative: dossier.legalRepresentative || {},
    payment:       pay,
    computedTotals: {
      ...totals,
      formulaLabel:     totals.formulaLabel    || dossier.practice?.formulaCode || "",
      cotisation:       Number(totals.cotisation    || 0),
      clothingTotal:    Number(totals.clothingTotal || 0),
      newMemberKit:     Number(totals.newMemberKit  || 0),
      passport:         Number(totals.passport      || 0),
      passRegionAmount: Number(totals.passRegionAmount || 0),
      total:            Number(registration.montant_total || totals.total || 0),
      pricingTshirt:    Number(totals.pricingTshirt   || 25),
      pricingPantalon:  Number(totals.pricingPantalon || 10),
      certificateRequired: Boolean(totals.certificateRequired),
    },
  };
}

// ─── Email de confirmation de paiement ───────────────────────────────────────

async function sendPaymentConfirmedAlert(env, registration, dossier, adherentId) {
  if (!env.BREVO_API_KEY) return;
  const clubRecipient = env.SIGNUP_ALERT_TO || "fullfightingbons@gmail.com";
  const registrantRecipient = String(registration.email || "").trim().toLowerCase();
  const from = env.SIGNUP_ALERT_FROM || "contact@americanfullfightingbons.fr";
  const nom = registration.nom || "";
  const prenom = registration.prenom || "";
  const recipients = [
    { email: clubRecipient, name: env.SIGNUP_ALERT_TO_NAME || "AFFBC" },
    registrantRecipient
    ? { email: registrantRecipient, name: `${prenom} ${nom}`.trim() || registrantRecipient }
    : null,
  ].filter((entry, index, array) => entry && array.findIndex((item) => item?.email === entry.email) === index);

  // Génération PDF via le nouveau générateur mis en page
  const payload = buildRegistrationPayload(registration, dossier, adherentId);
  const pdfBytes = generateAdherentPdf(payload);
  const pdfContent = uint8ToBase64(pdfBytes);
  const fileName = `inscription-affbc-${String(registration.id || "").slice(0, 8)}.pdf`;

  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        name: env.SIGNUP_ALERT_SENDER_NAME || "AFFBC Inscriptions",
        email: from,
      },
      to: recipients,
      subject: `✅ Paiement confirmé — ${nom} ${prenom}`,
      htmlContent: `
      <html><body style="font-family:Arial,sans-serif">
      <h2 style="color:#1f6b47">✅ Paiement HelloAsso confirmé</h2>
      <p><strong>Adhérent :</strong> ${prenom} ${nom}</p>
      <p><strong>Email :</strong> ${registration.email || ""}</p>
      <p><strong>Montant :</strong> ${Number(registration.montant_total || 0).toFixed(2)} €</p>
      <p><strong>Référence inscription :</strong> ${registration.id}</p>
      <p><strong>Fiche adhérent créée (ID) :</strong> ${adherentId}</p>
      <p><strong>Pièce jointe :</strong> le dossier PDF récapitulatif est joint à cet email.</p>
      <p style="color:#888;font-size:12px">
      La fiche adhérent est maintenant visible dans le logiciel de gestion,
      onglet <strong>Adhérents</strong>. Si une tenue a été commandée,
      la vente apparaît dans l'onglet <strong>Ventes</strong>.
      </p>
      </body></html>`,
      textContent: [
        "Paiement HelloAsso confirmé",
        `Adhérent : ${prenom} ${nom}`,
        `Email : ${registration.email || ""}`,
        `Montant : ${Number(registration.montant_total || 0).toFixed(2)} €`,
                         `Référence : ${registration.id}`,
                         `Fiche adhérent ID : ${adherentId}`,
                         `PDF joint : ${fileName}`,
      ].join("\n"),
                         attachment: [
                           {
                             name: fileName,
                             content: pdfContent,
                           },
                         ],
    }),
  }).catch((err) => {
    console.error("[Brevo] Echec envoi email confirmation:", err?.message ?? String(err));
  });
}

async function storeRegistrationPdf(env, registration, dossier, adherentId) {
  try {
    const payload  = buildRegistrationPayload(registration, dossier, adherentId);
    const pdfBytes = generateAdherentPdf(payload);           // Uint8Array directement
    const fileName = `inscription-affbc-${String(registration.id || '').slice(0, 8)}.pdf`;
    const r2Key    = `adherents/${adherentId}/inscription-${String(registration.id).slice(0, 8)}.pdf`;

    const bucket = env.R2_PDF || env.R2_STORAGE;
    if (!bucket) return null;

    await bucket.put(r2Key, pdfBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { registrationId: registration.id, adherentId },
    });

    return { key: r2Key, fileName };
  } catch (e) {
    return null; // non bloquant
  }
}

// ─── Handler GET ──────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return badRequest("D1 binding is missing", 500);
  }

  try {
    const url = new URL(context.request.url);
    const registrationId = String(url.searchParams.get("registrationId") || "").trim();
    if (!registrationId) {
      return badRequest("registrationId obligatoire");
    }

    // ── Lecture de l'inscription en base ─────────────────────────────────────
    const registration = await getRegistration(context.env.DB, registrationId);
    const dossier = parseDossierJson(registration);
    const totals = dossier.computedTotals || {};

    // ── Vérification de l'état HelloAsso ─────────────────────────────────────
    const checkoutIntentId =
    normalizeCheckoutIntentId(
      registration.helloasso_checkout_intent_id ||
      dossier.payment?.helloAssoCheckoutIntentId,
    );

    if (!checkoutIntentId) {
      return badRequest("Checkout HelloAsso introuvable pour cette inscription");
    }

    const organizationSlug = context.env.HELLOASSO_ORGANIZATION_SLUG;
    const intent = await helloAssoRequest(
      context.env,
      `/organizations/${encodeURIComponent(organizationSlug)}/checkout-intents/${encodeURIComponent(checkoutIntentId)}`,
                                          "GET",
    );

    const order = intent.order || null;
    const paymentSnapshot = buildPaymentSnapshot(order, dossier, checkoutIntentId);
    const paid = paymentSnapshot.hasInitialPayment;
    const paidAmount = Number(paymentSnapshot.paidAmountCents || 0) / 100;
    const paidAt =
    order?.date ||
    order?.payments?.[0]?.date ||
    order?.payments?.[0]?.paidAt ||
    new Date().toISOString();

    if (!paid) {
      // Paiement pas encore effectué — on ne crée rien
      return json({
        data: {
          paid: false,
          fullyPaid: false,
          registrationId,
          adherentId: null,
          installmentCount: paymentSnapshot.installmentCount,
          paidInstallments: paymentSnapshot.paidInstallments,
          remainingInstallments: paymentSnapshot.remainingInstallments,
        },
        error: null,
      });
    }

    if (registration.adherent_id) {
      const exercise =
      (registration.exercice_id
      ? await context.env.DB.prepare(`SELECT * FROM exercices WHERE id = ? LIMIT 1`).bind(registration.exercice_id).first()
      : null) || await findActiveExercise(context.env.DB);
      const paymentPiece = await upsertHelloAssoPaymentJournal(
        context.env.DB,
        registrationId,
        registration.adherent_id,
        registration.nom,
        registration.prenom,
        paidAmount,
        exercise,
        paidAt,
      );
      await upsertHelloAssoBankTransaction(
        context.env.DB,
        registrationId,
        registration.nom,
        registration.prenom,
        paidAmount,
        paidAt,
        paymentPiece,
      );
      await updateRegistrationPayment(context.env.DB, registrationId, {
        status: paymentSnapshot.status,
        method: "helloasso",
        reference: paymentSnapshot.reference,
        payment: {
          method: "helloasso",
          helloAssoCheckoutIntentId: checkoutIntentId,
          helloAssoOrderId: order?.id || null,
          helloAssoOrder: order,
          helloAssoState: paymentSnapshot.fullyPaid ? "paid" : "scheduled",
          paidAt: paymentSnapshot.hasInitialPayment ? paidAt : null,
          installmentCount: paymentSnapshot.installmentCount,
          paidInstallments: paymentSnapshot.paidInstallments,
          remainingInstallments: paymentSnapshot.remainingInstallments,
          paidAmountCents: paymentSnapshot.paidAmountCents,
          remainingAmountCents: paymentSnapshot.remainingAmountCents,
        },
      });

      return json({
        data: {
          paid: true,
          fullyPaid: paymentSnapshot.fullyPaid,
          alreadyProcessed: true,
          registrationId,
          adherentId: registration.adherent_id,
          orderId: order?.id || null,
          installmentCount: paymentSnapshot.installmentCount,
          paidInstallments: paymentSnapshot.paidInstallments,
          remainingInstallments: paymentSnapshot.remainingInstallments,
        },
        error: null,
      });
    }

    // ── Paiement confirmé : création de la fiche adhérent ────────────────────
    const exercise = await findActiveExercise(context.env.DB);
    const adherentId = await upsertAdherent(
      context.env.DB,
      dossier,
      totals,
      exercise,
    );

    // ── Création de la vente tenue (si commande) ──────────────────────────────
    let factureId = null;
    const hasSales = Number(totals.passport || 0) > 0 || Number(totals.newMemberKit || 0) > 0 || (totals.tshirtQty > 0) || (totals.pantalonQty > 0);
    if (hasSales) {
      const contact = dossier.contact || {};
      const adresse = [contact.address1, contact.address2, contact.postalCode, contact.city]
      .filter(Boolean)
      .join(", ");
      factureId = await insertInscriptionSales(
        context.env.DB,
        registrationId,
        adherentId,
        registration.nom,
        registration.prenom,
        adresse,
        totals,
        exercise,
      );
    }

    await insertCotisationJournal(
      context.env.DB,
      adherentId,
      registration.nom,
      registration.prenom,
      totals,
      exercise,
      paidAt,
    );

    await insertPassRegionJournal(
      context.env.DB,
      adherentId,
      registration.nom,
      registration.prenom,
      totals,
      exercise,
      paidAt,
    );

    const paymentPiece = await upsertHelloAssoPaymentJournal(
      context.env.DB,
      registrationId,
      adherentId,
      registration.nom,
      registration.prenom,
      paidAmount,
      exercise,
      paidAt,
    );
    await upsertHelloAssoBankTransaction(
      context.env.DB,
      registrationId,
      registration.nom,
      registration.prenom,
      paidAmount,
      paidAt,
      paymentPiece,
    );

    if (factureId) {
      await insertVenteTenueJournal(
        context.env.DB,
        factureId,
        registration.nom,
        registration.prenom,
        totals,
        exercise,
        paidAt,
      );
    }

    // ── Mise à jour de l'inscription ──────────────────────────────────────────
    await updateRegistrationPayment(context.env.DB, registrationId, {
      status: paymentSnapshot.status,
      method: "helloasso",
      reference: paymentSnapshot.reference,
      payment: {
        method: "helloasso",
        helloAssoCheckoutIntentId: checkoutIntentId,
        helloAssoOrderId: order?.id || null,
        helloAssoOrder: order,
        helloAssoState: paymentSnapshot.fullyPaid ? "paid" : "scheduled",
        paidAt: paymentSnapshot.hasInitialPayment ? paidAt : null,
        installmentCount: paymentSnapshot.installmentCount,
        paidInstallments: paymentSnapshot.paidInstallments,
        remainingInstallments: paymentSnapshot.remainingInstallments,
        paidAmountCents: paymentSnapshot.paidAmountCents,
        remainingAmountCents: paymentSnapshot.remainingAmountCents,
      },
    });

    // Mettre à jour l'adherent_id et la facture_tenue_id dans l'inscription
    await context.env.DB.prepare(
      `UPDATE inscriptions_publiques
      SET adherent_id = ?, updated_at = ?
      WHERE id = ?`,
    )
    .bind(adherentId, new Date().toISOString(), registrationId)
    .run();

    // ── Email de confirmation ─────────────────────────────────────────────────
    const storedPdf = await storeRegistrationPdf(
      context.env, registration, dossier, adherentId
    );
    if (storedPdf) {
      const pdfUrl = `/api/storage/fullfighting-pdf/${storedPdf.key}`;
      await context.env.DB.prepare(
        `UPDATE adherents
        SET pdf_storage_path = ?,
        pdf_public_url   = ?,
        pdf_nom_fichier  = ?,
        pdf_uploaded_at  = ?,
        updated_at       = ?
        WHERE id = ?`
      ).bind(
        storedPdf.key,
        pdfUrl,
        storedPdf.fileName,
        new Date().toISOString(),
             new Date().toISOString(),
             adherentId
      ).run();
    }

    // ── Email de confirmation ─────────────────────────────────────────────────
    await sendPaymentConfirmedAlert(context.env, registration, dossier, adherentId);

    // ── Réponse ───────────────────────────────────────────────────────────────
    return json({
      data: {
        paid: true,
        fullyPaid: paymentSnapshot.fullyPaid,
        registrationId,
        adherentId,
        factureId,
        orderId: order?.id || null,
        installmentCount: paymentSnapshot.installmentCount,
        paidInstallments: paymentSnapshot.paidInstallments,
        remainingInstallments: paymentSnapshot.remainingInstallments,
      },
      error: null,
    });
  } catch (error) {
    return badPaymentRequest(error);
  }
}
