import { badRequest, json } from "../../_lib/data.js";

function normalizePersonName(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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
    const lastName = normalizePersonName(url.searchParams.get("lastName")).toUpperCase();
    const firstName = normalizePersonName(url.searchParams.get("firstName"));
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

    const adherent = await context.env.DB.prepare(
      `SELECT nom, prenom, naissance, email, discipline FROM adherents WHERE nom = ? AND prenom = ?`,
    )
      .bind(lastName, firstName)
      .first();

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

    if (adherent.naissance !== birthDate) {
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

    return json({
      data: {
        checked: true,
        renewalVerified: true,
        eligibleForBureauRate: hasBureauDiscipline(adherent.discipline),
        reason: hasBureauDiscipline(adherent.discipline) ? "eligible" : "discipline_missing",
      },
      error: null,
    });
  } catch (error) {
    return badRequest(error.message, 500);
  }
}
