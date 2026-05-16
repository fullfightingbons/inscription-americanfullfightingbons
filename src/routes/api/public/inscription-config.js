import { badRequest, json } from "../../_lib/data.js";

const DEFAULT_CONFIG = {
  clubName: "American Full Fighting Bons En Chablais",
  clubAddress: "15 Place Henri Boucher 74890 Bons En Chablais",
  clubEmail: "fullfightingbons@gmail.com",
  clubPhone: "06 99 95 81 77",
  clubLogo: "/cloudflare/export/assets/storage/Logo_1_nnoir_copie-removebg-preview.png",
  dojoAddress: "Centre Sportif Intercommunal des Voirons, 146 rue du Châtelard, 74890 Bons en Chablais",
  schedule: [
    "Lundi : 19h00 - 20h30",
    "Mercredi : 20h30 - 22h30",
    "Vendredi : 20h30 - 22h30",
  ],
  pricing: {
    base: 250,
    family: 200,
    pro: 125,
    cseThales: 39,
    bureau: 0,
    newMemberKit: 35,
    passport: 25,
    passRegionMale: 30,
    passRegionFemale: 60,
    tshirt: 25,
    pantalon: 10,
  },
  bank: {
    holder: "AMERICAN FULL FIGHTING BONS EN CHABLAIS",
    iban: "FR7610278024430002080660174",
    bic: "CMCIFR2A",
    bankName: "CCM DE BONS-EN-CHABLAIS",
    bankAddress: "54 avenue du Léman, 74890 Bons en Chablais",
    transferLabel: "Merci d'indiquer NOM PRENOM ADHERENT dans le libellé du virement.",
  },
  paymentProviders: {
    currency: "EUR",
    stripeEnabled: false,
    paypalEnabled: false,
    helloAssoEnabled: false,
    paypalClientId: "",
  },
};

function buildConfig(clubInfo = {}, env = {}) {
  return {
    ...DEFAULT_CONFIG,
    clubName: clubInfo.nom || DEFAULT_CONFIG.clubName,
    clubAddress: clubInfo.adresse || DEFAULT_CONFIG.clubAddress,
    clubEmail: clubInfo.email || DEFAULT_CONFIG.clubEmail,
    clubPhone: clubInfo.telephone || DEFAULT_CONFIG.clubPhone,
    clubLogo: clubInfo.logo || DEFAULT_CONFIG.clubLogo,
    dojoAddress: clubInfo.public_inscription_dojo_adresse || DEFAULT_CONFIG.dojoAddress,
    schedule: clubInfo.public_inscription_horaires
      ? String(clubInfo.public_inscription_horaires).split("\n").map((item) => item.trim()).filter(Boolean)
      : DEFAULT_CONFIG.schedule,
    pricing: {
      base: Number(clubInfo.public_inscription_tarif_base || DEFAULT_CONFIG.pricing.base),
      family: Number(clubInfo.public_inscription_tarif_famille || DEFAULT_CONFIG.pricing.family),
      pro: Number(clubInfo.public_inscription_tarif_pro || DEFAULT_CONFIG.pricing.pro),
      cseThales: Number(clubInfo.public_inscription_tarif_cse_thales || DEFAULT_CONFIG.pricing.cseThales),
      bureau: DEFAULT_CONFIG.pricing.bureau,
      newMemberKit: Number(clubInfo.public_inscription_supplement_tenue || DEFAULT_CONFIG.pricing.newMemberKit),
      passport: Number(clubInfo.public_inscription_tarif_passeport || DEFAULT_CONFIG.pricing.passport),
      passRegionMale: Number(clubInfo.public_inscription_pass_region_homme || DEFAULT_CONFIG.pricing.passRegionMale),
      passRegionFemale: Number(clubInfo.public_inscription_pass_region_femme || DEFAULT_CONFIG.pricing.passRegionFemale),
      tshirt: Number(clubInfo.public_inscription_tshirt || DEFAULT_CONFIG.pricing.tshirt),
      pantalon: Number(clubInfo.public_inscription_pantalon || DEFAULT_CONFIG.pricing.pantalon),
    },
    bank: {
      holder: clubInfo.public_inscription_bank_holder || DEFAULT_CONFIG.bank.holder,
      iban: clubInfo.public_inscription_iban || DEFAULT_CONFIG.bank.iban,
      bic: clubInfo.public_inscription_bic || DEFAULT_CONFIG.bank.bic,
      bankName: clubInfo.public_inscription_bank_name || DEFAULT_CONFIG.bank.bankName,
      bankAddress: clubInfo.public_inscription_bank_address || DEFAULT_CONFIG.bank.bankAddress,
      transferLabel: clubInfo.public_inscription_transfer_label || DEFAULT_CONFIG.bank.transferLabel,
    },
    paymentProviders: {
      currency: env.PAYMENT_CURRENCY || DEFAULT_CONFIG.paymentProviders.currency,
      stripeEnabled: Boolean(env.STRIPE_SECRET_KEY),
      paypalEnabled: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
      helloAssoEnabled: Boolean(env.HELLOASSO_CLIENT_ID && env.HELLOASSO_CLIENT_SECRET && env.HELLOASSO_ORGANIZATION_SLUG),
      paypalClientId: env.PAYPAL_CLIENT_ID || "",
    },
  };
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return badRequest("D1 binding is missing", 500);
  }

  try {
    const result = await context.env.DB.prepare(`SELECT * FROM club_info`).all();
    const clubInfo = Object.fromEntries((result.results || []).map((row) => [row.cle, row.valeur]));
    return json({ data: buildConfig(clubInfo, context.env), error: null });
  } catch (error) {
    return badRequest(error.message, 500);
  }
}
