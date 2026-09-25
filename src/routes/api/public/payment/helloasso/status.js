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
import { generateAdherentPdfWithAttachments, fetchPhotoDocument } from "../../../../_lib/pdf.js";
import { generateCotisationReceiptPdf } from "../../../../_lib/cotisation-receipt.js";
import { isMinor, toBool, findActiveExercise, seasonLabelFromExercise, disciplineFromFormula } from "../../../../_lib/helpers.js";
import {
  buildAdditionalOrderSyncItems,
  buildClothingSyncItems,
  fetchBoutiqueClothingStock,
  syncBoutiqueStock,
} from "../../../../_lib/boutique-stock.js";

function getActiveExerciseDate(endDate) {
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return endDate;
  }
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-06-30`;
}

function toAmountCents(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
}

function toHelloAssoAmountCents(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number.isInteger(amount) ? amount : Math.round(amount * 100);
}

async function syncClothingStockIfNeeded(env, registrationId, dossier) {
  const payment = dossier?.payment || {};
  if (payment.clothingStockSyncedAt && payment.additionalOrderStockSyncedAt) {
    return { synced: true, alreadySynced: true };
  }
  const clothingOrder = dossier?.clothingOrder || {};
  const orderItems = Array.isArray(dossier?.computedTotals?.orderItems) ? dossier.computedTotals.orderItems : [];
  const hasClothing = Number(clothingOrder.tshirtQty || 0) > 0 || Number(clothingOrder.pantalonQty || 0) > 0;
  const hasAdditionalItems = orderItems.some((item) => Number(item?.quantity || 0) > 0 && String(item?.source || "") === "boutique");
  if (!hasClothing && !hasAdditionalItems) {
    return { synced: false, skipped: true };
  }
  const stock = hasClothing ? await fetchBoutiqueClothingStock(env) : { tshirt: null, pantalon: null };
  const items = [
    ...buildClothingSyncItems(stock, clothingOrder),
    ...buildAdditionalOrderSyncItems(orderItems),
  ];
  if (!items.length) {
    return { synced: false, skipped: true };
  }
  const result = await syncBoutiqueStock(env, `inscription:${registrationId}`, items);
  return { synced: true, result };
}

function buildPaymentSnapshot(order, dossier, checkoutIntentId) {
  const installmentCount = Math.max(1, Math.min(3, Number(dossier?.payment?.installmentCount || 1)));
  const totalAmountCents = toAmountCents(dossier?.computedTotals?.total || 0);
  const payments = Array.isArray(order?.payments) ? order.payments.filter(Boolean) : [];
  const paidAmountCents = payments.reduce((sum, payment) => sum + toHelloAssoAmountCents(payment?.amount), 0);
  const paidInstallments = Math.min(
    installmentCount,
    payments.filter((payment) => toHelloAssoAmountCents(payment?.amount) > 0).length,
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

async function findMatchingAdherent(db, payload) {
  const identity = payload?.identity || {};
  const contact = payload?.contact || {};
  const nom = String(identity.lastName || "").trim().toUpperCase();
  const prenom = String(identity.firstName || "").trim();
  const birthDate = String(identity.birthDate || "").trim();
  const email = String(contact.email || "").trim().toLowerCase();
  if (!nom || !prenom || !birthDate) return null;

  if (email) {
    const exactMatches = await db
    .prepare(
      `SELECT *
      FROM adherents
      WHERE nom = ? AND prenom = ? AND naissance = ? AND lower(email) = lower(?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    )
    .bind(nom, prenom, birthDate, email)
    .all();
    if (exactMatches?.results?.[0]) return exactMatches.results[0];
  }

  // Repli : si l'email a changé depuis la dernière inscription (cas réaliste
  // d'une saison à l'autre), nom + prénom + date de naissance restent une
  // signature suffisamment spécifique pour identifier la même personne.
  // On ne l'utilise QUE s'il existe exactement une fiche correspondante, pour
  // éviter de matcher la mauvaise personne en cas d'homonymie.
  const fallbackMatches = await db
  .prepare(
    `SELECT *
    FROM adherents
    WHERE nom = ? AND prenom = ? AND naissance = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 2`,
  )
  .bind(nom, prenom, birthDate)
  .all();
  const candidates = fallbackMatches?.results || [];
  return candidates.length === 1 ? candidates[0] : null;
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
    discipline: existing?.discipline || disciplineFromFormula(practice.formulaCode),
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

export function buildInscriptionSaleLines(totals) {
  const lignes = [];
  if (Number(totals.newMemberKit || 0) > 0) {
    lignes.push({
      desc: "Vente kit nouvel adhérent",
      qte: 1,
      pu: Number(totals.newMemberKit || 0),
    });
  }
  if (Number(totals.passport || 0) > 0) {
    lignes.push({
      desc: "Vente passeport sportif",
      qte: 1,
      pu: Number(totals.passport || 0),
    });
  }
  if (totals.tshirtQty > 0) {
    lignes.push({
      desc: "Vente t-shirt club AFFBC",
      qte: totals.tshirtQty,
      pu: totals.pricingTshirt,
    });
  }
  if (totals.pantalonQty > 0) {
    lignes.push({
      desc: "Vente pantalon club AFFBC",
      qte: totals.pantalonQty,
      pu: totals.pricingPantalon,
    });
  }
  for (const item of totals.orderItems || []) {
    if (Number(item.quantity || 0) <= 0) continue;
    const sizeSuffix = item.size ? ` (${item.size})` : "";
    lignes.push({
      desc: `Vente ${item.name}${sizeSuffix}`,
      qte: Number(item.quantity || 0),
      pu: Number(item.unitPrice || 0),
    });
  }
  const explicitExtraTotal = (totals.orderItems || [])
  .reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.unitPrice || 0)), 0);
  const fallbackExtraTotal = Number(totals.extraProductsTotal || 0) - explicitExtraTotal;
  if (fallbackExtraTotal > 0) {
    lignes.push({
      desc: "Vente produits additionnels",
      qte: 1,
      pu: fallbackExtraTotal,
    });
  }
  return lignes;
}

async function insertInscriptionSales(db, registrationId, adherentId, nom, prenom, adresse, totals, exercise) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const numero = await nextFactureNumero(db, exercise?.id);
  const lignes = buildInscriptionSaleLines(totals);

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

async function replaceJournalEntryGroup(db, pieceBase, entries) {
  await db
  .prepare(`DELETE FROM journal_comptable WHERE piece = ? OR piece LIKE ?`)
  .bind(pieceBase, `${pieceBase}-%`)
  .run();
  await insertJournalEntryPair(db, entries);
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

async function insertCotisationJournal(db, adherentId, nom, prenom, totals, exercise, paidAt) {
  if (!Number(totals.cotisation || 0)) return null;
  const now = new Date().toISOString();
  const dateOp = String(paidAt || now).slice(0, 10);
  const piece = `ADH-${String(adherentId).slice(0, 8)}`;
  const labelName = `${nom} ${prenom}`.trim();
  const common = {
    date_op: dateOp,
    source_type: "adherent",
    source_id: adherentId,
    source_logiciel: "inscription-web",
    exercice_id: exercise?.id || null,
    created_at: now,
    updated_at: now,
  };

  await replaceJournalEntryGroup(db, piece, [
    {
      id: crypto.randomUUID(),
                               ...common,
                               piece: `${piece}-CLI`,
                               compte: "411 - Adhérents et clients",
                               libelle: `Adhésion ${labelName}`,
                               debit: Number(totals.cotisation || 0),
                               credit: 0,
    },
    {
      id: crypto.randomUUID(),
                               ...common,
                               piece: `${piece}-COT`,
                               compte: "7561 - Cotisations membres actifs",
                               libelle: `Cotisation ${labelName}`,
                               debit: 0,
                               credit: Number(totals.cotisation || 0),
    },
  ]);

  return piece;
}

export function buildVenteTenueJournalCreditLines(totals, common, libelleBase) {
  const entries = [];
  const newMemberKitTotal = Number(totals.newMemberKit || 0);
  const passportTotal = Number(totals.passport || 0);
  const tshirtTotal = Number(totals.tshirtQty || 0) * Number(totals.pricingTshirt || 0);
  const pantalonTotal = Number(totals.pantalonQty || 0) * Number(totals.pricingPantalon || 0);
  const explicitExtraTotal = (totals.orderItems || [])
  .reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.unitPrice || 0)), 0);
  const extraProductsTotal = Math.max(Number(totals.extraProductsTotal || 0), explicitExtraTotal);
  const equipmentTotal = newMemberKitTotal + tshirtTotal + pantalonTotal + extraProductsTotal;

  if (equipmentTotal > 0) {
    entries.push({
      id: crypto.randomUUID(),
      ...common,
      piece: `${common.pieceBase}-ART`,
      compte: "707 - Ventes vêtements et équipements",
      libelle: `${libelleBase} - Vente articles club`,
      debit: 0,
      credit: equipmentTotal,
    });
  }
  if (passportTotal > 0) {
    entries.push({
      id: crypto.randomUUID(),
      ...common,
      piece: `${common.pieceBase}-PAS`,
      compte: "7562 - Cotisations licences et adhésions annexes",
      libelle: `${libelleBase} - Vente passeport sportif`,
      debit: 0,
      credit: passportTotal,
    });
  }

  return entries.map(({ pieceBase, ...entry }) => entry);
}

async function insertVenteTenueJournal(db, factureId, nom, prenom, totals, exercise, paidAt) {
  const newMemberKitTotal = Number(totals.newMemberKit || 0);
  const passportTotal = Number(totals.passport || 0);
  const tshirtTotal = Number(totals.tshirtQty || 0) * Number(totals.pricingTshirt || 0);
  const pantalonTotal = Number(totals.pantalonQty || 0) * Number(totals.pricingPantalon || 0);
  const extraProductsTotal = (totals.orderItems || [])
  .reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.unitPrice || 0)), 0);
  const effectiveExtraProductsTotal = Math.max(Number(totals.extraProductsTotal || 0), extraProductsTotal);
  const totalSales = tshirtTotal + pantalonTotal + newMemberKitTotal + passportTotal + effectiveExtraProductsTotal;
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
    pieceBase: piece,
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
      piece: `${piece}-CLI`,
      compte: "411 - Adhérents et clients",
      libelle: `${libelleBase} - Vente inscription`,
      debit: totalSales,
      credit: 0,
    },
    ...buildVenteTenueJournalCreditLines(totals, common, libelleBase),
  ];

  await replaceJournalEntryGroup(db, piece, entries.map(({ pieceBase, ...entry }) => entry));

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
    source_type: "adherent",
    source_id: adherentId,
    source_logiciel: "inscription-web",
    exercice_id: exercise?.id || null,
    created_at: now,
    updated_at: now,
  };

  await replaceJournalEntryGroup(db, piece, [
    {
      id: crypto.randomUUID(),
                               ...common,
                               piece: `${piece}-ATT`,
                               compte: "471 - Comptes d attente",
                               libelle: `Pass Région ${labelName}`,
                               debit: amount,
                               credit: 0,
    },
    {
      id: crypto.randomUUID(),
                               ...common,
                               piece: `${piece}-SUB`,
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

function buildRegistrationPayload(registration, dossier, adherentId, exercise) {
  const totals = dossier.computedTotals || {};
  const pay    = dossier.payment        || {};
  return {
    id:            registration.id,
    submittedAt:   new Date().toISOString().slice(0, 10),
    seasonLabel:   seasonLabelFromExercise(exercise),
    identity:      dossier.identity             || {},
    contact:       dossier.contact              || {},
    emergency:     dossier.emergency            || {},
    practice:      dossier.practice             || {},
    health:        dossier.health               || {},
    clothingOrder: dossier.clothingOrder        || {},
    consents:      dossier.consents             || {},
    legalRepresentative: dossier.legalRepresentative || {},
    documentsJson: registration.documents_json,
    payment:       pay,
    computedTotals: {
      ...totals,
      formulaLabel:     totals.formulaLabel    || dossier.practice?.formulaCode || "",
      cotisation:       Number(totals.cotisation    || 0),
      clothingTotal:    Number(totals.clothingTotal || 0),
      newMemberKit:     Number(totals.newMemberKit  || 0),
      passport:         Number(totals.passport      || 0),
      extraProductsTotal: Number(totals.extraProductsTotal || 0),
      passRegionAmount: Number(totals.passRegionAmount || 0),
      total:            Number(registration.montant_total || totals.total || 0),
      pricingTshirt:    Number(totals.pricingTshirt   || 25),
      pricingPantalon:  Number(totals.pricingPantalon || 15),
      certificateRequired: Boolean(totals.certificateRequired),
      orderItems: Array.isArray(totals.orderItems) ? totals.orderItems : [],
    },
  };
}

// ─── Reçu de cotisation joint à l'e-mail de confirmation ─────────────────────
//
// Même document que le bouton « Reçu » de l'onglet Adhérents de gestion (mêmes lignes, même
// total, même numéro REC-<saison>-<id adhérent>) : on lit donc la MÊME fiche `adherents` que
// gestion, tout juste créée/mise à jour, plutôt que de recomposer les montants ici.
//
// Retourne null quand il n'y a rien à recevoir (total nul), lève en cas d'anomalie — l'appelant
// traite l'échec comme non bloquant, comme pour le PDF récapitulatif.
async function generateConfirmationReceipt(env, registration, dossier, adherentId, exercise, paymentSnapshot) {
  const adherent = await env.DB.prepare(`SELECT * FROM adherents WHERE id = ? LIMIT 1`).bind(adherentId).first();
  if (!adherent) throw new Error(`fiche adhérent introuvable (${adherentId})`);

  const registrationRow = {
    id: registration.id,
    // Le paiement vient d'être confirmé : le statut lu au début de la requête peut encore être
    // « traitement_paiement » (verrou anti-concurrence), qui exclurait l'inscription du reçu.
    statut: paymentSnapshot?.status || "payee",
    submitted_at: registration.submitted_at,
    created_at: registration.created_at,
    updated_at: registration.updated_at,
    // Saison de l'inscription = celle de son exercice (même source que date_fin_adhesion).
    exercice_date_fin: exercise?.date_fin || null,
    dossier_json: dossier,
  };
  // Le dossier lu au début de la requête n'a pas encore les montants réglés : on fournit l'état
  // du paiement calculé à l'instant (comptant, ou 1re échéance d'un paiement en 2 ou 3 fois).
  const payment = paymentSnapshot
    ? {
      installmentCount: paymentSnapshot.installmentCount,
      paidAmountCents: paymentSnapshot.paidAmountCents,
      remainingAmountCents: paymentSnapshot.remainingAmountCents,
    }
    : undefined;

  return generateCotisationReceiptPdf(adherent, [registrationRow], env, { payment });
}

// ─── Email de confirmation de paiement ───────────────────────────────────────

export async function sendPaymentConfirmedAlert(env, registration, dossier, adherentId, exercise, paymentSnapshot = null) {
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

  // Bug du 15/09/2026 : cette étape (génération du PDF pour la pièce
  // jointe) n'était protégée par aucun try/catch, contrairement à
  // storeRegistrationPdf juste en dessous. Une erreur de génération PDF
  // (image corrompue, document joint illisible, etc.) remontait donc
  // jusqu'au handler appelant et faisait échouer TOUTE la réponse HTTP —
  // alors que la fiche adhérent et les écritures comptables avaient déjà
  // été créées avec succès juste avant. Pire : une fois adherent_id posé,
  // le rappel suivant (webhook, bouton "Vérifier à nouveau") passe par la
  // branche "déjà traité" plus haut, qui ne relance jamais cette fonction —
  // le dossier restait donc bloqué indéfiniment sans PDF ni email, sans
  // jamais se rattraper tout seul (cas observé : RUCHE Stéphanie, fiche et
  // comptabilité bien créées, aucun PDF/email).
  //
  // Correctif : on tente la génération du PDF, mais un échec n'empêche plus
  // l'email de partir (avec un message adapté, sans pièce jointe) ni la
  // réponse HTTP de refléter le succès du paiement — cohérent avec
  // storeRegistrationPdf qui traite déjà cet échec comme non bloquant.
  let pdfContent = null;
  let fileName = `inscription-affbc-${String(registration.id || "").slice(0, 8)}.pdf`;
  try {
    const payload  = buildRegistrationPayload(registration, dossier, adherentId, exercise);
    const photo    = await fetchPhotoDocument(env, registration.documents_json);
    const pdfBytes = await generateAdherentPdfWithAttachments(payload, photo, env);
    pdfContent = uint8ToBase64(pdfBytes);
  } catch (error) {
    console.error("[sendPaymentConfirmedAlert] Génération PDF impossible, envoi de l'email sans pièce jointe:", error?.message ?? String(error));
  }

  // ── Reçu de cotisation : pièce jointe SÉPARÉE du récapitulatif ────────────
  // Le récapitulatif contient le questionnaire de santé, les consentements et les pièces déposées
  // (certificat médical, photo d'identité) fusionnées dans le PDF : un adhérent ne peut pas le
  // transmettre tel quel à un employeur, un comité d'entreprise ou une mutuelle. Le reçu (mêmes
  // lignes, même total et même numéro que le bouton « Reçu » de gestion) part dans le MÊME e-mail,
  // en fichier distinct.
  // Comme pour le récapitulatif, un échec de génération n'empêche jamais l'e-mail de partir.
  // `receipt` reste null quand il n'y a rien à recevoir (inscription gratuite : total nul) ;
  // dans ce cas, aucun message d'erreur n'est affiché.
  let receipt = null;
  let receiptFailed = false;
  try {
    receipt = await generateConfirmationReceipt(env, registration, dossier, adherentId, exercise, paymentSnapshot);
  } catch (error) {
    receiptFailed = true;
    console.error("[sendPaymentConfirmedAlert] Génération du reçu impossible, envoi de l'email sans reçu:", error?.message ?? String(error));
  }
  const receiptContent = receipt ? uint8ToBase64(receipt.bytes) : null;

  const recapNote = pdfContent
    ? "<p><strong>Pièce jointe :</strong> le dossier PDF récapitulatif est joint à cet email.</p>"
    : "<p style=\"color:#a23521\"><strong>⚠️ Le PDF récapitulatif n'a pas pu être généré automatiquement.</strong> Il peut être régénéré manuellement depuis la fiche adhérent dans le logiciel de gestion.</p>";

  // Le message est construit par une fonction pour pouvoir être refait SANS le reçu si Brevo
  // refusait l'envoi : le reçu ne doit jamais rendre l'e-mail de confirmation moins fiable.
  const buildMessage = (withReceipt) => {
    const attachment = [];
    if (pdfContent) attachment.push({ name: fileName, content: pdfContent });
    if (withReceipt && receipt) attachment.push({ name: receipt.filename, content: receiptContent });

    const receiptMissing = receiptFailed || (receipt && !withReceipt);
    const receiptNote = withReceipt && receipt
      ? `<p><strong>Reçu de cotisation :</strong> joint à cet email dans un fichier séparé (n° ${receipt.numero}). Il ne contient pas les informations de santé du dossier : c'est le document à utiliser pour justifier le paiement.</p>`
      : receiptMissing
        ? "<p style=\"color:#a23521\"><strong>⚠️ Le reçu de cotisation n'a pas pu être joint automatiquement.</strong> Il peut être édité depuis la fiche adhérent dans le logiciel de gestion (bouton « Reçu »).</p>"
        : "";
    const receiptTextLine = withReceipt && receipt
      ? `Reçu joint : ${receipt.filename} (n° ${receipt.numero})`
      : receiptMissing
        ? "Reçu non joint automatiquement — à éditer depuis la fiche adhérent (bouton Reçu)."
        : null;

    return {
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
      ${recapNote}${receiptNote}
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
                         pdfContent ? `PDF joint : ${fileName}` : "PDF non généré automatiquement — à régénérer depuis la fiche adhérent.",
                         receiptTextLine,
      ].filter(Boolean).join("\n"),
                         ...(attachment.length ? { attachment } : {}),
    };
  };

  const postToBrevo = (message) => fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY,
    },
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify(message),
  });

  try {
    let response = await postToBrevo(buildMessage(Boolean(receipt)));
    // Refus explicite de Brevo (4xx) alors que le reçu était joint : on renvoie l'e-mail sans lui,
    // avec la mention correspondante. Pas de nouvel essai sur une erreur réseau ou 5xx : l'e-mail
    // a pu partir, un second envoi le doublerait.
    if (!response.ok && receipt && response.status >= 400 && response.status < 500) {
      console.error(`[Brevo] Envoi refusé (HTTP ${response.status}) avec le reçu joint, nouvel essai sans le reçu :`, await response.text().catch(() => ""));
      response = await postToBrevo(buildMessage(false));
    }
    if (!response.ok) {
      console.error(`[Brevo] Echec envoi email confirmation : HTTP ${response.status}`, await response.text().catch(() => ""));
    }
  } catch (err) {
    console.error("[Brevo] Echec envoi email confirmation:", err?.message ?? String(err));
  }
}

async function storeRegistrationPdf(env, registration, dossier, adherentId, exercise) {
  try {
    const payload  = buildRegistrationPayload(registration, dossier, adherentId, exercise);
    const photo    = await fetchPhotoDocument(env, registration.documents_json);
    const pdfBytes = await generateAdherentPdfWithAttachments(payload, photo, env);      // Uint8Array directement
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

  let registrationId = null;
  try {
    const url = new URL(context.request.url);
    registrationId = String(url.searchParams.get("registrationId") || "").trim();
    if (!registrationId) {
      return badRequest("registrationId obligatoire");
    }

    // ── Lecture de l'inscription en base ─────────────────────────────────────
    const registration = await getRegistration(context.env.DB, registrationId);
    const dossier = parseDossierJson(registration);
    const totals = dossier.computedTotals || {};

    // ── Vérification de l'état HelloAsso ─────────────────────────────────────
    let checkoutIntentId =
    normalizeCheckoutIntentId(
      registration.helloasso_checkout_intent_id ||
      dossier.payment?.helloAssoCheckoutIntentId,
    );

    if (!checkoutIntentId) {
      return badRequest("Checkout HelloAsso introuvable pour cette inscription");
    }

    const organizationSlug = context.env.HELLOASSO_ORGANIZATION_SLUG;
    const fetchCheckoutIntent = (intentId) => helloAssoRequest(
      context.env,
      `/organizations/${encodeURIComponent(organizationSlug)}/checkout-intents/${encodeURIComponent(intentId)}`,
      "GET",
    );

    let intent = await fetchCheckoutIntent(checkoutIntentId);
    let order = intent.order || null;
    let paymentSnapshot = buildPaymentSnapshot(order, dossier, checkoutIntentId);

    // ── Tentatives de paiement précédentes ───────────────────────────────────
    // Quand l'adhérent reprend son paiement (POST .../helloasso/resume), un
    // NOUVEAU checkout est créé et l'ancien identifiant est conservé dans
    // `payment.previousCheckoutIntentIds`. Si le paiement a en réalité abouti
    // sur un ancien lien (onglet resté ouvert, lien de l'e-mail…), il faut le
    // retrouver ici : sinon l'adhérent serait débité sans que son dossier soit
    // jamais finalisé.
    if (!paymentSnapshot.hasInitialPayment) {
      const previousIds = Array.isArray(dossier.payment?.previousCheckoutIntentIds)
        ? dossier.payment.previousCheckoutIntentIds.map(normalizeCheckoutIntentId).filter(Boolean)
        : [];
      for (const previousId of previousIds) {
        if (previousId === checkoutIntentId) continue;
        try {
          const previousIntent = await fetchCheckoutIntent(previousId);
          const previousOrder = previousIntent?.order || null;
          const previousSnapshot = buildPaymentSnapshot(previousOrder, dossier, previousId);
          if (previousSnapshot.hasInitialPayment) {
            intent = previousIntent;
            order = previousOrder;
            paymentSnapshot = previousSnapshot;
            checkoutIntentId = previousId;
            break;
          }
        } catch (previousError) {
          console.warn("[helloasso/status] checkout précédent illisible :", previousId, previousError?.message || previousError);
        }
      }
    }

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
          // Statut du dossier (ex. "paiement_en_attente", "abandonnee") : permet
          // au navigateur de savoir si le paiement peut encore être repris.
          registrationStatus: registration.statut || null,
          adherentId: null,
          installmentCount: paymentSnapshot.installmentCount,
          paidInstallments: paymentSnapshot.paidInstallments,
          remainingInstallments: paymentSnapshot.remainingInstallments,
        },
        error: null,
      });
    }

    // ── Verrou anti-concurrence ───────────────────────────────────────────────
    // Ce handler peut être appelé en parallèle par trois canaux différents :
    // le webhook HelloAsso, le retour automatique du navigateur, et le bouton
    // "Vérifier à nouveau" côté client. Sans verrou, deux exécutions concurrentes
    // pourraient toutes les deux lire adherent_id à null et créer chacune une
    // fiche adhérent / facture / écritures comptables en double.
    // On pose le verrou ATOMIQUEMENT le plus tôt possible (avant tout effet de
    // bord) via un UPDATE conditionnel : seule la requête qui réussit à faire
    // passer le statut de son état courant à "traitement_paiement" continue.
    if (!registration.adherent_id) {
      const lockResult = await context.env.DB.prepare(
        `UPDATE inscriptions_publiques
        SET statut = 'traitement_paiement', updated_at = ?
        WHERE id = ? AND adherent_id IS NULL AND statut != 'traitement_paiement'`,
      ).bind(new Date().toISOString(), registrationId).run();

      const lockAcquired = (lockResult?.meta?.rows_written ?? 0) > 0;
      if (!lockAcquired) {
        // Une autre requête traite déjà ce paiement (ou vient de terminer) :
        // on relit l'état actuel plutôt que de retraiter en double.
        const refreshed = await getRegistration(context.env.DB, registrationId);
        if (refreshed.adherent_id) {
          return json({
            data: {
              paid: true,
              fullyPaid: paymentSnapshot.fullyPaid,
              alreadyProcessed: true,
              registrationId,
              adherentId: refreshed.adherent_id,
              installmentCount: paymentSnapshot.installmentCount,
              paidInstallments: paymentSnapshot.paidInstallments,
              remainingInstallments: paymentSnapshot.remainingInstallments,
            },
            error: null,
          });
        }
        return json({
          data: {
            paid: true,
            fullyPaid: paymentSnapshot.fullyPaid,
            processing: true,
            registrationId,
            adherentId: null,
            installmentCount: paymentSnapshot.installmentCount,
            paidInstallments: paymentSnapshot.paidInstallments,
            remainingInstallments: paymentSnapshot.remainingInstallments,
          },
          error: null,
        });
      }
    }

    if (registration.adherent_id) {
      const stockSync = await syncClothingStockIfNeeded(context.env, registrationId, dossier);
      const exercise =
      (registration.exercice_id
      ? await context.env.DB.prepare(`SELECT * FROM exercices WHERE id = ? LIMIT 1`).bind(registration.exercice_id).first()
      : null) || await findActiveExercise(context.env.DB);
      await upsertHelloAssoPaymentJournal(
        context.env.DB,
        registrationId,
        registration.adherent_id,
        registration.nom,
        registration.prenom,
        paidAmount,
        exercise,
        paidAt,
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
          clothingStockSyncedAt: stockSync.synced ? new Date().toISOString() : (dossier?.payment?.clothingStockSyncedAt || null),
          additionalOrderStockSyncedAt: stockSync.synced ? new Date().toISOString() : (dossier?.payment?.additionalOrderStockSyncedAt || null),
          paidAt: paymentSnapshot.hasInitialPayment ? paidAt : null,
          installmentCount: paymentSnapshot.installmentCount,
          paidInstallments: paymentSnapshot.paidInstallments,
          remainingInstallments: paymentSnapshot.remainingInstallments,
          paidAmountCents: paymentSnapshot.paidAmountCents,
          remainingAmountCents: paymentSnapshot.remainingAmountCents,
        },
      });

      // Rattrapage du 15/09/2026 : avant le correctif de
      // sendPaymentConfirmedAlert ci-dessus, une inscription pouvait rester
      // bloquée avec adherent_id posé mais sans PDF ni email (cf. RUCHE
      // Stéphanie — fiche + comptabilité créées, PDF jamais généré). Cette
      // branche "déjà traité" ne relançait jamais ces deux étapes. On
      // vérifie donc ici si le PDF manque encore sur la fiche et, si oui,
      // on le (re)génère et on renvoie l'email — de façon à ce qu'un simple
      // nouvel appel de ce endpoint (bouton "Vérifier à nouveau", ou retry
      // webhook) suffise à rattraper un dossier resté incomplet, sans
      // intervention manuelle en base.
      const adherentRow = await context.env.DB
        .prepare(`SELECT pdf_inscription_storage_path FROM adherents WHERE id = ? LIMIT 1`)
        .bind(registration.adherent_id)
        .first();
      if (adherentRow && !adherentRow.pdf_inscription_storage_path) {
        const storedPdf = await storeRegistrationPdf(
          context.env, registration, dossier, registration.adherent_id, exercise
        );
        if (storedPdf) {
          const pdfUrl = `/api/storage/fullfighting-pdf/${storedPdf.key}`;
          await context.env.DB.prepare(
            `UPDATE adherents
            SET pdf_inscription_storage_path = ?,
            pdf_inscription_public_url   = ?,
            pdf_inscription_nom_fichier  = ?,
            pdf_inscription_uploaded_at  = ?,
            updated_at       = ?
            WHERE id = ?`
          ).bind(
            storedPdf.key,
            pdfUrl,
            storedPdf.fileName,
            new Date().toISOString(),
                 new Date().toISOString(),
                 registration.adherent_id
          ).run();
        }
        await sendPaymentConfirmedAlert(context.env, registration, dossier, registration.adherent_id, exercise, paymentSnapshot);
      }

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
    const hasSales =
      Number(totals.passport || 0) > 0 ||
      Number(totals.newMemberKit || 0) > 0 ||
      Number(totals.extraProductsTotal || 0) > 0 ||
      (totals.tshirtQty > 0) ||
      (totals.pantalonQty > 0);
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

    const stockSync = await syncClothingStockIfNeeded(context.env, registrationId, dossier);

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

    await upsertHelloAssoPaymentJournal(
      context.env.DB,
      registrationId,
      adherentId,
      registration.nom,
      registration.prenom,
      paidAmount,
      exercise,
      paidAt,
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
        clothingStockSyncedAt: stockSync.synced ? new Date().toISOString() : null,
        additionalOrderStockSyncedAt: stockSync.synced ? new Date().toISOString() : null,
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
      context.env, registration, dossier, adherentId, exercise
    );
    if (storedPdf) {
      const pdfUrl = `/api/storage/fullfighting-pdf/${storedPdf.key}`;
      await context.env.DB.prepare(
        `UPDATE adherents
        SET pdf_inscription_storage_path = ?,
        pdf_inscription_public_url   = ?,
        pdf_inscription_nom_fichier  = ?,
        pdf_inscription_uploaded_at  = ?,
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
    await sendPaymentConfirmedAlert(context.env, registration, dossier, adherentId, exercise, paymentSnapshot);

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
    // Si le verrou "traitement_paiement" a été posé mais que le traitement a
    // échoué avant la fin (erreur HelloAsso transitoire, timeout, etc.), on le
    // libère pour permettre une nouvelle tentative au lieu de bloquer le
    // dossier indéfiniment dans cet état intermédiaire.
    if (registrationId) {
      await context.env.DB.prepare(
        `UPDATE inscriptions_publiques
        SET statut = 'paiement_en_attente', updated_at = ?
        WHERE id = ? AND adherent_id IS NULL AND statut = 'traitement_paiement'`,
      ).bind(new Date().toISOString(), registrationId).run().catch(() => {});
    }
    return badPaymentRequest(error);
  }
}
