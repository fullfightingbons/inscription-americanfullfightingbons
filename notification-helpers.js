/**
 * Helpers partagés — isMinor, calculateTotals, normalizeInstallmentCount,
 * findActiveExercise. Centralisés ici pour éviter la duplication entre
 * inscription.js et status.js.
 */

export function isMinor(birthDate) {
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

export function normalizeInstallmentCount(value) {
  const count = Number(value || 1);
  return count === 2 || count === 3 ? count : 1;
}

/**
 * Retourne l'exercice comptable actif (statut = 'actif'), ou à défaut le plus
 * récent. Utilisé à la fois lors de la soumission d'inscription et lors de la
 * confirmation de paiement — d'où sa centralisation ici.
 */
export async function findActiveExercise(db) {
  const active = await db
    .prepare(`SELECT * FROM exercices WHERE statut = 'actif' ORDER BY date_debut DESC LIMIT 1`)
    .first();
  if (active?.id) return active;
  return db.prepare(`SELECT * FROM exercices ORDER BY date_debut DESC LIMIT 1`).first();
}

/**
 * Calcule un libellé de saison "AAAA-AAAA" à partir d'une date (saison
 * sportive démarrant en juillet). Reproduit la même règle que
 * currentSeasonLabel()/seasonFromDate() côté logiciel de gestion, pour que
 * les deux logiciels affichent toujours la même saison.
 */
export function currentSeasonLabel(ref = new Date()) {
  const year = ref.getFullYear();
  const month = ref.getMonth() + 1; // 1-12
  const start = month >= 7 ? year : year - 1;
  return `${start}-${start + 1}`;
}

/**
 * Libellé de saison à afficher : priorité au libellé de l'exercice comptable
 * actif en base (piloté par le club dans l'onglet Administration de la
 * gestion), avec repli sur un calcul automatique si aucun exercice n'est
 * configuré ou que son libellé ne correspond pas au format attendu.
 */
export function seasonLabelFromExercise(exercise) {
  const label = String(exercise?.libelle || "").trim();
  if (/^\d{4}-\d{4}$/.test(label)) return label;
  return currentSeasonLabel();
}

// Montants de remise Pass Région réellement proposés par le formulaire
// (cf. <select id="passRegionAmount"> dans index.html). Toute autre valeur
// est rejetée pour empêcher une falsification du montant côté client.
const ALLOWED_PASS_REGION_AMOUNTS = new Set([30, 60]);

/**
 * Calcule les totaux à partir des tarifs chargés DEPUIS LA BASE (jamais du payload client).
 * @param {object} practice  – champs practice du payload
 * @param {object} pricing   – tarifs chargés depuis D1 (club_info ou DEFAULT_PRICING)
 * @param {object} clothing  – commande de tenue du payload
 * @returns {object} totaux
 */
export function calculateTotals(practice, pricing, clothing = {}, extraOrderItems = [], extraProductCatalog = []) {
  const formula        = practice.formulaCode;
  const typeInscription = practice.typeInscription;
  const passRegionEnabled = toBool(practice.passRegionEnabled);
  const passportEnabled   = toBool(practice.passportEnabled);

  const baseMap = {
    base:       Number(pricing.base      || 250),
    family:     Number(pricing.family    || 200),
    pro:        Number(pricing.pro       || 125),
    cse_thales: Number(pricing.cseThales || 39),
    bureau:     Number(pricing.bureau    || 0),
  };

  const formulaLabelMap = {
    base:       "Tarif standard",
    family:     "Tarif famille",
    pro:        "Tarif professionnel",
    cse_thales: "Tarif CSE Thales",
    bureau:     "Membres du Bureau",
  };

  const baseCotisation = baseMap[formula];
  if (!Number.isFinite(baseCotisation)) {
    throw new Error("Formule tarifaire invalide");
  }

  let passRegionAmount = 0;
  if (passRegionEnabled) {
    const requestedAmount = Number(practice.passRegionAmount || 0);
    if (!ALLOWED_PASS_REGION_AMOUNTS.has(requestedAmount)) {
      throw new Error("Montant de remise Pass Région invalide");
    }
    passRegionAmount = requestedAmount;
  }
  const cotisation = Math.max(0, baseCotisation - passRegionAmount);

  const isNewMember = typeInscription === "nouvelle";

  let tshirtQty   = Math.max(0, Number(clothing.tshirtQty   || 0));
  let pantalonQty = Math.max(0, Number(clothing.pantalonQty || 0));

  // Pour une nouvelle adhésion, la tenue complète (1 t-shirt + 1 pantalon)
  // est obligatoire. Cette règle est aussi validée côté formulaire, mais on
  // l'impose ICI côté serveur pour empêcher un appel API direct de réduire
  // la facture en passant des quantités à 0 — même classe de faille que
  // celle déjà corrigée pour passRegionAmount.
  if (isNewMember) {
    tshirtQty   = Math.max(1, tshirtQty);
    pantalonQty = Math.max(1, pantalonQty);
  }

  // Supplément "tenue nouvel adhérent" : ajouté uniquement pour les nouvelles
  // adhésions, en plus du coût des articles commandés (tshirt × prix +
  // pantalon × prix). Utilisé tel quel par la génération de PDF et la
  // ventilation comptable (cf. _lib/pdf.js et payment/helloasso/status.js).
  const newMemberKit    = isNewMember ? Number(pricing.newMemberKit || 0) : 0;
  const passport        = passportEnabled ? Number(pricing.passport || 25) : 0;
  const pricingTshirt   = Number(pricing.tshirt   || 25);
  const pricingPantalon = Number(pricing.pantalon || 15);
  const clothingTotal   = tshirtQty * pricingTshirt + pantalonQty * pricingPantalon;
  const requestedItems = Array.isArray(extraOrderItems) ? extraOrderItems : [];
  const catalog = Array.isArray(extraProductCatalog) ? extraProductCatalog : [];
  const requestedById = new Map(
    requestedItems
      .filter((item) => item?.id)
      .map((item) => [String(item.id), item]),
  );
  const orderItems = catalog
    .filter((product) => product && product.active !== false)
    .map((product) => {
      const requested = requestedById.get(String(product.id)) || {};
      const defaultQtyNew = Number(product.defaultQtyNew || 0);
      const quantity = Math.max(
        Number(requested.quantity || 0),
        typeInscription === "nouvelle" ? defaultQtyNew : 0,
      );
      const unitPrice = Number(product.price || 0);
      return {
        id: String(product.id),
        source: String(product.source || "gestion"),
        name: String(product.name || ""),
        description: String(product.description || ""),
        quantity,
        unitPrice,
        size: String(requested.size || ""),
        requiresSize: Boolean(product.requiresSize),
        boutiqueProductId: product.boutiqueProductId ? Number(product.boutiqueProductId) : null,
        total: quantity * unitPrice,
      };
    })
    .filter((item) => item.quantity > 0);
  const extraProductsTotal = orderItems.reduce((sum, item) => sum + Number(item.total || 0), 0);

  return {
    cotisation,
    passRegionAmount,
    passport,
    newMemberKit,
    clothingTotal,
    extraProductsTotal,
    tshirtQty,
    pantalonQty,
    pricingTshirt,
    pricingPantalon,
    orderItems,
    total: cotisation + passport + newMemberKit + clothingTotal + extraProductsTotal,
    formulaLabel: formulaLabelMap[formula] || formula,
  };
}

export function toBool(value) {
  return (
    value === true ||
    value === "true" ||
    value === "1" ||
    value === 1 ||
    value === "on"
  );
}
