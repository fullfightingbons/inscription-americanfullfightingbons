import { badRequest, json } from "../../_lib/data.js";
import { clothingStockResponse, fetchBoutiqueClothingStock, fetchBoutiqueProducts } from "../../_lib/boutique-stock.js";

/**
 * Valeurs par défaut de l'interface publique.
 * AUCUNE donnée sensible (IBAN, BIC, credentials) n'est codée en dur ici.
 * Les informations bancaires sont lues depuis club_info en base D1
 * ou, en dernier recours, depuis les variables d'environnement Cloudflare.
 */
const DEFAULT_CONFIG = {
  clubName:    "AMERICAN FULL FIGHTING BONS EN CHABLAIS",
  clubAddress: "15 Place Henri Boucher 74890 Bons En Chablais",
  clubEmail:   "fullfightingbons@gmail.com",
  clubPhone:   "06 99 95 81 77",
  clubLogo:    "/assets/Logo_1_nnoir_copie-removebg-preview.png",
  dojoAddress: "Centre Sportif Intercommunal des Voirons, 146 rue du Châtelard, 74890 Bons en Chablais",
  schedule: [
    "Lundi : 19h00 - 20h30",
    "Mercredi : 20h30 - 22h30",
    "Vendredi : 20h30 - 22h30",
  ],
  pricing: {
    base:              250,
    family:            200,
    pro:               125,
    cseThales:         39,
    bureau:            0,
    newMemberKit:      40,
    passport:          25,
    passRegionMale:    30,
    passRegionFemale:  60,
    tshirt:            25,
    pantalon:          15,
  },
  // Les coordonnées bancaires ne sont PAS dans ce fichier.
  // Elles sont chargées depuis la base D1 (table club_info)
  // ou depuis les variables d'environnement BANK_* de Cloudflare.
  bank: {},
  paymentProviders: {
    currency:        "EUR",
    stripeEnabled:   false,
    paypalEnabled:   false,
    helloAssoEnabled: false,
    paypalClientId:  "",
  },
  orderProducts: [],
};

function buildBank(clubInfo = {}, env = {}) {
  // Priorité : base D1 > variables d'environnement > champ vide (jamais de valeur codée en dur)
  return {
    holder:        clubInfo.public_inscription_bank_holder  || env.BANK_HOLDER       || "",
    iban:          clubInfo.public_inscription_iban          || env.BANK_IBAN         || "",
    bic:           clubInfo.public_inscription_bic           || env.BANK_BIC          || "",
    bankName:      clubInfo.public_inscription_bank_name    || env.BANK_NAME         || "",
    bankAddress:   clubInfo.public_inscription_bank_address || env.BANK_ADDRESS      || "",
    transferLabel: clubInfo.public_inscription_transfer_label || env.BANK_TRANSFER_LABEL || "",
  };
}

function buildConfig(clubInfo = {}, env = {}) {
  let jsonPricing = {};
  try {
    jsonPricing = clubInfo.inscription_pricing ? JSON.parse(clubInfo.inscription_pricing) : {};
  } catch {}

  return {
    ...DEFAULT_CONFIG,
    clubName:    clubInfo.nom        || DEFAULT_CONFIG.clubName,
    clubAddress: clubInfo.adresse    || DEFAULT_CONFIG.clubAddress,
    clubEmail:   clubInfo.email      || DEFAULT_CONFIG.clubEmail,
    clubPhone:   clubInfo.telephone  || DEFAULT_CONFIG.clubPhone,
    clubLogo:    clubInfo.logo       || DEFAULT_CONFIG.clubLogo,
    dojoAddress: clubInfo.public_inscription_dojo_adresse || DEFAULT_CONFIG.dojoAddress,
    schedule: clubInfo.public_inscription_horaires
      ? String(clubInfo.public_inscription_horaires)
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean)
      : DEFAULT_CONFIG.schedule,
    pricing: {
      base:             Number(clubInfo.public_inscription_tarif_base        || jsonPricing.base         || DEFAULT_CONFIG.pricing.base),
      family:           Number(clubInfo.public_inscription_tarif_famille     || jsonPricing.family       || DEFAULT_CONFIG.pricing.family),
      pro:              Number(clubInfo.public_inscription_tarif_pro         || jsonPricing.pro          || DEFAULT_CONFIG.pricing.pro),
      cseThales:        Number(clubInfo.public_inscription_tarif_cse_thales  || jsonPricing.cseThales    || DEFAULT_CONFIG.pricing.cseThales),
      bureau:           Number(clubInfo.public_inscription_bureau            || jsonPricing.bureau       || DEFAULT_CONFIG.pricing.bureau),
      newMemberKit:     Number(clubInfo.public_inscription_supplement_tenue  || jsonPricing.newMemberKit || DEFAULT_CONFIG.pricing.newMemberKit),
      passport:         Number(clubInfo.public_inscription_tarif_passeport   || jsonPricing.passport     || DEFAULT_CONFIG.pricing.passport),
      passRegionMale:   Number(clubInfo.public_inscription_pass_region_homme || jsonPricing.passRegionMale || DEFAULT_CONFIG.pricing.passRegionMale),
      passRegionFemale: Number(clubInfo.public_inscription_pass_region_femme || jsonPricing.passRegionFemale || DEFAULT_CONFIG.pricing.passRegionFemale),
      tshirt:           Number(clubInfo.public_inscription_tshirt            || jsonPricing.tshirt       || DEFAULT_CONFIG.pricing.tshirt),
      pantalon:         Number(clubInfo.public_inscription_pantalon          || jsonPricing.pantalon     || DEFAULT_CONFIG.pricing.pantalon),
    },
    bank: buildBank(clubInfo, env),
    paymentProviders: {
      currency:         env.PAYMENT_CURRENCY || DEFAULT_CONFIG.paymentProviders.currency,
      stripeEnabled:    Boolean(env.STRIPE_SECRET_KEY),
      paypalEnabled:    Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
      helloAssoEnabled: Boolean(
        env.HELLOASSO_CLIENT_ID &&
        env.HELLOASSO_CLIENT_SECRET &&
        env.HELLOASSO_ORGANIZATION_SLUG,
      ),
      paypalClientId:   env.PAYPAL_CLIENT_ID || "",
    },
    orderProducts: [],
  };
}

function parseOrderProductsConfig(clubInfo = {}) {
  try {
    const parsed = clubInfo.inscription_order_products ? JSON.parse(clubInfo.inscription_order_products) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveOrderProducts(rawProducts = [], boutiqueProducts = []) {
  const boutiqueById = new Map((boutiqueProducts || []).map((product) => [Number(product.productId), product]));
  return rawProducts
    .filter((product) => product && product.active !== false)
    .map((product) => {
      const source = String(product.source || "gestion");
      const boutiqueProductId = Number(product.boutiqueProductId || 0) || null;
      const boutiqueProduct = source === "boutique" && boutiqueProductId
        ? boutiqueById.get(boutiqueProductId)
        : null;
      return {
        id: String(product.id || boutiqueProductId || crypto.randomUUID()),
        source,
        active: product.active !== false,
        boutiqueProductId,
        name: String(boutiqueProduct?.name || product.name || ""),
        description: String(boutiqueProduct?.description || product.description || ""),
        price: Number(boutiqueProduct?.price ?? product.price ?? 0),
        requiresSize: Boolean(
          product.requiresSize ||
          (Array.isArray(boutiqueProduct?.sizes) && boutiqueProduct.sizes.length > 0),
        ),
        sizes: Array.isArray(boutiqueProduct?.sizes)
          ? boutiqueProduct.sizes
          : Array.isArray(product.sizes)
            ? product.sizes
            : [],
        stock: boutiqueProduct ? Number(boutiqueProduct.stock || 0) : null,
        stockBySize: boutiqueProduct?.stockBySize || {},
        defaultQtyNew: Math.max(0, Number(product.defaultQtyNew || 0)),
      };
    })
    .filter((product) => product.name && Number.isFinite(product.price));
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return badRequest("D1 binding is missing", 500);
  }

  try {
    const result   = await context.env.DB.prepare(`SELECT * FROM club_info`).all();
    const clubInfo = Object.fromEntries(
      (result.results || []).map((row) => [row.cle, row.valeur]),
    );
    let clothingStock = { tshirt: null, pantalon: null };
    let orderProducts = [];
    try {
      clothingStock = clothingStockResponse(await fetchBoutiqueClothingStock(context.env));
      const boutiqueProducts = await fetchBoutiqueProducts(context.env);
      orderProducts = resolveOrderProducts(parseOrderProductsConfig(clubInfo), boutiqueProducts);
    } catch (error) {
      console.warn("[inscription-config] Stock boutique indisponible:", error?.message ?? String(error));
      orderProducts = resolveOrderProducts(parseOrderProductsConfig(clubInfo), []);
    }
    return json({ data: { ...buildConfig(clubInfo, context.env), clothingStock, orderProducts }, error: null });
  } catch (error) {
    console.error("[inscription-config] Erreur:", error?.message ?? String(error));
    return badRequest("Erreur lors du chargement de la configuration", 500);
  }
}
