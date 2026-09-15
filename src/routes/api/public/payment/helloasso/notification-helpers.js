const HELLOASSO_SOURCE_IPS = {
  production: new Set(["51.138.206.200"]),
  sandbox: new Set(["4.233.135.234"]),
};

function getClientIp(request) {
  const cloudflareIp = String(request.headers.get("cf-connecting-ip") || "").trim();
  if (cloudflareIp) {
    return cloudflareIp;
  }
  const forwarded = String(request.headers.get("x-forwarded-for") || "").trim();
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return "";
}

function getExpectedNotificationIps(env) {
  return env.HELLOASSO_ENV === "sandbox"
    ? HELLOASSO_SOURCE_IPS.sandbox
    : HELLOASSO_SOURCE_IPS.production;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function computeHmacHex(payload, secret) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Bug du 15/09/2026 : la signature HMAC (header x-ha-signature) est une
// fonctionnalité HelloAsso réservée aux comptes « partenaire »
// (cf. dev.helloasso.com/docs/secure-webhook : « Fonctionnalité disponible
// uniquement pour les partenaires. »). AFFBC est une association standard
// (authentification par client_id/client_secret, cf.
// dev.helloasso.com/docs/obtenir-une-clé-api — pas la mire d'autorisation
// partenaire) : HelloAsso ne lui enverra donc JAMAIS de x-ha-signature, quel
// que soit le réglage côté club. L'ancien code rejetait pourtant sans appel
// toute notification de production dépourvue de signature — ce qui revenait à rejeter 100 % des notifications HelloAsso en
// production, quelle que soit leur authenticité. C'est très probablement la
// cause des inscriptions payées côté HelloAsso mais jamais finalisées côté
// gestion (fiche/PDF/comptabilité absents) : le webhook, seul filet de
// sécurité si le retour navigateur échoue, était rejeté à chaque tentative.
//
// Correctif : repli sur la vérification par adresse IP source — méthode
// documentée par HelloAsso lui-même pour les associations standard, dans les
// deux environnements (production ET sandbox), pas seulement en sandbox.
async function verifyHelloAssoNotification(request, rawBody, env) {
  const signatureHeader = String(request.headers.get("x-ha-signature") || "").trim();
  const signatureKey = String(env.HELLOASSO_NOTIFICATION_SIGNATURE_KEY || "").trim();
  if (signatureHeader && signatureKey) {
    const computedSignature = await computeHmacHex(rawBody, signatureKey);
    return timingSafeEqual(computedSignature, signatureHeader);
  }

  const clientIp = getClientIp(request);
  return getExpectedNotificationIps(env).has(clientIp);
}

function getRegistrationIdFromNotification(payload) {
  return String(
    payload?.metadata?.registrationId ||
    payload?.data?.metadata?.registrationId ||
    payload?.data?.order?.metadata?.registrationId ||
    "",
  ).trim();
}

export {
  computeHmacHex,
  getClientIp,
  getRegistrationIdFromNotification,
  getExpectedNotificationIps,
  timingSafeEqual,
  verifyHelloAssoNotification,
};
