/**
 * AFFBC — Cache du jeton OAuth HelloAsso
 *
 * Incident INC-EM2X2A (13/10/2026) : HelloAsso a répondu 429 « error code: 1015 »
 * (limitation de débit Cloudflare) sur `POST /oauth2/token`. Le Worker demandait
 * un jeton NEUF à chaque création de paiement, chaque reprise et chaque
 * vérification de statut, alors qu'un jeton `client_credentials` reste valable
 * plusieurs minutes (`expires_in`).
 *
 * Ce module garde le jeton en mémoire de l'isolat Workers jusqu'à son expiration
 * (moins une marge), de sorte que la plupart des appels HelloAsso n'ont plus
 * besoin de contacter `/oauth2/token` du tout.
 *
 * Choix volontaires :
 *  - Cache en mémoire uniquement (aucune migration D1, aucun binding KV à ajouter) :
 *    chaque isolat garde son propre jeton, ce qui suffit à écraser le volume d'appels.
 *  - Seule la valeur du jeton (une chaîne) est partagée entre requêtes. On ne partage
 *    PAS de Promise en cours : une Promise née dans le contexte d'une requête peut
 *    échouer ou se bloquer si cette requête est annulée (client déconnecté) alors
 *    qu'une autre l'attend. Au pire, deux requêtes simultanées sur un isolat « froid »
 *    demandent chacune un jeton, puis plus aucune ne le refait.
 *  - Un échec d'authentification n'est jamais mis en cache.
 *  - Le secret n'est jamais stocké dans la clé du cache ni journalisé.
 */

/** Marge avant expiration : on renouvelle un peu avant la fin de validité réelle. */
const EXPIRY_MARGIN_MS = 120_000;
/** Durée de vie retenue si HelloAsso ne renvoie pas `expires_in` (prudente). */
const DEFAULT_TTL_MS = 5 * 60_000;
/** Plafond de sécurité : jamais plus d'une heure en cache, quelle que soit la réponse. */
const MAX_TTL_MS = 60 * 60_000;

/** @type {Map<string, { token: string, expiresAt: number }>} */
const cache = new Map();

function cacheKey(env) {
  const target = env?.HELLOASSO_ENV === "sandbox" ? "sandbox" : "production";
  return `${target}|${String(env?.HELLOASSO_CLIENT_ID || "")}`;
}

/**
 * Convertit `expires_in` (secondes, renvoyé par HelloAsso) en durée de cache (ms),
 * marge de renouvellement déduite. Retourne 0 si le jeton ne doit pas être gardé.
 */
export function computeTokenTtlMs(expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TTL_MS;
  const lifetimeMs = seconds * 1000;
  // Marge proportionnelle pour les jetons très courts (jamais plus de 10 % de la durée).
  const margin = Math.min(EXPIRY_MARGIN_MS, lifetimeMs * 0.1);
  return Math.max(0, Math.min(lifetimeMs - margin, MAX_TTL_MS));
}

/**
 * Retourne un jeton valide : celui du cache s'il est encore frais, sinon un jeton
 * neuf demandé via `requestFresh(env)`.
 *
 * @param {object} env
 * @param {(env: object) => Promise<{ token: string, expiresIn?: number }>} requestFresh
 *        Appel réseau réel à /oauth2/token ; doit lever en cas d'échec (jamais mis en cache).
 * @param {{ forceRefresh?: boolean }} [options]
 *        `forceRefresh` ignore le cache (contrôle de santé, jeton refusé par HelloAsso).
 * @returns {Promise<{ token: string, cached: boolean }>}
 *          `cached` = true si le jeton vient du cache (utile pour savoir si un 401
 *          peut simplement signifier « jeton périmé » plutôt que « identifiants refusés »).
 */
export async function acquireHelloAssoToken(env, requestFresh, { forceRefresh = false } = {}) {
  const key = cacheKey(env);

  if (!forceRefresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return { token: hit.token, cached: true };
    if (hit) cache.delete(key);
  }

  const { token, expiresIn } = await requestFresh(env);
  const ttl = computeTokenTtlMs(expiresIn);
  if (ttl > 0) cache.set(key, { token, expiresAt: Date.now() + ttl });
  else cache.delete(key);
  return { token, cached: false };
}

/**
 * Oublie le jeton en cache — uniquement s'il s'agit bien de `token` : si une autre
 * requête en a déjà mis un plus récent, on ne l'écrase pas.
 */
export function invalidateHelloAssoToken(env, token) {
  const key = cacheKey(env);
  const hit = cache.get(key);
  if (hit && (!token || hit.token === token)) cache.delete(key);
}

/** Vide tout le cache (tests). */
export function resetHelloAssoTokenCache() {
  cache.clear();
}
