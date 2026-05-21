/**
 * Helpers partagés — isMinor, calculateTotals, normalizeInstallmentCount
 * Centralisés ici pour éviter la duplication entre inscription.js et status.js.
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

  const passRegionAmount = passRegionEnabled
    ? Number(practice.passRegionAmount || 0)
    : 0;
  const cotisation = Math.max(0, baseCotisation - passRegionAmount);

  const tshirtQty = Math.max(
    Number(clothing.tshirtQty || 0),
    typeInscription === "nouvelle" ? 1 : 0,
  );
  const pantalonQty = Math.max(
    Number(clothing.pantalonQty || 0),
    typeInscription === "nouvelle" ? 1 : 0,
  );

  const newMemberKit    = Number(pricing.newMemberKit || 0);
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
    newMemberKit,
    passport,
    clothingTotal,
    extraProductsTotal,
    tshirtQty,
    pantalonQty,
    pricingTshirt,
    pricingPantalon,
    orderItems,
    total: cotisation + newMemberKit + passport + clothingTotal + extraProductsTotal,
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
