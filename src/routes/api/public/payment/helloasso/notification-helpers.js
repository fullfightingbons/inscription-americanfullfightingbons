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

function isStrictSignatureRequired(env) {
  return env.HELLOASSO_ENV !== "sandbox";
}

async function verifyHelloAssoNotification(request, rawBody, env) {
  const signatureHeader = String(request.headers.get("x-ha-signature") || "").trim();
  const signatureKey = String(env.HELLOASSO_NOTIFICATION_SIGNATURE_KEY || "").trim();
  if (signatureHeader && signatureKey) {
    const computedSignature = await computeHmacHex(rawBody, signatureKey);
    return timingSafeEqual(computedSignature, signatureHeader);
  }

  if (isStrictSignatureRequired(env)) {
    return false;
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
  isStrictSignatureRequired,
  timingSafeEqual,
  verifyHelloAssoNotification,
};
