const MAX_MEDIA_ASSETS = 10;

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeCatalogToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function mediaError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function nodeTokens(node) {
  return unique([
    node?.catalog_key,
    node?.display_name,
    ...array(node?.aliases),
  ].map(normalizeCatalogToken));
}

function resolveNode(requestedKey, catalog) {
  const raw = String(requestedKey || "").trim();
  if (!raw) throw mediaError("MEDIA_CATALOG_KEY_EMPTY");

  const exact = catalog.filter((node) => String(node?.catalog_key || "").trim() === raw);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw mediaError("MEDIA_CATALOG_DUPLICATE_KEY", { requested_key: raw });
  }

  const normalized = normalizeCatalogToken(raw);
  const matches = catalog.filter((node) => nodeTokens(node).includes(normalized));
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw mediaError("MEDIA_CATALOG_NOT_FOUND", { requested_key: raw });
  }
  throw mediaError("MEDIA_CATALOG_AMBIGUOUS", {
    requested_key: raw,
    matching_catalog_keys: matches.map((node) => node.catalog_key),
  });
}

export function authoritativeRequestedKeys(decision = {}) {
  const output = decision?.output || {};
  const explicitMediaKeys = unique(array(output.media_catalog_keys).map((value) => String(value || "").trim()));
  if (explicitMediaKeys.length) return explicitMediaKeys;
  return unique(array(output.products).map((value) => String(value || "").trim()));
}

export function resolveAuthoritativeCatalogKeys({ requestedKeys = [], catalog = [] } = {}) {
  const nodes = array(catalog);
  const requested = unique(array(requestedKeys).map((value) => String(value || "").trim()));
  if (!requested.length) throw mediaError("MEDIA_DECISION_PRODUCTS_REQUIRED");
  return unique(requested.map((key) => String(resolveNode(key, nodes).catalog_key || "").trim()));
}

function assetsForNode(node) {
  const seen = new Set();
  return array(node?.assets)
    .map((asset) => ({
      asset_id: asset?.asset_id || null,
      catalog_key: String(node?.catalog_key || "").trim(),
      title: node?.display_name || "Mẫu sản phẩm",
      source_url: validHttpUrl(asset?.source_url),
      sort_order: Number(asset?.sort_order || 0),
    }))
    .filter((asset) => {
      if (!asset.catalog_key || !asset.source_url || seen.has(asset.source_url)) return false;
      seen.add(asset.source_url);
      return true;
    })
    .sort((a, b) => a.sort_order - b.sort_order || String(a.asset_id || "").localeCompare(String(b.asset_id || "")));
}

export function selectAuthoritativeMedia({ decision = {}, catalog = [], maxAssets = MAX_MEDIA_ASSETS } = {}) {
  const needsSlides = Boolean(decision?.output?.needs_slides || decision?.action === "reply_with_slides");
  if (!needsSlides) return { assets: [], catalog_keys: [], requested_keys: [] };

  const requestedKeys = authoritativeRequestedKeys(decision);
  const catalogKeys = resolveAuthoritativeCatalogKeys({ requestedKeys, catalog });
  const nodeByKey = new Map(array(catalog).map((node) => [String(node?.catalog_key || "").trim(), node]));
  const perCatalog = catalogKeys.map((catalogKey) => {
    const node = nodeByKey.get(catalogKey);
    const assets = assetsForNode(node);
    if (!assets.length) {
      throw mediaError("MEDIA_ASSET_NOT_FOUND", { catalog_key: catalogKey });
    }
    return { catalogKey, assets, index: 0 };
  });

  const selected = [];
  const seenUrls = new Set();
  const safeLimit = Math.max(1, Math.min(MAX_MEDIA_ASSETS, Number(maxAssets || MAX_MEDIA_ASSETS)));
  let progress = true;

  while (selected.length < safeLimit && progress) {
    progress = false;
    for (const bucket of perCatalog) {
      while (bucket.index < bucket.assets.length) {
        const asset = bucket.assets[bucket.index++];
        if (seenUrls.has(asset.source_url)) continue;
        seenUrls.add(asset.source_url);
        selected.push(asset);
        progress = true;
        break;
      }
      if (selected.length >= safeLimit) break;
    }
  }

  if (!selected.length) throw mediaError("MEDIA_ASSET_NOT_FOUND", { catalog_keys: catalogKeys });

  const allowed = new Set(catalogKeys);
  const invalid = selected.filter((asset) => !allowed.has(asset.catalog_key));
  if (invalid.length) {
    throw mediaError("MEDIA_CROSS_CATALOG_BLOCKED", {
      allowed_catalog_keys: catalogKeys,
      invalid_catalog_keys: unique(invalid.map((asset) => asset.catalog_key)),
    });
  }

  return {
    assets: selected,
    catalog_keys: catalogKeys,
    requested_keys: requestedKeys,
  };
}

export const __private__ = {
  array,
  unique,
  validHttpUrl,
  mediaError,
  nodeTokens,
  resolveNode,
  assetsForNode,
};
