/**
 * AFFBC — Worker Cloudflare Pages : vérification du statut de paiement HelloAsso
 *
 * Chemin dans le repo : functions/inscription/helloasso/status.js
 *   (même dossier que create-intent.js)
 *
 * GET /inscription/helloasso/status?registrationId=xxx
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toBool(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function isMinor(birthDate) {
  const now = new Date();
  const birth = new Date(`${birthDate}T00:00:00`);
  const age =
    now.getFullYear() -
    birth.getFullYear() -
    (now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())
      ? 1
      : 0);
  return age < 18;
}

function getActiveExerciseDate(endDate) {
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return endDate;
  }
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-07-31`;
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

// ─── Création de la fiche adhérent ───────────────────────────────────────────

async function insertAdherent(db, payload, totals, exercise) {
  const now = new Date().toISOString();
  const adherentId = crypto.randomUUID();

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
    discipline: "Club",
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
    created_at: now,
    updated_at: now,
    couleur_ceinture: "",
    numero_licence: "",
  };

  const columns = Object.keys(row);
  await db
    .prepare(
      `INSERT INTO adherents (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`,
    )
    .bind(...columns.map((c) => row[c]))
    .run();

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
  // Compte les factures existantes pour générer un numéro séquentiel
  const year = new Date().getFullYear();
  const result = await db
    .prepare(`SELECT COUNT(*) as cnt FROM factures WHERE exercice_id = ?`)
    .bind(exercice_id)
    .first();
  const n = (result?.cnt || 0) + 1;
  return `VTE-${year}-${String(n).padStart(3, "0")}`;
}

async function insertInscriptionSales(db, adherentId, nom, prenom, adresse, totals, exercise) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const numero = await nextFactureNumero(db, exercise?.id);

  const lignes = [];
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
    notes: `Vente générée automatiquement lors de l'inscription web. Paiement HelloAsso validé. Adhérent ID : ${adherentId}`,
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
  const passportTotal = Number(totals.passport || 0);
  const totalSales = clothingTotal + passportTotal;
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
  if (clothingTotal > 0) {
    entries.push({
      id: crypto.randomUUID(),
      ...common,
      compte: "707 - Ventes vêtements et équipements",
      libelle: `${libelleBase} - Vente de Tenue`,
      debit: 0,
      credit: clothingTotal,
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

// ─── Email de confirmation de paiement ───────────────────────────────────────

async function sendPaymentConfirmedAlert(env, registration, dossier, adherentId) {
  if (!env.BREVO_API_KEY) return;
  const to = env.SIGNUP_ALERT_TO || "fullfightingbons@gmail.com";
  const from = env.SIGNUP_ALERT_FROM || "inscription@americanfullfightingbons.fr";
  const nom = registration.nom || "";
  const prenom = registration.prenom || "";

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
      to: [{ email: to, name: env.SIGNUP_ALERT_TO_NAME || "AFFBC" }],
      subject: `✅ Paiement confirmé — ${nom} ${prenom}`,
      htmlContent: `
        <html><body style="font-family:Arial,sans-serif">
          <h2 style="color:#1f6b47">✅ Paiement HelloAsso confirmé</h2>
          <p><strong>Adhérent :</strong> ${prenom} ${nom}</p>
          <p><strong>Email :</strong> ${registration.email || ""}</p>
          <p><strong>Montant :</strong> ${Number(registration.montant_total || 0).toFixed(2)} €</p>
          <p><strong>Référence inscription :</strong> ${registration.id}</p>
          <p><strong>Fiche adhérent créée (ID) :</strong> ${adherentId}</p>
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
      ].join("\n"),
    }),
  }).catch(() => {}); // non bloquant
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

    // ── Si déjà traitée, retourner directement ────────────────────────────────
    if (registration.statut === "payee" && registration.adherent_id) {
      return json({
        data: {
          paid: true,
          alreadyProcessed: true,
          registrationId,
          adherentId: registration.adherent_id,
        },
        error: null,
      });
    }

    // ── Vérification de l'état HelloAsso ─────────────────────────────────────
    const checkoutIntentId =
      registration.helloasso_checkout_intent_id ||
      dossier.payment?.helloAssoCheckoutIntentId;

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
    const paid = Boolean(order?.id);
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
          registrationId,
          adherentId: null,
        },
        error: null,
      });
    }

    // ── Paiement confirmé : création de la fiche adhérent ────────────────────
    const exercise = await findActiveExercise(context.env.DB);
    const adherentId = await insertAdherent(
      context.env.DB,
      dossier,
      totals,
      exercise,
    );

    // ── Création de la vente tenue (si commande) ──────────────────────────────
    let factureId = null;
    const hasSales = Number(totals.passport || 0) > 0 || (totals.tshirtQty > 0) || (totals.pantalonQty > 0);
    if (hasSales) {
      const contact = dossier.contact || {};
      const adresse = [contact.address1, contact.address2, contact.postalCode, contact.city]
        .filter(Boolean)
        .join(", ");
      factureId = await insertInscriptionSales(
        context.env.DB,
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
      status: "payee",
      method: "helloasso",
      reference: String(order?.payments?.[0]?.cashOutState || order.id || checkoutIntentId),
      payment: {
        method: "helloasso",
        helloAssoCheckoutIntentId: checkoutIntentId,
        helloAssoOrderId: order.id || null,
        helloAssoOrder: order,
        helloAssoState: "paid",
        paidAt: new Date().toISOString(),
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
    await sendPaymentConfirmedAlert(context.env, registration, dossier, adherentId);

    // ── Réponse ───────────────────────────────────────────────────────────────
    return json({
      data: {
        paid: true,
        registrationId,
        adherentId,
        factureId,
        orderId: order?.id || null,
      },
      error: null,
    });
  } catch (error) {
    return badPaymentRequest(error);
  }
}
