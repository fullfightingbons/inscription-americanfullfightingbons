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

// Voir le commentaire identique dans inscription.js : cette même fonction
// existait en double ici, avec le même bug de comparaison stricte de
// chaînes qui faisait échouer la vérification pour des dates pourtant
// identiques mais stockées dans un format légèrement différent (import CSV
// historique, saisie ancienne...).
function normalizeDateForComparison(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const fr = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (fr) {
    const year = fr[3].length === 2 ? `20${fr[3]}` : fr[3];
    return `${year}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}`;
  }
  return raw;
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
      `SELECT nom, prenom, naissance, email, discipline FROM adherents WHERE UPPER(TRIM(nom)) = ? AND UPPER(TRIM(prenom)) = ?`,
    )
      .bind(lastName, firstName.toUpperCase())
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
