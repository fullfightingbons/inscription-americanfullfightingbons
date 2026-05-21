import { badRequest } from "./data.js";

const DEFAULT_BOUTIQUE_API_BASE = "https://boutique.americanfullfightingbons.fr";

function getBoutiqueApiBase(env) {
  return String(env.BOUTIQUE_API_BASE_URL || DEFAULT_BOUTIQUE_API_BASE).replace(/\/+$/, "");
}

function normalizeSize(value) {
  return String(value || "").trim().toUpperCase();
}

function detectClothingKind(product) {
  const name = String(product?.name || "").toLowerCase();
  if (name.includes("t-shirt") || name.includes("tshirt")) return "tshirt";
  if (name.includes("pantalon")) return "pantalon";
  return null;
}

function normalizeBoutiqueProduct(product) {
  const kind = detectClothingKind(product);
  if (!kind) return null;
  const sizeStocks = product?.size_stocks && typeof product.size_stocks === "object"
    ? product.size_stocks
    : {};
  const sizes = Array.isArray(product?.sizes) && product.sizes.length
    ? product.sizes.map(normalizeSize)
    : Object.keys(sizeStocks).map(normalizeSize);
  const stockBySize = Object.fromEntries(
    Object.entries(sizeStocks).map(([size, qty]) => [normalizeSize(size), Math.max(0, Number(qty) || 0)]),
  );
  return {
    kind,
    productId: Number(product.id),
    name: String(product.name || ""),
    stock: Math.max(0, Number(product.stock) || 0),
    sizes: sizes.filter(Boolean),
    stockBySize,
  };
}

function normalizeGenericBoutiqueProduct(product) {
  const sizeStocks = product?.size_stocks && typeof product.size_stocks === "object"
    ? product.size_stocks
    : {};
  const sizes = Array.isArray(product?.sizes) && product.sizes.length
    ? product.sizes.map(normalizeSize)
    : Object.keys(sizeStocks).map(normalizeSize);
  const stockBySize = Object.fromEntries(
    Object.entries(sizeStocks).map(([size, qty]) => [normalizeSize(size), Math.max(0, Number(qty) || 0)]),
  );
  return {
    productId: Number(product.id),
    name: String(product.name || ""),
    description: String(product.description || ""),
    price: Math.max(0, Number(product.price) || 0),
    stock: Math.max(0, Number(product.stock) || 0),
    sizes: sizes.filter(Boolean),
    stockBySize,
  };
}

async function fetchBoutiqueProducts(env) {
  const response = await fetch(`${getBoutiqueApiBase(env)}/api/products`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error("Catalogue boutique indisponible");
  }
  return payload.map(normalizeGenericBoutiqueProduct).filter((product) => Number.isFinite(product.productId));
}

async function fetchBoutiqueClothingStock(env) {
  const response = await fetch(`${getBoutiqueApiBase(env)}/api/products?category=tenues`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error("Stock boutique indisponible");
  }
  const byKind = {};
  for (const rawProduct of payload) {
    const normalized = normalizeBoutiqueProduct(rawProduct);
    if (normalized) byKind[normalized.kind] = normalized;
  }
  return {
    tshirt: byKind.tshirt || null,
    pantalon: byKind.pantalon || null,
  };
}

function getAvailableSizeStock(stock, kind, size) {
  const entry = stock?.[kind];
  if (!entry) return 0;
  return Math.max(0, Number(entry.stockBySize?.[normalizeSize(size)] ?? 0));
}

function buildClothingSyncItems(stock, clothingOrder = {}) {
  const items = [];
  for (const kind of ["tshirt", "pantalon"]) {
    const qty = Math.max(0, Number(clothingOrder?.[`${kind}Qty`] || 0));
    const size = normalizeSize(clothingOrder?.[`${kind}Size`] || "");
    const product = stock?.[kind];
    if (!qty) continue;
    if (!product?.productId || !size) {
      throw new Error(`Produit boutique introuvable pour ${kind}`);
    }
    items.push({
      product_id: product.productId,
      quantity: qty,
      size,
    });
  }
  return items;
}

function assertAdditionalOrderItemsStock(boutiqueProducts, orderItems = []) {
  const catalog = new Map((boutiqueProducts || []).map((product) => [Number(product.productId), product]));
  for (const item of orderItems || []) {
    const quantity = Math.max(0, Number(item?.quantity || 0));
    if (!quantity || String(item?.source || "") !== "boutique") continue;
    const productId = Number(item?.boutiqueProductId || 0);
    const product = catalog.get(productId);
    if (!product) throw new Error(`Produit boutique introuvable pour ${item?.name || item?.id || productId}`);
    if (item?.requiresSize || product.sizes?.length) {
      const size = normalizeSize(item?.size || "");
      if (!size) throw new Error(`Taille manquante pour ${product.name}`);
      const available = Math.max(0, Number(product.stockBySize?.[size] ?? 0));
      if (available < quantity) throw new Error(`Stock insuffisant pour ${product.name} en taille ${size} (disponible: ${available})`);
    } else if (Number(product.stock || 0) < quantity) {
      throw new Error(`Stock insuffisant pour ${product.name} (disponible: ${product.stock})`);
    }
  }
}

function buildAdditionalOrderSyncItems(orderItems = []) {
  return (orderItems || [])
    .filter((item) => Number(item?.quantity || 0) > 0 && String(item?.source || "") === "boutique")
    .map((item) => ({
      product_id: Number(item.boutiqueProductId),
      quantity: Number(item.quantity),
      size: normalizeSize(item.size || ""),
    }));
}

function assertClothingOrderStock(stock, clothingOrder = {}) {
  for (const kind of ["tshirt", "pantalon"]) {
    const qty = Math.max(0, Number(clothingOrder?.[`${kind}Qty`] || 0));
    const size = normalizeSize(clothingOrder?.[`${kind}Size`] || "");
    if (!qty) continue;
    if (!size) throw new Error(`Taille manquante pour ${kind}`);
    const available = getAvailableSizeStock(stock, kind, size);
    if (available < qty) {
      throw new Error(`Stock insuffisant pour ${kind} en taille ${size} (disponible: ${available})`);
    }
  }
}

async function syncBoutiqueStock(env, reference, items) {
  if (!items.length) return { success: true, skipped: true };
  if (!env.BOUTIQUE_SYNC_TOKEN) {
    throw new Error("BOUTIQUE_SYNC_TOKEN manquant");
  }
  const response = await fetch(`${getBoutiqueApiBase(env)}/api/internal/stock/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Inventory-Token": env.BOUTIQUE_SYNC_TOKEN,
      Accept: "application/json",
    },
    body: JSON.stringify({
      reference,
      source: "inscription",
      items,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || "Synchronisation stock boutique impossible");
  }
  return payload;
}

function clothingStockResponse(stock) {
  return {
    tshirt: stock?.tshirt ? {
      productId: stock.tshirt.productId,
      name: stock.tshirt.name,
      stock: stock.tshirt.stock,
      sizes: stock.tshirt.sizes,
      stockBySize: stock.tshirt.stockBySize,
    } : null,
    pantalon: stock?.pantalon ? {
      productId: stock.pantalon.productId,
      name: stock.pantalon.name,
      stock: stock.pantalon.stock,
      sizes: stock.pantalon.sizes,
      stockBySize: stock.pantalon.stockBySize,
    } : null,
  };
}

function boutiqueStockRequestError(error) {
  return badRequest(error.message || "Stock boutique indisponible", 409);
}

export {
  assertAdditionalOrderItemsStock,
  assertClothingOrderStock,
  buildAdditionalOrderSyncItems,
  buildClothingSyncItems,
  boutiqueStockRequestError,
  clothingStockResponse,
  fetchBoutiqueClothingStock,
  fetchBoutiqueProducts,
  getAvailableSizeStock,
  normalizeSize,
  syncBoutiqueStock,
};
