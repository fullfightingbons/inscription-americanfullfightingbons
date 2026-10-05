import { badRequest, json } from "../../_lib/data.js";
import { normalizeNameForComparison, normalizeDateForComparison, normalizeEmail } from "../../_lib/helpers.js";
import { findReusableCertificate } from "../../_lib/medical-certificate.js";

function normalizePersonName(value) {
  return String(value || "").trim();
}

function hasBureauDiscipline(discipline) {
  return String(discipline || "").toLowerCase().includes("membre du bureau");
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return badRequest("D1 binding is missing", 500);
  }

  try {
    const url = new URL(context.request.url);
    const typeInscription = normalizePersonName(url.searchParams.get("typeInscription"));
    const lastName = normalizeNameForComparison(url.searchParams.get("lastName"));
    const firstName = normalizeNameForComparison(url.searchParams.get("firstName"));
    const birthDate = normalizePersonName(url.searchParams.get("birthDate"));
    const email = normalizeEmail(url.searchParams.get("email"));

    if (typeInscription !== "renouvellement") {
      return json({
        data: {
          checked: true,
          renewalVerified: false,
          eligibleForBureauRate: false,
          reason: "not_renewal",
        },
        error: null,
      });
    }

    if (!lastName || !firstName || !birthDate || !email) {
      return json({
        data: {
          checked: false,
          renewalVerified: false,
          eligibleForBureauRate: false,
          reason: "missing_fields",
        },
        error: null,
      });
    }

    const { results } = await context.env.DB
      .prepare(`SELECT id, nom, prenom, naissance, email, discipline FROM adherents`)
      .all();
    const adherent = (results || []).find(
      (a) => normalizeNameForComparison(a.nom) === lastName && normalizeNameForComparison(a.prenom) === firstName,
    ) || null;

    if (!adherent) {
      return json({
        data: {
          checked: true,
          renewalVerified: false,
          eligibleForBureauRate: false,
          reason: "not_found",
        },
        error: null,
      });
    }

    if (normalizeDateForComparison(adherent.naissance) !== normalizeDateForComparison(birthDate)) {
      return json({
        data: {
          checked: true,
          renewalVerified: false,
          eligibleForBureauRate: false,
          reason: "birthdate_mismatch",
        },
        error: null,
      });
    }

    if (normalizeEmail(adherent.email) !== email) {
      return json({
        data: {
          checked: true,
          renewalVerified: false,
          eligibleForBureauRate: false,
          reason: "email_mismatch",
        },
        error: null,
      });
    }

    // Identité entièrement vérifiée (nom, prénom, naissance, e-mail) : on indique au formulaire si un
    // certificat médical déjà validé est réutilisable, pour ne pas le redemander. Purement informatif :
    // le serveur refait le calcul à l'envoi du dossier. Jamais bloquant pour l'éligibilité.
    const reuse = await findReusableCertificate(context.env.DB, adherent.id);

    return json({
      data: {
        checked: true,
        renewalVerified: true,
        eligibleForBureauRate: hasBureauDiscipline(adherent.discipline),
        reason: hasBureauDiscipline(adherent.discipline) ? "eligible" : "discipline_missing",
        certificateReusable: reuse.reusable === true,
        certificateValidUntil: reuse.reusable === true ? reuse.validUntil : null,
      },
      error: null,
    });
  } catch (error) {
    return badRequest(error.message, 500);
  }
}
