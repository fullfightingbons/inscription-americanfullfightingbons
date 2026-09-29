import { badRequest, json } from "../../_lib/data.js";

const POSTAL_CODE_RE = /^\d{5}$/;
const UPSTREAM_TIMEOUT_MS = 4000;

// Recherche de commune(s) à partir d'un code postal, pour suggérer/préremplir
// la ville à l'étape "Coordonnées" du formulaire (un code postal seul ne
// suffit pas toujours à deviner la commune : certains en couvrent plusieurs,
// ex. 74200 = Thonon-les-Bains, Anthy-sur-Léman, Margencel...).
//
// Le Worker fait la requête à la place du navigateur, pas seulement par
// confort : la CSP de ce site (`connect-src 'self'`, cf. src/index.ts)
// interdit volontairement au JavaScript embarqué de contacter un domaine
// tiers, pour limiter la surface d'exfiltration si le site était un jour
// compromis. Ce point d'entrée ne relaie donc que des noms de commune,
// jamais aucune donnée saisie par la personne qui s'inscrit.
//
// Dégrade toujours vers `{ communes: [] }` en cas de souci côté fournisseur
// (indisponible, lent, réponse inattendue) : une suggestion manquante ne
// doit jamais empêcher de terminer son inscription, la ville reste
// saisissable à la main.
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const codePostal = String(url.searchParams.get("cp") || "").trim();

  if (!POSTAL_CODE_RE.test(codePostal)) {
    return badRequest("Code postal invalide (5 chiffres attendus).", 400);
  }

  const upstream = new URL("https://geo.api.gouv.fr/communes");
  upstream.searchParams.set("codePostal", codePostal);
  upstream.searchParams.set("fields", "nom");
  upstream.searchParams.set("format", "json");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(upstream.toString(), { signal: controller.signal });
    if (!response.ok) {
      return json({ data: { communes: [] }, error: null }, { headers: { "Cache-Control": "no-store" } });
    }

    const rows = await response.json();
    const communes = Array.isArray(rows)
      ? [...new Set(rows.map((r) => String(r?.nom || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"))
      : [];

    return json(
      { data: { communes }, error: null },
      // 24h : la commune associée à un code postal ne change pour ainsi
      // dire jamais — épargne des allers-retours inutiles vers le
      // fournisseur pour les codes postaux les plus consultés.
      { headers: { "Cache-Control": "public, max-age=86400" } },
    );
  } catch (error) {
    // Timeout (AbortController), réseau coupé, JSON invalide...
    return json({ data: { communes: [] }, error: null }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timeout);
  }
}
