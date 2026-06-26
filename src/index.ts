// ─── Handlers des routes publiques d'inscription ──────────────────────────────
// Ces modules ont été écrits avec la convention Cloudflare Pages Functions
// (onRequestGet / onRequestPost prenant un objet { request, env }). Ce projet
// est déployé comme un Worker classique (pas de routage par fichier), donc on
// les branche explicitement ici plutôt que de compter sur un routage automatique.
import { onRequestGet as inscriptionConfigHandler } from "./routes/api/public/inscription-config.js";
import { onRequestGet as adherentEligibilityHandler } from "./routes/api/public/adherent-eligibility.js";
import { onRequestPost as inscriptionSubmitHandler } from "./routes/api/public/inscription.js";
import { onRequestGet as helloAssoStatusHandler } from "./routes/api/public/payment/helloasso/status.js";
import { onRequestPost as helloAssoNotificationHandler } from "./routes/api/public/payment/helloasso/notification.js";
import { onRequestGet as tarifsHandler } from "./routes/api/public/tarifs";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AFFBC_DB?: D1Database;
  SITE_NAME?: string;
  CONTACT_EMAIL?: string;
  CONTACT_PHONE?: string;
  CONTACT_ADDRESS?: string;
  CONTACT_FORM_FROM_EMAIL?: string;
  CONTACT_FORM_TO_EMAIL?: string;
  BREVO_API_KEY?: string;
  SESSION_SECRET?: string;
  HELLOASSO_CLIENT_ID?: string;
  HELLOASSO_CLIENT_SECRET?: string;
  HELLOASSO_ENV?: string;
  GOOGLE_PLACES_API_KEY?: string;
  SITE_PUBLIC_URL?: string;
  /** Set to "dev" in wrangler.json vars to disable the Secure cookie flag locally */
  ENV?: string;
}

type Row = Record<string, unknown>;


const SESSION_COOKIE = "affbc_site_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_PREFIX = "pbkdf2_sha256";
const MAX_PBKDF2_ITERATIONS = 100000;
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_SEC = 15 * 60;       // 15 minutes
const GOOGLE_REVIEWS_CACHE_TTL_MS = 30 * 60 * 1000;
const googleReviewsCache = new Map<string, { expiresAt: number; data: Row[] }>();

/**
 * Rate limiting login persistant via D1 — résistant au multi-instances Cloudflare.
 * Retourne true si la requête est autorisée, false si bloquée.
 */
async function checkLoginRateLimit(ip: string, env: Env): Promise<boolean> {
  const windowStart = new Date(Date.now() - LOGIN_WINDOW_SEC * 1000).toISOString();
  try {
    // Nettoyer les entrées expirées (best effort)
    await env.DB.prepare(
      "DELETE FROM auth_rate_limits WHERE ip = ? AND last_attempt < ?"
    ).bind(ip, windowStart).run();

    const row = await env.DB.prepare(
      "SELECT attempt_count, blocked_until FROM auth_rate_limits WHERE ip = ? LIMIT 1"
    ).bind(ip).first<Row>();

    if (row?.blocked_until) {
      const blockedUntil = new Date(String(row.blocked_until)).getTime();
      if (Date.now() < blockedUntil) return false;
    }

    if (row && Number(row.attempt_count) >= LOGIN_MAX_ATTEMPTS) {
      // Bloquer pour 15 min
      const blockedUntil = new Date(Date.now() + LOGIN_WINDOW_SEC * 1000).toISOString();
      await env.DB.prepare(
        "UPDATE auth_rate_limits SET blocked_until = ?, last_attempt = CURRENT_TIMESTAMP WHERE ip = ?"
      ).bind(blockedUntil, ip).run();
      return false;
    }

    // Incrémenter ou créer
    await env.DB.prepare(`
      INSERT INTO auth_rate_limits (ip, attempt_count, last_attempt)
      VALUES (?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(ip) DO UPDATE SET
        attempt_count = attempt_count + 1,
        last_attempt  = CURRENT_TIMESTAMP
    `).bind(ip).run();

    return true;
  } catch {
    // En cas d'erreur D1 (table manquante, etc.), ne pas bloquer
    return true;
  }
}

async function resetLoginRateLimit(ip: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM auth_rate_limits WHERE ip = ?").bind(ip).run();
  } catch { /* best effort */ }
}

const PUBLIC_TABLES = new Set([
  "site_settings",
  "landing_sections",
  "schedule_slots",
  "team_members",
  "highlights",
  "gallery_items",
  "partner_links",
  "custom_buttons",
  "custom_blocks",
  "pricing_plans",
  "resource_cards",
  "equipment_items",
  "sponsor_partners",
  "news_items",
  "faq_items",
  "testimonials",
  "media_assets",
]);

const EDITABLE_TABLES = {
  site_settings: { primaryKey: "key", allowedColumns: ["key", "value"] },
  landing_sections: {
    primaryKey: "id",
    allowedColumns: ["id", "section_key", "title", "subtitle", "enabled", "display_order"],
  },
  schedule_slots: {
    primaryKey: "id",
    allowedColumns: ["id", "day_label", "time_label", "note", "text_align", "display_order"],
  },
  team_members: {
    primaryKey: "id",
    allowedColumns: ["id", "full_name", "role_label", "belt_label", "bio", "image_url", "text_align", "display_order"],
  },
  highlights: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "body", "badge", "cta_label", "cta_href", "text_align", "display_order"],
  },
  gallery_items: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "image_url", "alt_text", "text_align", "display_order"],
  },
  partner_links: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "href", "description", "cta_label", "display_order"],
  },
  custom_buttons: {
    primaryKey: "id",
    allowedColumns: ["id", "label", "href", "placement", "style", "enabled", "display_order"],
  },
  custom_blocks: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "body", "image_url", "image_fit", "cta_label", "cta_href", "width_percent", "height_px", "text_align", "enabled", "display_order"],
  },
  resource_cards: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "description", "cta_label", "cta_href", "image_url", "image_fit", "text_align", "enabled", "display_order"],
  },
  equipment_items: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "description", "cta_label", "cta_href", "image_url", "image_fit", "text_align", "enabled", "display_order"],
  },
  sponsor_partners: {
    primaryKey: "id",
    allowedColumns: ["id", "name", "description", "website_url", "cta_label", "logo_url", "image_fit", "featured", "text_align", "enabled", "display_order"],
  },
  news_items: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "body", "date_label", "badge", "cta_label", "cta_href", "image_url", "image_fit", "text_align", "enabled", "display_order"],
  },
  faq_items: {
    primaryKey: "id",
    allowedColumns: ["id", "question", "answer", "text_align", "enabled", "display_order"],
  },
  testimonials: {
    primaryKey: "id",
    allowedColumns: ["id", "author_name", "role_label", "quote", "image_url", "image_fit", "text_align", "enabled", "display_order"],
  },
  media_assets: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "image_url", "alt_text", "display_order"],
  },
  pricing_plans: {
    primaryKey: "id",
    allowedColumns: ["id", "title", "price_label", "description", "badge", "text_align", "enabled", "display_order"],
  },
  admin_users: {
    primaryKey: "id",
    allowedColumns: ["id", "display_name", "email", "password_hash", "active", "updated_at"],
  },
} as const;

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

const ALLOWED_ORIGINS = new Set([
  "https://americanfullfightingbons.fr",
  "https://www.americanfullfightingbons.fr",
  "https://inscription.americanfullfightingbons.fr",
  "https://gestion.americanfullfightingbons.fr",
  "https://boutique.americanfullfightingbons.fr",
  "https://calendrier.americanfullfightingbons.fr",
]);

function withHeaders(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  // CORS : liste d'origines explicites, jamais de wildcard
  const origin = request?.headers.get("origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://americanfullfightingbons.fr";
  headers.set("access-control-allow-origin", allowOrigin);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type, Authorization");
  headers.set("vary", "Origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-src https://www.google.com https://www.google.fr",
    ].join("; "),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function ok(data: unknown, init: ResponseInit = {}, request?: Request): Response {
  return withHeaders(json({ ok: true, data }, init), request);
}

function error(message: string, status = 400, request?: Request): Response {
  return withHeaders(json({ ok: false, error: message }, { status }), request);
}

function parseCookies(request: Request): Record<string, string> {
  const raw = request.headers.get("cookie") || "";
  return Object.fromEntries(
    raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        if (idx < 0) return [part, ""];
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      })
  );
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid identifier: ${value}`);
  return `"${value}"`;
}

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return atob(padded);
}

function bytesToBase64Url(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesFromBase64Url(value: string): Uint8Array {
  const binary = fromBase64Url(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function secureEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let delta = 0;
  for (let i = 0; i < left.length; i++) delta |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return delta === 0;
}

function getSessionSecret(env: Env): string {
  const secret = String(env.SESSION_SECRET || "");
  if (secret.length < 32) throw new Error("SESSION_SECRET missing or too short");
  return secret;
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(signature);
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, MAX_PBKDF2_ITERATIONS);
  return `${PASSWORD_HASH_PREFIX}$${MAX_PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

async function verifyPassword(password: string, storedPassword: unknown): Promise<boolean> {
  const stored = String(storedPassword || "").trim();
  if (!stored || !stored.startsWith(`${PASSWORD_HASH_PREFIX}$`)) return false;
  const [, iterationsRaw, saltRaw, hashRaw] = stored.split("$");
  const iterations = Number.parseInt(iterationsRaw || "", 10);
  if (!iterations || iterations > MAX_PBKDF2_ITERATIONS || !saltRaw || !hashRaw) return false;
  const derived = await derivePasswordHash(password, bytesFromBase64Url(saltRaw), iterations);
  return secureEquals(bytesToBase64Url(derived), hashRaw);
}

async function createSessionToken(payload: Record<string, unknown>, env: Env): Promise<string> {
  const serialized = toBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256Base64Url(getSessionSecret(env), serialized);
  return `${serialized}.${signature}`;
}

async function parseSessionToken(token: string, env: Env): Promise<Record<string, unknown> | null> {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = await hmacSha256Base64Url(getSessionSecret(env), payload);
  if (!secureEquals(expected, signature)) return null;
  try {
    return JSON.parse(fromBase64Url(payload));
  } catch {
    return null;
  }
}

function sanitizeText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function sanitizeEmail(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength).toLowerCase();
}

function sanitizeUrl(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeDbValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseBooleanSetting(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function readTable<T = Row>(db: D1Database, sql: string, bindings: unknown[] = []): Promise<T[]> {
  const result = await db.prepare(sql).bind(...bindings).all<T>();
  return result.results ?? [];
}

async function readSettingsMap(db: D1Database): Promise<Record<string, string>> {
  const rows = await readTable<{ key: string; value: string }>(db, "SELECT key, value FROM site_settings ORDER BY key");
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function getCurrentUser(request: Request, env: Env): Promise<Row | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const session = await parseSessionToken(token, env);
  if (!session || !session.userId || Number(session.expiresAt) < Date.now()) return null;
  return env.DB.prepare(
    "SELECT id, email, display_name, active, updated_at FROM admin_users WHERE id = ? AND active = 1"
  )
    .bind(session.userId)
    .first<Row>();
}

function publicResponseSettings(settings: Record<string, string>, env: Env): Record<string, string> {
  return {
    club_name: settings.club_name || env.SITE_NAME || "American Full Fighting Bons en Chablais",
    brand_primary: settings.brand_primary || "AMERICAN FULL FIGHTING",
    brand_secondary: settings.brand_secondary || "BONS EN CHABLAIS",
    site_logo_url: settings.site_logo_url || "/assets/logo-affbc.png",
    favicon_url: settings.favicon_url || "/assets/logo-affbc.png",
    site_public_url: settings.site_public_url || env.SITE_PUBLIC_URL || "",
    meta_description:
      settings.meta_description ||
      `${settings.club_name || env.SITE_NAME || "American Full Fighting Bons en Chablais"} : club premium de full contact et boxe américaine. Entraînements, stages, inscriptions et informations pratiques.`,
    meta_keywords:
      settings.meta_keywords ||
      "american full fighting, boxe américaine, full contact, kick boxing, Bons-en-Chablais, Chablais",
    site_ambient_image:
      settings.site_ambient_image ||
      "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1600&q=80",
    theme_primary_color: settings.theme_primary_color || "#d84a2f",
    theme_secondary_color: settings.theme_secondary_color || "#d6ac54",
    theme_heading_font: settings.theme_heading_font || "'Sora', sans-serif",
    theme_body_font: settings.theme_body_font || "'Inter', sans-serif",
    theme_nav_font: settings.theme_nav_font || settings.theme_body_font || "'Inter', sans-serif",
    theme_button_font: settings.theme_button_font || settings.theme_body_font || "'Inter', sans-serif",
    theme_card_title_font: settings.theme_card_title_font || settings.theme_heading_font || "'Sora', sans-serif",
    theme_card_body_font: settings.theme_card_body_font || settings.theme_body_font || "'Inter', sans-serif",
    nav_club_label: settings.nav_club_label || "Club",
    nav_club_enabled: settings.nav_club_enabled || "1",
    nav_schedule_label: settings.nav_schedule_label || "Séances",
    nav_schedule_enabled: settings.nav_schedule_enabled || "1",
    nav_pricing_label: settings.nav_pricing_label || "Tarifs",
    nav_pricing_enabled: settings.nav_pricing_enabled || "1",
    nav_contact_label: settings.nav_contact_label || "Contact",
    nav_contact_enabled: settings.nav_contact_enabled || "1",
    nav_inscription_label: settings.nav_inscription_label || "Inscription",
    nav_inscription_href: settings.nav_inscription_href || "https://inscription.americanfullfightingbons.fr/",
    nav_inscription_enabled: settings.nav_inscription_enabled || "1",
    nav_calendar_label: settings.nav_calendar_label || "Calendrier",
    nav_calendar_href: settings.nav_calendar_href || "https://calendrier.americanfullfightingbons.fr/",
    nav_calendar_enabled: settings.nav_calendar_enabled || "1",
    nav_shop_label: settings.nav_shop_label || "Boutique",
    nav_shop_href: settings.nav_shop_href || "https://boutique.americanfullfightingbons.fr/",
    nav_shop_enabled: settings.nav_shop_enabled || "1",
    quick_links_cta_label: settings.quick_links_cta_label || "Accéder",
    browser_title: settings.browser_title || settings.club_name || env.SITE_NAME || "American Full Fighting Bons en Chablais",
    hero_kicker: settings.hero_kicker || "",
    hero_title: settings.hero_title || "",
    hero_body: settings.hero_body || "",
    hero_background_image:
      settings.hero_background_image ||
      "https://images.unsplash.com/photo-1549719386-74dfcbf7dbed?auto=format&fit=crop&w=1800&q=80",
    hero_link_inscription_label: settings.hero_link_inscription_label || "Site d'inscription",
    hero_link_inscription_href: settings.hero_link_inscription_href || "https://inscription.americanfullfightingbons.fr/",
    hero_link_inscription_enabled: settings.hero_link_inscription_enabled || "1",
    hero_link_calendar_label: settings.hero_link_calendar_label || "Site calendrier",
    hero_link_calendar_href: settings.hero_link_calendar_href || "https://calendrier.americanfullfightingbons.fr/",
    hero_link_calendar_enabled: settings.hero_link_calendar_enabled || "1",
    hero_link_shop_label: settings.hero_link_shop_label || "Boutique",
    hero_link_shop_href: settings.hero_link_shop_href || "https://boutique.americanfullfightingbons.fr/",
    hero_link_shop_enabled: settings.hero_link_shop_enabled || "1",
    announcement_badge: settings.announcement_badge || "",
    announcement_title: settings.announcement_title || "",
    announcement_body: settings.announcement_body || "",
    contact_email: settings.contact_email || env.CONTACT_EMAIL || "",
    contact_phone: settings.contact_phone || env.CONTACT_PHONE || "",
    contact_address: settings.contact_address || env.CONTACT_ADDRESS || "",
    club_story: settings.club_story || "",
    story_intro:
      settings.story_intro ||
      "American Full Fighting Bons en Chablais réunit apprentissage technique, intensité progressive et esprit de groupe dans une ambiance encadrée.",
    story_card_title: settings.story_card_title || "Le club",
    story_note_label: settings.story_note_label || "Repères",
    story_note_title: settings.story_note_title || "Pour qui ?",
    story_note_body:
      settings.story_note_body ||
      "Cours mixtes, progression suivie, objectifs clairs et séances pensées pour développer technique, condition physique et confiance.",
    hero_primary_label: settings.hero_primary_label || "Préinscription",
    hero_primary_href: settings.hero_primary_href || "https://inscription.americanfullfightingbons.fr/",
    hero_primary_enabled: settings.hero_primary_enabled || "1",
    hero_secondary_label: settings.hero_secondary_label || "Voir le calendrier",
    hero_secondary_href: settings.hero_secondary_href || "https://calendrier.americanfullfightingbons.fr/",
    hero_secondary_enabled: settings.hero_secondary_enabled || "1",
    footer_note: settings.footer_note || "American Full Fighting Bons en Chablais",
    spotlight_date: settings.spotlight_date || "",
    spotlight_title: settings.spotlight_title || "",
    spotlight_body: settings.spotlight_body || "",
    spotlight_intro:
      settings.spotlight_intro ||
      "Les rendez-vous importants de la saison sont mis en avant ici pour rester visibles au premier coup d'oeil.",
    spotlight_background_image:
      settings.spotlight_background_image ||
      "https://images.unsplash.com/photo-1517438984742-1262db08379e?auto=format&fit=crop&w=1800&q=80",
    spotlight_cta_label: settings.spotlight_cta_label || "Voir le calendrier",
    spotlight_cta_href: settings.spotlight_cta_href || "https://calendrier.americanfullfightingbons.fr/",
    spotlight_cta_enabled: settings.spotlight_cta_enabled || "1",
    spotlight_secondary_label: settings.spotlight_secondary_label || "Dossier d'inscription",
    spotlight_secondary_href: settings.spotlight_secondary_href || "https://inscription.americanfullfightingbons.fr/",
    spotlight_secondary_enabled: settings.spotlight_secondary_enabled || "1",
    gallery_intro:
      settings.gallery_intro ||
      "Une sélection d'images pour retrouver l'énergie du club, le rythme des séances et les temps forts de la saison.",
    resources_intro: settings.resources_intro || "",
    equipment_intro: settings.equipment_intro || "",
    sponsors_intro: settings.sponsors_intro || "Merci aux partenaires qui accompagnent le club et soutiennent ses projets.",
    news_intro: settings.news_intro || "Les informations récentes du club restent visibles ici.",
    faq_intro: settings.faq_intro || "Les réponses aux questions les plus fréquentes avant de rejoindre le club.",
    testimonials_intro: settings.testimonials_intro || "Quelques retours de pratiquants et proches du club.",
    google_reviews_enabled: settings.google_reviews_enabled || "1",
    google_place_id: settings.google_place_id || "",
    google_place_query: settings.google_place_query || "American Full Fighting Bons en Chablais",
    google_reviews_min_rating: settings.google_reviews_min_rating || "4",
    google_reviews_cta_label: settings.google_reviews_cta_label || "Voir les avis Google",
    google_reviews_cta_href: settings.google_reviews_cta_href || "",
    schedule_intro:
      settings.schedule_intro ||
      "Des créneaux réguliers pour installer de bons repères techniques et physiques tout au long de la semaine.",
    team_intro:
      settings.team_intro ||
      "Un encadrement identifié, présent sur les séances et engagé dans la progression de chaque pratiquant.",
    pricing_intro_synced: settings.pricing_intro_synced || "Tarifs alignés avec l'inscription en ligne.",
    pricing_intro_local: settings.pricing_intro_local || "Tarifs actuellement affichés par le club.",
    highlights_intro:
      settings.highlights_intro ||
      "Stages, matériel, progression et moments clés de la saison restent accessibles sans alourdir la navigation.",
    sponsor_title: settings.sponsor_title || "Devenez notre mécène",
    sponsor_intro:
      settings.sponsor_intro ||
      "Le soutien des adhérents, proches et partenaires aide le club à mieux équiper ses pratiquants et à accompagner ses projets.",
    sponsor_body: settings.sponsor_body || "",
    sponsor_cta_label: settings.sponsor_cta_label || "Faire un don",
    sponsor_cta_href: settings.sponsor_cta_href || "mailto:fullfightingbons@gmail.com",
    sponsor_checkout_enabled: settings.sponsor_checkout_enabled || "0",
    sponsor_checkout_org_slug: settings.sponsor_checkout_org_slug || "",
    sponsor_checkout_item_name: settings.sponsor_checkout_item_name || "Don à l'association",
    sponsor_checkout_min_amount_eur: settings.sponsor_checkout_min_amount_eur || "5",
    sponsor_checkout_suggested_amounts: settings.sponsor_checkout_suggested_amounts || "20,50,100",
    sponsor_amount_label: settings.sponsor_amount_label || "Montant",
    sponsor_first_name_label: settings.sponsor_first_name_label || "Prénom",
    sponsor_last_name_label: settings.sponsor_last_name_label || "Nom",
    sponsor_email_label: settings.sponsor_email_label || "E-mail",
    contact_intro:
      settings.contact_intro ||
      "Pour une question, une séance d'essai ou une demande sur la saison, le club peut être joint directement ici.",
    contact_map_embed_url:
      settings.contact_map_embed_url || "",
    contact_details_title: settings.contact_details_title || "Coordonnées",
    contact_email_title: settings.contact_email_title || "E-mail",
    contact_phone_title: settings.contact_phone_title || "Téléphone",
    contact_address_title: settings.contact_address_title || "Adresse",
    contact_form_title: settings.contact_form_title || "Envoyer un message",
    contact_name_label: settings.contact_name_label || "Nom",
    contact_email_label: settings.contact_email_label || "E-mail",
    contact_phone_label: settings.contact_phone_label || "Téléphone",
    contact_message_label: settings.contact_message_label || "Message",
    contact_submit_label: settings.contact_submit_label || "Envoyer",
    contact_map_unavailable_label: settings.contact_map_unavailable_label || "Carte indisponible",
    contact_map_title: settings.contact_map_title || "Plan d'accès au club",
    inpi_note: settings.inpi_note || "",
    social_facebook_url: settings.social_facebook_url || "",
    social_instagram_url: settings.social_instagram_url || "",
    social_youtube_url: settings.social_youtube_url || "",
    social_tiktok_url: settings.social_tiktok_url || "",
    social_whatsapp_url: settings.social_whatsapp_url || "",
    footer_legal: settings.footer_legal || "",
    footer_meta: settings.footer_meta || "",
  };
}

async function readSharedPricing(env: Env): Promise<Row[]> {
  if (!env.AFFBC_DB) return [];
  try {
    const keys = [
      "public_inscription_tarif_base",
      "public_inscription_tarif_famille",
      "public_inscription_tarif_pro",
      "public_inscription_pass_region_homme",
      "public_inscription_pass_region_femme",
      "public_inscription_supplement_tenue",
      "public_inscription_tarif_passeport",
    ];
    const placeholders = keys.map(() => "?").join(", ");
    const rows = await readTable<{ cle: string; valeur: string }>(
      env.AFFBC_DB,
      `SELECT cle, valeur FROM club_info WHERE cle IN (${placeholders})`,
      keys
    );
    const map = Object.fromEntries(rows.map((row) => [row.cle, row.valeur]));
    return [
      {
        id: "shared-base",
        title: "Tarif de base",
        price_label: `${Number(map.public_inscription_tarif_base || 250)} €`,
        description: "Cotisation annuelle pour les cours du club.",
        badge: "Saison",
        display_order: 1,
      },
      {
        id: "shared-family",
        title: "Tarif famille",
        price_label: `${Number(map.public_inscription_tarif_famille || 200)} €`,
        description: "Tarif appliqué selon les conditions prévues pour les familles.",
        badge: "Réduction",
        display_order: 2,
      },
      {
        id: "shared-pro",
        title: "Tarif professionnel",
        price_label: `${Number(map.public_inscription_tarif_pro || 125)} €`,
        description: "Forces de l'ordre, pompiers, sécurité et assimilés sur justificatif.",
        badge: "Justificatif",
        display_order: 3,
      },
      {
        id: "shared-pass",
        title: "Pass Région",
        price_label: `${Number(map.public_inscription_pass_region_homme || 30)} € / ${Number(
          map.public_inscription_pass_region_femme || 60
        )} €`,
        description: "Aide possible selon la situation déclarée lors de l'inscription.",
        badge: "Aide",
        display_order: 4,
      },
      {
        id: "shared-kit",
        title: "Tenue et passeport",
        price_label: `${Number(map.public_inscription_supplement_tenue || 40)} € + ${Number(
          map.public_inscription_tarif_passeport || 25
        )} €`,
        description: "Éléments complémentaires selon les besoins de la saison.",
        badge: "Complément",
        display_order: 5,
      },
    ];
  } catch (error) {
    console.warn("Shared pricing unavailable, falling back to local pricing.", error);
    return [];
  }
}

function mergePricing(sharedPricing: Row[], localPricing: Row[]): Row[] {
  if (!sharedPricing.length) {
    return localPricing.map((item) => ({ enabled: 1, ...item }));
  }

  const overrides = new Map(localPricing.map((item) => [String(item.id), item]));
  return sharedPricing
    .map<Row>((item) => {
      const override = overrides.get(String(item.id));
      return { enabled: 1, ...item, ...(override || {}) };
    })
    .sort((a, b) => Number(a.display_order) - Number(b.display_order));
}

function resolvePublicBaseUrl(settings: Record<string, string>, env: Env, request: Request): string {
  const configured = sanitizeUrl(settings.site_public_url || env.SITE_PUBLIC_URL, 300).replace(/\/+$/, "");
  if (configured) return configured;
  const origin = new URL(request.url).origin.replace(/\/+$/, "");
  if (origin.startsWith("https://")) return origin;
  throw new Error("SITE_PUBLIC_URL manquant pour initialiser le checkout HelloAsso.");
}

function getHelloAssoBaseUrl(env: Env): string {
  return env.HELLOASSO_ENV === "sandbox" ? "https://api.helloasso-sandbox.com" : "https://api.helloasso.com";
}

async function fetchHelloAssoAccessToken(env: Env): Promise<string> {
  const clientId = sanitizeText(env.HELLOASSO_CLIENT_ID, 200);
  const clientSecret = sanitizeText(env.HELLOASSO_CLIENT_SECRET, 240);
  if (!clientId || !clientSecret) {
    throw new Error("Configuration HelloAsso incomplète côté serveur.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const response = await fetch(`${getHelloAssoBaseUrl(env)}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok || !payload.access_token) {
    throw new Error(String(payload.error_description || payload.message || "Authentification HelloAsso impossible."));
  }
  return String(payload.access_token);
}

async function createHelloAssoCheckoutIntent(
  env: Env,
  organizationSlug: string,
  accessToken: string,
  values: Row
): Promise<Row> {
  const response = await fetch(`${getHelloAssoBaseUrl(env)}/v5/organizations/${encodeURIComponent(organizationSlug)}/checkout-intents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(values),
  });
  const payload = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) {
    const details = Array.isArray(payload.errors)
      ? payload.errors.map((item) => String((item as Row).message || "")).filter(Boolean).join(" ")
      : "";
    throw new Error(details || String(payload.message || payload.title || "Création du checkout HelloAsso impossible."));
  }
  return payload;
}

async function getHelloAssoCheckoutIntent(
  env: Env,
  organizationSlug: string,
  accessToken: string,
  checkoutIntentId: string
): Promise<Row> {
  const response = await fetch(
    `${getHelloAssoBaseUrl(env)}/v5/organizations/${encodeURIComponent(organizationSlug)}/checkout-intents/${encodeURIComponent(
      checkoutIntentId
    )}`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    }
  );
  const payload = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) {
    throw new Error(String(payload.message || payload.title || "Lecture du checkout HelloAsso impossible."));
  }
  return payload;
}

function normalizeGoogleReview(review: Row, index: number, minRating: number): Row | null {
  const author = (review.authorAttribution || {}) as Row;
  const text = (review.text || review.originalText || {}) as Row;
  const rating = Number(review.rating || 0);
  const quote = sanitizeText(text.text || "", 600);
  if (!quote || rating < minRating) return null;
  return {
    id: sanitizeText(review.name || `google-review-${index + 1}`, 160),
    author_name: sanitizeText(author.displayName || "Avis Google", 120),
    role_label: `Google · ${"★".repeat(Math.max(1, Math.min(5, Math.round(rating))))}`,
    quote,
    image_url: sanitizeUrl(author.photoUri || "", 500),
    image_fit: "cover",
    enabled: 1,
    display_order: index + 1,
    rating,
    source: "google",
    published_at: sanitizeText(review.publishTime || "", 80),
    relative_time: sanitizeText(review.relativePublishTimeDescription || "", 120),
  };
}

async function findGooglePlaceId(apiKey: string, query: string): Promise<string> {
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id",
    },
    body: JSON.stringify({ textQuery: query, languageCode: "fr", regionCode: "FR" }),
  });
  if (!response.ok) return "";
  const payload = (await response.json().catch(() => ({}))) as Row;
  const places = Array.isArray(payload.places) ? (payload.places as Row[]) : [];
  return sanitizeText(places[0]?.id, 160);
}

async function readGoogleReviews(settings: Record<string, string>, env: Env): Promise<Row[]> {
  if (!parseBooleanSetting(settings.google_reviews_enabled)) return [];
  const apiKey = sanitizeText(env.GOOGLE_PLACES_API_KEY, 260);
  if (!apiKey) return [];

  let placeId = sanitizeText(settings.google_place_id, 180);
  const query = sanitizeText(settings.google_place_query, 220);
  const minRating = Math.max(1, Math.min(5, Number(settings.google_reviews_min_rating) || 4));
  const cacheKey = `${placeId || query}:${minRating}`;
  const cached = googleReviewsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  if (!placeId && query) placeId = await findGooglePlaceId(apiKey, query);
  if (!placeId) return [];

  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=fr&regionCode=FR`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "id,displayName,googleMapsUri,rating,userRatingCount,reviews",
    },
  });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => ({}))) as Row;
  const reviews = Array.isArray(payload.reviews) ? (payload.reviews as Row[]) : [];
  const normalized = reviews
    .map((review, index) => normalizeGoogleReview(review, index, minRating))
    .filter((review): review is Row => !!review);

  googleReviewsCache.set(cacheKey, { expiresAt: Date.now() + GOOGLE_REVIEWS_CACHE_TTL_MS, data: normalized });
  return normalized;
}

async function getBootstrap(env: Env): Promise<Row> {
  const settings = publicResponseSettings(await readSettingsMap(env.DB), env);
  const [sections, schedule, team, highlights, gallery, links, customButtons, customBlocks, resources, equipment, sponsors, news, faq, manualTestimonials, media, fallbackPricing, sharedPricing] = await Promise.all([
    readTable(env.DB, "SELECT * FROM landing_sections ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM schedule_slots ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM team_members ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM highlights ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM gallery_items ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM partner_links ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM custom_buttons ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM custom_blocks ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM resource_cards ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM equipment_items ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM sponsor_partners ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM news_items ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM faq_items ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM testimonials ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM media_assets ORDER BY display_order, id"),
    readTable(env.DB, "SELECT * FROM pricing_plans ORDER BY display_order, id"),
    readSharedPricing(env),
  ]);
  const googleTestimonials = await readGoogleReviews(settings, env).catch(() => []);
  const testimonials = googleTestimonials.length ? googleTestimonials : manualTestimonials;
  return {
    sitePublicUrl: settings.site_public_url,
    site: {
      name: settings.club_name,
      browserTitle: settings.browser_title,
      brandPrimary: settings.brand_primary,
      brandSecondary: settings.brand_secondary,
      email: settings.contact_email,
      phone: settings.contact_phone,
      address: settings.contact_address,
      footerNote: settings.footer_note,
    },
    navigation: {
      clubLabel: settings.nav_club_label,
      clubEnabled: parseBooleanSetting(settings.nav_club_enabled),
      scheduleLabel: settings.nav_schedule_label,
      scheduleEnabled: parseBooleanSetting(settings.nav_schedule_enabled),
      pricingLabel: settings.nav_pricing_label,
      pricingEnabled: parseBooleanSetting(settings.nav_pricing_enabled),
      contactLabel: settings.nav_contact_label,
      contactEnabled: parseBooleanSetting(settings.nav_contact_enabled),
      inscriptionLabel: settings.nav_inscription_label,
      inscriptionHref: settings.nav_inscription_href,
      inscriptionEnabled: parseBooleanSetting(settings.nav_inscription_enabled),
      calendarLabel: settings.nav_calendar_label,
      calendarHref: settings.nav_calendar_href,
      calendarEnabled: parseBooleanSetting(settings.nav_calendar_enabled),
      shopLabel: settings.nav_shop_label,
      shopHref: settings.nav_shop_href,
      shopEnabled: parseBooleanSetting(settings.nav_shop_enabled),
    },
    labels: {
      quickLinkCta: settings.quick_links_cta_label,
      contactEmailTitle: settings.contact_email_title,
      contactPhoneTitle: settings.contact_phone_title,
      contactAddressTitle: settings.contact_address_title,
      mapUnavailable: settings.contact_map_unavailable_label,
      contactMapTitle: settings.contact_map_title,
      sponsorAmount: settings.sponsor_amount_label,
      sponsorFirstName: settings.sponsor_first_name_label,
      sponsorLastName: settings.sponsor_last_name_label,
      sponsorEmail: settings.sponsor_email_label,
    },
    design: {
      siteAmbientImage: settings.site_ambient_image,
      heroBackgroundImage: settings.hero_background_image,
      spotlightBackgroundImage: settings.spotlight_background_image,
      primaryColor: settings.theme_primary_color,
      secondaryColor: settings.theme_secondary_color,
      headingFont: settings.theme_heading_font,
      bodyFont: settings.theme_body_font,
      navFont: settings.theme_nav_font,
      buttonFont: settings.theme_button_font,
      cardTitleFont: settings.theme_card_title_font,
      cardBodyFont: settings.theme_card_body_font,
      logoUrl: settings.site_logo_url,
      faviconUrl: settings.favicon_url,
    },
    meta: {
      description: settings.meta_description,
      keywords: settings.meta_keywords,
    },
    hero: {
      kicker: settings.hero_kicker,
      title: settings.hero_title,
      body: settings.hero_body,
      primaryLabel: settings.hero_primary_label,
      primaryHref: settings.hero_primary_href,
      primaryEnabled: parseBooleanSetting(settings.hero_primary_enabled),
      secondaryLabel: settings.hero_secondary_label,
      secondaryHref: settings.hero_secondary_href,
      secondaryEnabled: parseBooleanSetting(settings.hero_secondary_enabled),
      utilityLinks: [
        { label: settings.hero_link_inscription_label, href: settings.hero_link_inscription_href, enabled: parseBooleanSetting(settings.hero_link_inscription_enabled) },
        { label: settings.hero_link_calendar_label, href: settings.hero_link_calendar_href, enabled: parseBooleanSetting(settings.hero_link_calendar_enabled) },
        { label: settings.hero_link_shop_label, href: settings.hero_link_shop_href, enabled: parseBooleanSetting(settings.hero_link_shop_enabled) },
      ],
    },
    announcement: {
      badge: settings.announcement_badge,
      title: settings.announcement_title,
      body: settings.announcement_body,
    },
    story: settings.club_story,
    storyPanel: {
      intro: settings.story_intro,
      cardTitle: settings.story_card_title,
      noteLabel: settings.story_note_label,
      noteTitle: settings.story_note_title,
      noteBody: settings.story_note_body,
    },
    spotlight: {
      intro: settings.spotlight_intro,
      date: settings.spotlight_date,
      title: settings.spotlight_title,
      body: settings.spotlight_body,
      primaryLabel: settings.spotlight_cta_label,
      primaryHref: settings.spotlight_cta_href,
      primaryEnabled: parseBooleanSetting(settings.spotlight_cta_enabled),
      secondaryLabel: settings.spotlight_secondary_label,
      secondaryHref: settings.spotlight_secondary_href,
      secondaryEnabled: parseBooleanSetting(settings.spotlight_secondary_enabled),
    },
    galleryIntro: settings.gallery_intro,
    resourcesIntro: settings.resources_intro,
    equipmentIntro: settings.equipment_intro,
    sponsorsIntro: settings.sponsors_intro,
    newsIntro: settings.news_intro,
    faqIntro: settings.faq_intro,
    testimonialsIntro: settings.testimonials_intro,
    googleReviews: {
      enabled: parseBooleanSetting(settings.google_reviews_enabled),
      configured: !!sanitizeText(env.GOOGLE_PLACES_API_KEY, 260),
      source: googleTestimonials.length ? "google" : "manual",
      placeId: settings.google_place_id,
      query: settings.google_place_query,
      minRating: settings.google_reviews_min_rating,
      ctaLabel: settings.google_reviews_cta_label,
      ctaHref: settings.google_reviews_cta_href,
    },
    scheduleIntro: settings.schedule_intro,
    teamIntro: settings.team_intro,
    pricingIntroSynced: settings.pricing_intro_synced,
    pricingIntroLocal: settings.pricing_intro_local,
    highlightsIntro: settings.highlights_intro,
    sponsor: {
      intro: settings.sponsor_intro,
      title: settings.sponsor_title,
      body: settings.sponsor_body,
      ctaLabel: settings.sponsor_cta_label,
      ctaHref: settings.sponsor_cta_href,
      checkoutEnabled:
        parseBooleanSetting(settings.sponsor_checkout_enabled) &&
        !!sanitizeText(settings.sponsor_checkout_org_slug, 160) &&
        !!sanitizeText(env.HELLOASSO_CLIENT_ID, 200) &&
        !!sanitizeText(env.HELLOASSO_CLIENT_SECRET, 200),
      checkoutMinAmountEur: settings.sponsor_checkout_min_amount_eur,
      checkoutSuggestedAmounts: settings.sponsor_checkout_suggested_amounts
        .split(",")
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((item) => Number.isFinite(item) && item > 0)
        .slice(0, 6),
      checkoutItemName: settings.sponsor_checkout_item_name,
      checkoutOrganizationSlug: settings.sponsor_checkout_org_slug,
    },
    contactIntro: settings.contact_intro,
    contactForm: {
      mapEmbedUrl: settings.contact_map_embed_url,
      detailsTitle: settings.contact_details_title,
      formTitle: settings.contact_form_title,
      nameLabel: settings.contact_name_label,
      emailLabel: settings.contact_email_label,
      phoneLabel: settings.contact_phone_label,
      messageLabel: settings.contact_message_label,
      submitLabel: settings.contact_submit_label,
    },
    social: {
      facebookUrl: settings.social_facebook_url,
      instagramUrl: settings.social_instagram_url,
      youtubeUrl: settings.social_youtube_url,
      tiktokUrl: settings.social_tiktok_url,
      whatsappUrl: settings.social_whatsapp_url,
    },
    footer: {
      legal: settings.footer_legal,
      meta: settings.footer_meta,
    },
    inpiNote: settings.inpi_note,
    sections,
    schedule,
    team,
    highlights,
    gallery,
    links,
    customButtons,
    customBlocks,
    resources,
    equipment,
    sponsors,
    news,
    faq,
    testimonials,
    media,
    pricing: mergePricing(sharedPricing, fallbackPricing),
    pricingSource: sharedPricing.length ? "gestion" : "local",
  };
}

async function handleContact(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return error("Le contenu doit être envoyé en JSON.");
  const body = (await request.json()) as Row;
  const fullName = sanitizeText(body.fullName, 120);
  const email = sanitizeText(body.email, 180);
  const phone = sanitizeText(body.phone, 40);
  const message = sanitizeText(body.message, 2500);
  const website = sanitizeText(body.website, 120);
  if (website) return ok({ spam: true });
  if (fullName.length < 3) return error("Le nom est trop court.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error("Adresse e-mail invalide.");
  if (message.length < 10) return error("Le message est trop court.");

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const ua = sanitizeText(request.headers.get("user-agent"), 255);
  const ipHashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const ipHash = [...new Uint8Array(ipHashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(
    `INSERT INTO contact_messages (full_name, email, phone, message, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(fullName, email, phone, message, ipHash, ua)
    .run();

  const brevoKey = sanitizeText(env.BREVO_API_KEY, 300);
  const fromEmail = sanitizeText(env.CONTACT_FORM_FROM_EMAIL, 180) || "contact@americanfullfightingbons.fr";
  const toEmail = sanitizeText(env.CONTACT_FORM_TO_EMAIL, 180) || sanitizeText(env.CONTACT_EMAIL, 180) || "fullfightingbons@gmail.com";
  if (brevoKey) {
    const clubName = sanitizeText(env.SITE_NAME, 120) || "American Full Fighting Bons en Chablais";
    const phoneLine = phone ? `Téléphone : ${phone}\n` : "";
    const emailPayload = {
      sender: { email: fromEmail, name: clubName },
      to: [{ email: toEmail, name: clubName }],
      replyTo: { email, name: fullName },
      subject: `[Contact site] ${fullName}`,
      textContent:
        `Nouveau message depuis le site ${clubName}\n\n` +
        `Nom : ${fullName}\n` +
        `E-mail : ${email}\n` +
        phoneLine +
        `Message :\n${message}\n`,
      htmlContent:
        `<p><strong>Nouveau message depuis le site ${escapeHtmlText(clubName)}</strong></p>` +
        `<p><strong>Nom :</strong> ${escapeHtmlText(fullName)}<br>` +
        `<strong>E-mail :</strong> ${escapeHtmlText(email)}<br>` +
        `${phone ? `<strong>Téléphone :</strong> ${escapeHtmlText(phone)}<br>` : ""}` +
        `</p><p><strong>Message :</strong></p><p>${escapeHtmlText(message).replace(/\n/g, "<br>")}</p>`,
    };

    const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": brevoKey,
      },
      body: JSON.stringify(emailPayload),
    });
    if (!brevoResponse.ok) {
      const details = await brevoResponse.text();
      console.error("Brevo send failed", brevoResponse.status, details);
    }
  }

  return ok({ message: "Votre message a bien été enregistré. Nous vous recontacterons rapidement." });
}

async function handleDonationCheckout(request: Request, env: Env): Promise<Response> {
  const settings = publicResponseSettings(await readSettingsMap(env.DB), env);
  const donationEnabled = parseBooleanSetting(settings.sponsor_checkout_enabled);
  const organizationSlug = sanitizeText(settings.sponsor_checkout_org_slug, 160);
  if (!donationEnabled || !organizationSlug) {
    return error("Le module de don n'est pas activé.", 400);
  }

  const payload = (await request.json()) as Row;
  const firstName = sanitizeText(payload.firstName, 120);
  const lastName = sanitizeText(payload.lastName, 120);
  const email = sanitizeEmail(payload.email, 180);
  const amountCents = Number.parseInt(String(payload.amountCents || ""), 10);
  const minAmountEur = Number.parseInt(String(settings.sponsor_checkout_min_amount_eur || "5"), 10);
  const minAmountCents = (Number.isFinite(minAmountEur) && minAmountEur > 0 ? minAmountEur : 5) * 100;

  if (firstName.length < 2) return error("Le prénom est trop court.");
  if (lastName.length < 2) return error("Le nom est trop court.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error("Adresse e-mail invalide.");
  if (!Number.isFinite(amountCents) || amountCents < minAmountCents) {
    return error(`Le don minimum est de ${Math.round(minAmountCents / 100)} €.`);
  }

  const baseUrl = resolvePublicBaseUrl(settings, env, request);
  const accessToken = await fetchHelloAssoAccessToken(env);
  const checkout = await createHelloAssoCheckoutIntent(env, organizationSlug, accessToken, {
    totalAmount: amountCents,
    initialAmount: amountCents,
    itemName: sanitizeText(settings.sponsor_checkout_item_name, 250) || "Don à l'association",
    backUrl: `${baseUrl}/?ha_checkout=back#don`,
    errorUrl: `${baseUrl}/?ha_checkout=error#don`,
    returnUrl: `${baseUrl}/?ha_checkout=return#don`,
    containsDonation: true,
    payer: {
      firstName,
      lastName,
      email,
      country: "FRA",
    },
    metadata: {
      source: "site-americanfullfightingbons",
      email,
      amountCents,
    },
  });

  return ok({
    checkoutIntentId: checkout.id,
    redirectUrl: checkout.redirectUrl,
  });
}

async function handleDonationCheckoutStatus(request: Request, env: Env): Promise<Response> {
  const settings = publicResponseSettings(await readSettingsMap(env.DB), env);
  const organizationSlug = sanitizeText(settings.sponsor_checkout_org_slug, 160);
  if (!organizationSlug) return error("Organisation HelloAsso non configurée.", 400);

  const checkoutIntentId = sanitizeText(new URL(request.url).searchParams.get("intentId"), 60);
  if (!checkoutIntentId) return error("Identifiant du checkout requis.");

  const accessToken = await fetchHelloAssoAccessToken(env);
  const checkout = await getHelloAssoCheckoutIntent(env, organizationSlug, accessToken, checkoutIntentId);
  return ok({
    id: checkout.id,
    redirectUrl: checkout.redirectUrl,
    order: checkout.order,
    metadata: checkout.metadata,
  });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const loginIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await checkLoginRateLimit(loginIp, env))) {
    return error("Trop de tentatives. Réessayez dans 15 minutes.", 429, request);
  }
  const payload = (await request.json()) as Row;
  const email = sanitizeText(payload.email, 190).toLowerCase();
  const password = String(payload.password || "");
  if (!email || !password) return error("Email et mot de passe requis.", 400, request);
  const user = await env.DB.prepare(
    "SELECT * FROM admin_users WHERE email = ? AND active = 1 LIMIT 1"
  )
    .bind(email)
    .first<Row>();
  if (!user) return error("Identifiants invalides.", 401, request);
  if (!(await verifyPassword(password, user.password_hash))) return error("Identifiants invalides.", 401, request);

  // Connexion réussie : réinitialiser le rate limiter
  await resetLoginRateLimit(loginIp, env);

  const token = await createSessionToken(
    { userId: String(user.id), expiresAt: Date.now() + SESSION_TTL_MS },
    env
  );
  const response = ok({
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
    },
  }, {}, request);
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}; SameSite=Lax${env.ENV !== "dev" ? "; Secure" : ""}`
  );
  return response;
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(request, env);
  if (!user) return error("Unauthorized", 401);
  return ok({ user });
}

async function handleLogout(env: Env): Promise<Response> {
  const response = ok({ done: true });
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${env.ENV !== "dev" ? "; Secure" : ""}`
  );
  return response;
}

async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const user = await getCurrentUser(request, env);
  if (!user) return error("Unauthorized", 401);
  const payload = (await request.json()) as Row;
  const currentPassword = String(payload.currentPassword || "");
  const nextPassword = String(payload.nextPassword || "");
  if (!currentPassword || !nextPassword) return error("Mot de passe actuel et nouveau requis.");
  if (nextPassword.length < 8) return error("Le nouveau mot de passe doit contenir au moins 8 caractères.");
  const fullUser = await env.DB.prepare("SELECT * FROM admin_users WHERE id = ? LIMIT 1").bind(user.id).first<Row>();
  if (!fullUser || !(await verifyPassword(currentPassword, fullUser.password_hash))) {
    return error("Mot de passe actuel incorrect.", 401);
  }
  const nextHash = await hashPassword(nextPassword);
  await env.DB.prepare(
    "UPDATE admin_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?"
  )
    .bind(nextHash, user.id)
    .run();
  return ok({ done: true });
}

async function requireAdmin(request: Request, env: Env): Promise<Row> {
  const user = (await getCurrentUser(request, env)) ?? (await getUserFromBearer(request, env));
  if (!user) throw new Error("Unauthorized");
  return user;
}

function sanitizeEditableValues(table: keyof typeof EDITABLE_TABLES, input: Row): Row {
  const config = EDITABLE_TABLES[table];
  const next: Row = {};
  for (const key of config.allowedColumns) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      next[key] = normalizeDbValue(input[key]);
    }
  }
  return next;
}

async function adminBootstrap(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  const [bootstrap, messages] = await Promise.all([
    getBootstrap(env),
    readTable(env.DB, "SELECT id, full_name, email, phone, message, status, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 50"),
  ]);
  return ok({
    user,
    ...bootstrap,
    messages,
  });
}

async function handleAdminSave(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const payload = (await request.json()) as Row;
  const table = String(payload.table || "") as keyof typeof EDITABLE_TABLES;
  const action = String(payload.action || "");

  // Traitement mark-message en priorité (pas de table nécessaire)
  if (action === "mark-message") {
    const id = payload.id;
    const status = sanitizeText(payload.status, 30);
    if (!id) return error("Identifiant requis.");
    const allowedStatuses = ["new", "read", "done"];
    if (!allowedStatuses.includes(status)) return error("Statut invalide.");
    await env.DB.prepare("UPDATE contact_messages SET status = ? WHERE id = ?").bind(status, id).run();
    return ok({ saved: true });
  }

  if (!table || !Object.prototype.hasOwnProperty.call(EDITABLE_TABLES, table)) return error("Table non autorisée.", 400);

  if (action === "upsert") {
    const values = sanitizeEditableValues(table, (payload.values || {}) as Row);
    const config = EDITABLE_TABLES[table];
    const columns = Object.keys(values);
    if (!columns.length) return error("Aucune valeur à enregistrer.");
    const primaryValue = values[config.primaryKey];

    if (primaryValue !== undefined && primaryValue !== null && primaryValue !== "") {
      const existing = await env.DB.prepare(
        `SELECT ${quoteIdentifier(config.primaryKey)} FROM ${quoteIdentifier(table)}
         WHERE ${quoteIdentifier(config.primaryKey)} = ? LIMIT 1`
      )
        .bind(primaryValue)
        .first<Row>();

      if (existing) {
        const updateColumns = columns.filter((column) => column !== config.primaryKey);
        if (updateColumns.length) {
          const assignments = updateColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ");
          await env.DB.prepare(
            `UPDATE ${quoteIdentifier(table)} SET ${assignments}
             WHERE ${quoteIdentifier(config.primaryKey)} = ?`
          )
            .bind(...updateColumns.map((column) => values[column]), primaryValue)
            .run();
        }
        return ok({ saved: true });
      }
    }

    const bindings = columns.map((column) => values[column]);
    const quotedColumns = columns.map((column) => quoteIdentifier(column)).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    await env.DB.prepare(
      `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders})`
    )
      .bind(...bindings)
      .run();
    return ok({ saved: true });
  }

  if (action === "delete") {
    const id = payload.id;
    if (id === undefined || id === null || id === "") return error("Identifiant requis.");
    const config = EDITABLE_TABLES[table];
    await env.DB.prepare(
      `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(config.primaryKey)} = ?`
    )
      .bind(id)
      .run();
    return ok({ deleted: true });
  }

  return error("Action non supportée.");
}

// ─── Login pour le Visual Builder (password seul → Bearer token) ─────────────

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  const loginIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await checkLoginRateLimit(loginIp, env))) {
    return error("Trop de tentatives. Réessayez dans 15 minutes.", 429);
  }
  const payload = (await request.json()) as Row;
  const password = String(payload.password || "");
  if (!password) return error("Mot de passe requis.");

  // Cherche n'importe quel admin actif dont le mot de passe correspond
  const users = await readTable<Row>(
    env.DB,
    "SELECT * FROM admin_users WHERE active = 1"
  );
  let matched: Row | null = null;
  for (const user of users) {
    if (await verifyPassword(password, user.password_hash)) {
      matched = user;
      break;
    }
  }
  if (!matched) return error("Mot de passe incorrect.", 401);

  // Réutilise le même mécanisme HMAC que les sessions cookie,
  // mais on le renvoie en tant que token Bearer (JSON).
  const token = await createSessionToken(
    { userId: String(matched.id), expiresAt: Date.now() + SESSION_TTL_MS },
    env
  );
  return ok({ token });
}

// ─── Vérification Bearer token (pour les routes /api/admin/*) ────────────────

async function getUserFromBearer(request: Request, env: Env): Promise<Row | null> {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token || token === "dev") return null;
  const session = await parseSessionToken(token, env);
  if (!session || !session.userId || Number(session.expiresAt) < Date.now()) return null;
  return env.DB.prepare(
    "SELECT id, email, display_name, active FROM admin_users WHERE id = ? AND active = 1"
  )
    .bind(session.userId)
    .first<Row>();
}

async function routeApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method === "OPTIONS") return withHeaders(new Response(null, { status: 204 }), request);

  if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
    const response = ok({ date: new Date().toISOString() }, {}, request);
    return request.method === "HEAD" ? new Response(null, response) : response;
  }
  if (pathname === "/api/version" && (request.method === "GET" || request.method === "HEAD")) {
    const response = ok({ service: "site-americanfullfightinbons", version: "1.0.0" }, {}, request);
    return request.method === "HEAD" ? new Response(null, response) : response;
  }
  if (pathname === "/api/bootstrap" && request.method === "GET") {
    return ok(await getBootstrap(env), {}, request);
  }
  if (pathname === "/api/contact" && request.method === "POST") {
    return handleContact(request, env);
  }
  if (pathname === "/api/donations/checkout" && request.method === "POST") {
    return handleDonationCheckout(request, env);
  }
  if (pathname === "/api/donations/checkout-status" && request.method === "GET") {
    return handleDonationCheckoutStatus(request, env);
  }
  if (pathname === "/api/auth/login" && request.method === "POST") {
    return handleLogin(request, env);
  }
  if (pathname === "/api/auth/session" && request.method === "GET") {
    return handleSession(request, env);
  }
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    return handleLogout(env);
  }
  if (pathname === "/api/auth/password" && request.method === "POST") {
    return handleChangePassword(request, env);
  }
  // Visual Builder login (password seul, retourne un Bearer token)
  if (pathname === "/api/admin/login" && request.method === "POST") {
    return handleAdminLogin(request, env);
  }

  // Routes admin : accepte aussi bien le cookie de session que le Bearer token
  if (pathname === "/api/admin/bootstrap" && request.method === "GET") {
    // Tente d'abord le cookie, puis le Bearer token
    const cookieUser = await getCurrentUser(request, env);
    if (!cookieUser) {
      const bearerUser = await getUserFromBearer(request, env);
      if (!bearerUser) return error("Unauthorized", 401, request);
    }
    return adminBootstrap(request, env);
  }
  if (pathname === "/api/admin/content" && request.method === "POST") {
    return handleAdminSave(request, env);
  }

  // ─── Routes publiques du formulaire d'inscription ───────────────────────────
  if (pathname === "/api/public/adherent-eligibility" && request.method === "GET") {
    return withHeaders(await adherentEligibilityHandler({ request, env }), request);
  }
  if ((pathname === "/api/public/inscription" || pathname === "/api/public/inscription/") && request.method === "POST") {
    return withHeaders(await inscriptionSubmitHandler({ request, env }), request);
  }
  if (pathname === "/api/public/payment/helloasso/status" && request.method === "GET") {
    return withHeaders(await helloAssoStatusHandler({ request, env }), request);
  }
  if (pathname === "/api/public/payment/helloasso/notification" && request.method === "POST") {
    return withHeaders(await helloAssoNotificationHandler({ request, env }), request);
  }
  if (pathname === "/api/public/tarifs" && request.method === "GET") {
    return withHeaders(await tarifsHandler({ request, env }), request);
  }

  return error("Not found", 404, request);
}

// ── Exports pour les tests unitaires (fonctions pures uniquement) ──
export {
  checkLoginRateLimit,
  parseCookies,
  quoteIdentifier,
  toBase64Url,
  fromBase64Url,
  secureEquals,
  sanitizeText,
  sanitizeEmail,
  sanitizeUrl,
  normalizeDbValue,
  escapeHtmlText,
  parseBooleanSetting,
  mergePricing,
  normalizeGoogleReview,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/inscription-config" && request.method === "GET") {
      try {
        return withHeaders(await inscriptionConfigHandler({ request, env }), request);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Erreur interne";
        return error(message, 500, request);
      }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, url.pathname);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Erreur interne";
        if (message === "Unauthorized") return error(message, 401, request);
        return error(message, 500, request);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
