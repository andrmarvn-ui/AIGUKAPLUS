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

function nodeAssetCount(node) {
  return array(node?.assets).filter((asset) => validHttpUrl(asset?.source_url)).length;
}

function assetNodesByKeys(catalog, keys) {
  const wanted = new Set(array(keys).map(normalizeCatalogToken));
  return array(catalog)
    .filter((node) => wanted.has(normalizeCatalogToken(node?.catalog_key)) && nodeAssetCount(node) > 0)
    .sort((a, b) => nodeAssetCount(b) - nodeAssetCount(a)
      || String(a?.catalog_key || "").localeCompare(String(b?.catalog_key || "")));
}

function familyNodes(requestedKey, catalog) {
  const token = normalizeCatalogToken(requestedKey);
  const fixedFamilies = {
    phong_bep: ["bep_tu_hut_mui", "chau_voi_rua_bat"],
    bep_tu: ["bep_tu_hut_mui"],
    may_hut_mui: ["bep_tu_hut_mui"],
    phong_tam: ["combo_phong_tam_ban_chay", "combo_phong_tam_dep_moi", "bon_cau_thong_minh", "guong_tu", "lavabo", "sen_voi_cao_cap"],
    sen_tam: ["sen_cay", "sen_voi", "sen_voi_cao_cap"],
    lavabo_tu_lavabo: ["guong_tu", "lavabo"],
    bon_cau: ["bon_cau_thong_minh", "bon_cau_lien_khoi", "bon_cau"],
    bon_tam: ["bon_tam_ares", "bon_tam_massage", "bon_tam"],
    quat_10_canh: ["quat_10_canh_gold", "quat_10_canh_wood", "quat_10_canh_brown", "quat_10_canh_black", "quat_10_canh"],
    quat_tran_den_chum_decor: ["quat_tran", "den_trum"],
    den_trang_tri: ["den_trum"],
  };
  if (fixedFamilies[token]) return assetNodesByKeys(catalog, fixedFamilies[token]);

  if (["gach", "gach_op_lat", "gach_da_op_lat"].includes(token)) {
    return array(catalog)
      .filter((node) => normalizeCatalogToken(node?.catalog_key).startsWith("gach_") && nodeAssetCount(node) > 0)
      .sort((a, b) => nodeAssetCount(b) - nodeAssetCount(a)
        || String(a?.catalog_key || "").localeCompare(String(b?.catalog_key || "")))
      .slice(0, 6);
  }
  return [];
}

function resolveNodes(requestedKey, catalog) {
  const raw = String(requestedKey || "").trim();
  if (!raw) throw mediaError("MEDIA_CATALOG_KEY_EMPTY");

  const family = familyNodes(raw, catalog);
  if (family.length) return family;

  const exact = catalog.filter((node) => String(node?.catalog_key || "").trim() === raw);
  if (exact.length === 1 && nodeAssetCount(exact[0]) > 0) return exact;
  if (exact.length > 1) {
    throw mediaError("MEDIA_CATALOG_DUPLICATE_KEY", { requested_key: raw });
  }

  const normalized = normalizeCatalogToken(raw);
  const matches = catalog.filter((node) => nodeTokens(node).includes(normalized) && nodeAssetCount(node) > 0);
  if (matches.length === 1) return matches;
  if (!matches.length) {
    throw mediaError("MEDIA_CATALOG_NOT_FOUND", {
      requested_key: raw,
      exact_catalog_key: exact[0]?.catalog_key || null,
      exact_asset_count: exact[0] ? nodeAssetCount(exact[0]) : 0,
    });
  }

  const exactTokenMatches = matches.filter((node) => normalizeCatalogToken(node?.catalog_key) === normalized);
  if (exactTokenMatches.length === 1) return exactTokenMatches;
  throw mediaError("MEDIA_CATALOG_AMBIGUOUS", {
    requested_key: raw,
    matching_catalog_keys: matches.map((node) => node.catalog_key),
  });
}

function resolveNode(requestedKey, catalog) {
  const nodes = resolveNodes(requestedKey, catalog);
  if (nodes.length !== 1) {
    throw mediaError("MEDIA_CATALOG_FAMILY", {
      requested_key: String(requestedKey || "").trim(),
      matching_catalog_keys: nodes.map((node) => node.catalog_key),
    });
  }
  return nodes[0];
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

  const resolved = [];
  const ignored = [];
  for (const key of requested) {
    try {
      resolved.push(...resolveNodes(key, nodes).map((node) => String(node?.catalog_key || "").trim()));
    } catch (error) {
      ignored.push({ requested_key: key, error: String(error?.code || error?.message || error) });
    }
  }
  const keys = unique(resolved);
  if (!keys.length) {
    throw mediaError("MEDIA_CATALOG_NOT_FOUND", {
      requested_keys: requested,
      ignored_requested_keys: ignored,
    });
  }
  return keys;
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
  nodeAssetCount,
  familyNodes,
  resolveNodes,
  resolveNode,
  assetsForNode,
};
