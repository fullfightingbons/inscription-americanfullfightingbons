/**
 * AFFBC — Finalisation directe d'une inscription au montant nul (0,00 €).
 *
 * Cas d'usage unique aujourd'hui : renouvellement "Membres du Bureau"
 * (tarif gratuit). Pour ce cas, il n'y a jamais de paiement HelloAsso —
 * impossible de créer un checkout pour 0 € — donc on ne passe pas par le
 * flux src/routes/api/public/payment/helloasso/status.js (qui suppose
 * l'existence d'un checkout HelloAsso). On crée la fiche adhérent et on
 * valide le dossier immédiatement, comme si le paiement venait d'être
 * confirmé.
 *
 * Ce module est volontairement indépendant de status.js : il ne réutilise
 * pas son code (qui reste inchangé), pour ne prendre aucun risque sur le
 * flux de paiement HelloAsso existant qui fonctionne déjà en production.
 *
 * Note comptable : une cotisation à 0 € ne donne lieu à AUCUNE écriture
 * dans `journal_comptable` (un débit de 0 € et un crédit de 0 € n'ont pas
 * de sens en comptabilité en partie double — ce serait une écriture vide).
 * La traçabilité du dossier gratuit est assurée par la fiche `adherents`
 * elle-même (colonnes `cotisation = 0`, `paiement = "Gratuit"`) et par le
 * log d'audit, pas par une fausse écriture comptable.
 */

import { isMinor, findActiveExercise, seasonLabelFromExercise } from "./helpers.js";
import { generateAdherentPdf, fetchPhotoDocument } from "./pdf.js";
import {
  buildAdditionalOrderSyncItems,
  buildClothingSyncItems,
  fetchBoutiqueClothingStock,
  syncBoutiqueStock,
} from "./boutique-stock.js";

function getActiveExerciseDate(endDate) {
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return endDate;
  }
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-07-31`;
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

async function upsertFreeAdherent(db, payload, totals, exercise) {
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
    "Inscription web publique — tarif Membres du Bureau (gratuit, sans paiement HelloAsso)",
    `Pratique : ${practice.practiceType}`,
    `Formule : ${practice.formulaCode}`,
    `Montant total dossier : ${totals.total.toFixed(2)} €`,
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
    discipline: existing?.discipline || "Membre du Bureau",
    droit_image: payload.consents?.imageRights === "yes" ? 1 : 0,
    certificat: totals.certificateRequired ? 0 : 1,
    pass_region: 0,
    montant_pass_region: 0,
    reglement: 1,
    cotisation: totals.cotisation,
    paiement: "Gratuit",
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
    const assignments = columns.filter((c) => c !== "id").map((c) => `"${c}" = ?`).join(", ");
    await db
      .prepare(`UPDATE adherents SET ${assignments} WHERE id = ?`)
      .bind(...columns.filter((c) => c !== "id").map((c) => row[c]), adherentId)
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

async function nextFactureNumero(db, exercice_id) {
  const year = new Date().getFullYear();
  const result = await db.prepare(`SELECT COUNT(*) as cnt FROM factures WHERE exercice_id = ?`).bind(exercice_id).first();
  const n = (result?.cnt || 0) + 1;
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `VTE-${year}-${String(n).padStart(3, "0")}-${ts}`;
}

// Articles annexes éventuellement commandés en même temps qu'un renouvellement
// Bureau gratuit (ex : un t-shirt club). La cotisation est gratuite mais ces
// articles restent facturables — d'où une éventuelle "vente" même sur un
// dossier au total HelloAsso nul... non : si des articles sont commandés, le
// total ne sera PAS nul (clothingTotal/extraProductsTotal > 0), et ce dossier
// repassera alors par le flux de paiement HelloAsso normal. Cette fonction ne
// sert donc que dans le cas, en pratique très rare, où totals.total === 0 ET
// qu'il existe malgré tout des lignes à 0 € à tracer dans `factures` — elle
// est conservée pour cohérence mais ne créera de facture que si totalSales > 0.
async function insertFreeSalesIfAny(db, registrationId, adherentId, nom, prenom, adresse, totals, clothingOrder, exercise) {
  const clothingTotal = Number(totals.clothingTotal || 0);
  const newMemberKitTotal = Number(totals.newMemberKit || 0);
  const passportTotal = Number(totals.passport || 0);
  const extraProductsTotal = Number(totals.extraProductsTotal || 0);
  const totalSales = clothingTotal + newMemberKitTotal + passportTotal + extraProductsTotal;
  if (!totalSales) return null;

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const numero = await nextFactureNumero(db, exercise?.id);
  const lignes = [];
  if (totals.tshirtQty > 0) lignes.push({ desc: `T-shirt club AFFBC (${clothingOrder?.tshirtSize || "-"})`, qte: totals.tshirtQty, pu: totals.pricingTshirt || 25 });
  if (totals.pantalonQty > 0) lignes.push({ desc: `Pantalon club AFFBC (${clothingOrder?.pantalonSize || "-"})`, qte: totals.pantalonQty, pu: totals.pricingPantalon || 15 });
  if (passportTotal > 0) lignes.push({ desc: "Passeport sportif", qte: 1, pu: passportTotal });
  for (const item of totals.orderItems || []) {
    if (Number(item.quantity || 0) > 0) lignes.push({ desc: item.name, qte: item.quantity, pu: item.unitPrice });
  }

  const row = {
    id,
    numero,
    date_op: now.slice(0, 10),
    destinataire: `${nom} ${prenom}`.trim(),
    adresse,
    objet: "Vente articles — renouvellement Membre du Bureau",
    lignes: JSON.stringify(lignes),
    statut: "Payée",
    notes: `Inscription web publique #${registrationId.slice(0, 8)} — adherent ${adherentId}`,
    exercice_id: exercise?.id || null,
    created_at: now,
    updated_at: now,
  };
  const columns = Object.keys(row);
  await db
    .prepare(`INSERT INTO factures (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((c) => row[c]))
    .run();
  return id;
}

async function syncClothingStockIfNeeded(env, registrationId, payload, totals) {
  const clothingOrder = payload?.clothingOrder || {};
  const orderItems = Array.isArray(totals?.orderItems) ? totals.orderItems : [];
  const hasClothing = Number(clothingOrder.tshirtQty || 0) > 0 || Number(clothingOrder.pantalonQty || 0) > 0;
  const hasAdditionalItems = orderItems.some((item) => Number(item?.quantity || 0) > 0 && String(item?.source || "") === "boutique");
  if (!hasClothing && !hasAdditionalItems) return { synced: false, skipped: true };

  const stock = hasClothing ? await fetchBoutiqueClothingStock(env) : { tshirt: null, pantalon: null };
  const items = [
    ...buildClothingSyncItems(stock, clothingOrder),
    ...buildAdditionalOrderSyncItems(orderItems),
  ];
  if (!items.length) return { synced: false, skipped: true };
  const result = await syncBoutiqueStock(env, `inscription:${registrationId}`, items);
  return { synced: true, result };
}

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

function buildRegistrationPdfPayload(registrationId, payload, totals, adherentId, exercise) {
  return {
    id: registrationId,
    submittedAt: new Date().toISOString().slice(0, 10),
    seasonLabel: seasonLabelFromExercise(exercise),
    identity: payload.identity || {},
    contact: payload.contact || {},
    emergency: payload.emergency || {},
    practice: payload.practice || {},
    health: payload.health || {},
    clothingOrder: payload.clothingOrder || {},
    consents: payload.consents || {},
    legalRepresentative: payload.legalRepresentative || {},
    payment: { method: "gratuit" },
    computedTotals: {
      ...totals,
      formulaLabel: totals.formulaLabel || payload.practice?.formulaCode || "",
      cotisation: Number(totals.cotisation || 0),
      clothingTotal: Number(totals.clothingTotal || 0),
      newMemberKit: Number(totals.newMemberKit || 0),
      passport: Number(totals.passport || 0),
      extraProductsTotal: Number(totals.extraProductsTotal || 0),
      passRegionAmount: Number(totals.passRegionAmount || 0),
      total: Number(totals.total || 0),
      pricingTshirt: Number(totals.pricingTshirt || 25),
      pricingPantalon: Number(totals.pricingPantalon || 15),
      certificateRequired: Boolean(totals.certificateRequired),
      orderItems: Array.isArray(totals.orderItems) ? totals.orderItems : [],
    },
  };
}

async function storeRegistrationPdf(env, db, registrationId, payload, totals, adherentId, exercise) {
  try {
    const pdfPayload = buildRegistrationPdfPayload(registrationId, payload, totals, adherentId, exercise);
    const registrationRow = await db
      .prepare(`SELECT documents_json FROM inscriptions_publiques WHERE id = ? LIMIT 1`)
      .bind(registrationId)
      .first();
    const photo = await fetchPhotoDocument(env, registrationRow?.documents_json);
    const pdfBytes = await generateAdherentPdf(pdfPayload, photo);
    const fileName = `inscription-affbc-${String(registrationId).slice(0, 8)}.pdf`;
    const r2Key = `adherents/${adherentId}/inscription-${String(registrationId).slice(0, 8)}.pdf`;
    const bucket = env.R2_PDF || env.R2_STORAGE;
    if (!bucket) return null;
    await bucket.put(r2Key, pdfBytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { registrationId, adherentId },
    });
    return { key: r2Key, fileName, pdfBytes };
  } catch (e) {
    return null; // non bloquant
  }
}

async function sendFreeRegistrationAlert(env, payload, totals, registrationId, adherentId, pdfFile) {
  if (!env.BREVO_API_KEY) return { sent: false, reason: "brevo_not_configured" };
  const clubRecipient = env.SIGNUP_ALERT_TO || "fullfightingbons@gmail.com";
  const registrantEmail = String(payload?.contact?.email || "").trim().toLowerCase();
  const from = env.SIGNUP_ALERT_FROM || "contact@americanfullfightingbons.fr";
  const nom = payload?.identity?.lastName || "";
  const prenom = payload?.identity?.firstName || "";
  const recipients = [
    { email: clubRecipient, name: env.SIGNUP_ALERT_TO_NAME || "AFFBC" },
    registrantEmail ? { email: registrantEmail, name: `${prenom} ${nom}`.trim() || registrantEmail } : null,
  ].filter((entry, index, array) => entry && array.findIndex((item) => item?.email === entry.email) === index);

  const attachment = pdfFile?.pdfBytes
    ? [{ name: pdfFile.fileName, content: uint8ToBase64(pdfFile.pdfBytes) }]
    : [];

  try {
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: env.SIGNUP_ALERT_SENDER_NAME || "AFFBC Inscriptions", email: from },
        to: recipients,
        subject: `✅ Renouvellement Bureau validé (gratuit) — ${nom} ${prenom}`,
        htmlContent: `
        <html><body style="font-family:Arial,sans-serif">
        <h2 style="color:#1f6b47">✅ Inscription validée — tarif Membres du Bureau (gratuit)</h2>
        <p><strong>Adhérent :</strong> ${prenom} ${nom}</p>
        <p><strong>Email :</strong> ${payload?.contact?.email || ""}</p>
        <p><strong>Montant :</strong> 0,00 € (aucun paiement HelloAsso requis pour ce tarif)</p>
        <p><strong>Référence inscription :</strong> ${registrationId}</p>
        <p><strong>Fiche adhérent créée (ID) :</strong> ${adherentId}</p>
        <p style="color:#888;font-size:12px">
        La fiche adhérent est maintenant visible dans le logiciel de gestion, onglet <strong>Adhérents</strong>.
        </p>
        </body></html>`,
        textContent: [
          "Inscription validée — tarif Membres du Bureau (gratuit)",
          `Adhérent : ${prenom} ${nom}`,
          `Email : ${payload?.contact?.email || ""}`,
          `Référence : ${registrationId}`,
          `Fiche adhérent ID : ${adherentId}`,
        ].join("\n"),
        attachment,
      }),
    });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error?.message || "send_failed" };
  }
}

/**
 * Finalise un dossier au montant nul (tarif Membres du Bureau) :
 * crée/maj la fiche adhérent, synchronise le stock si des articles annexes
 * ont été commandés, génère et stocke le PDF, met à jour la ligne
 * `inscriptions_publiques`, et envoie l'email de confirmation. Ne crée
 * aucune écriture dans `journal_comptable` (cf. note en tête de fichier).
 */
export async function finalizeFreeRegistration(env, db, registrationId, payload, totals) {
  const exercise = await findActiveExercise(db);

  const adherentId = await upsertFreeAdherent(db, payload, totals, exercise);

  const contact = payload.contact || {};
  const adresse = [contact.address1, contact.address2, contact.postalCode, contact.city].filter(Boolean).join(", ");
  await insertFreeSalesIfAny(
    db,
    registrationId,
    adherentId,
    String(payload.identity?.lastName || "").trim().toUpperCase(),
    String(payload.identity?.firstName || "").trim(),
    adresse,
    totals,
    payload.clothingOrder || {},
    exercise,
  );

  let stockSync = { synced: false, skipped: true };
  try {
    stockSync = await syncClothingStockIfNeeded(env, registrationId, payload, totals);
  } catch (e) {
    // Non bloquant : le dossier est déjà validé, on ne fait pas échouer
    // l'inscription pour un souci de synchro stock annexe.
  }

  const pdfFile = await storeRegistrationPdf(env, db, registrationId, payload, totals, adherentId, exercise);
  if (pdfFile) {
    const pdfUrl = `/api/storage/fullfighting-pdf/${pdfFile.key}`;
    await db
      .prepare(
        `UPDATE adherents
        SET pdf_inscription_storage_path = ?, pdf_inscription_public_url = ?, pdf_inscription_nom_fichier = ?, pdf_inscription_uploaded_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .bind(pdfFile.key, pdfUrl, pdfFile.fileName, new Date().toISOString(), new Date().toISOString(), adherentId)
      .run();
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE inscriptions_publiques
      SET statut = ?, adherent_id = ?, paiement_mode = ?, paiement_reference = ?, updated_at = ?
      WHERE id = ?`,
    )
    .bind("payee", adherentId, "gratuit", `GRATUIT-${registrationId.slice(0, 8).toUpperCase()}`, now, registrationId)
    .run();

  const emailStatus = await sendFreeRegistrationAlert(env, payload, totals, registrationId, adherentId, pdfFile);

  return { adherentId, stockSync, emailStatus };
}
