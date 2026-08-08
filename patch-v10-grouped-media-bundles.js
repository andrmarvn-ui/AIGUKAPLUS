import fs from "node:fs";

const FILE = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_GROUPED_MEDIA_BUNDLES_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_GROUPED_MEDIA_OUTBOUND_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const resolveStart = source.indexOf("async function resolveAssets(decision) {");
  const resolveEnd = source.indexOf("function isAfterOrEqual(", resolveStart);
  if (resolveStart < 0 || resolveEnd < 0) throw new Error("V10_GROUPED_MEDIA_RESOLVER_RANGE_MISSING");

  const groupedResolver = String.raw`async function resolveAssets(decision) {
  const output = decision.output || {};
  if (!output.needs_slides && decision.action !== "reply_with_slides") {
    return { assets: [], catalog_keys: [], requested_catalog_keys: [], missing_catalog_keys: [], media_bundles: [] };
  }

  const content = await publishedKnowledge();
  const nodes = Array.isArray(content.catalog) ? content.catalog : [];
  const nodeByKey = new Map(nodes
    .map((node) => [String(node?.catalog_key || "").trim(), node])
    .filter(([key]) => Boolean(key)));
  const selectedProducts = (output.selected_products || []).map((value) => normalizeVietnamese(value));
  const requestedScopes = [];

  function addScope(key) {
    const clean = String(key || "").trim();
    if (clean && nodeByKey.has(clean) && !requestedScopes.includes(clean)) requestedScopes.push(clean);
  }

  for (const key of output.selected_catalog_keys || []) addScope(key);

  if (!requestedScopes.length && selectedProducts.length) {
    for (const node of nodes) {
      const text = nodeText(node);
      if (!selectedProducts.some((product) => product && (text.includes(product) || product.includes(normalizeVietnamese(node.catalog_key))))) continue;
      const root = String(node.root_key || "").trim();
      addScope(nodeByKey.has(root) ? root : node.catalog_key);
    }
  }

  function isWithinScope(node, scopeKey) {
    let currentKey = String(node?.catalog_key || "").trim();
    const visited = new Set();
    while (currentKey && !visited.has(currentKey)) {
      if (currentKey === scopeKey) return true;
      visited.add(currentKey);
      currentKey = String(nodeByKey.get(currentKey)?.parent_key || "").trim();
    }
    return false;
  }

  function ancestry(key) {
    const output = [];
    let cursor = String(key || "").trim();
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      output.push(cursor);
      visited.add(cursor);
      cursor = String(nodeByKey.get(cursor)?.parent_key || "").trim();
    }
    return output;
  }

  function productGroup(scopeKey) {
    const path = ancestry(scopeKey);
    if (path.includes("phong_tam")) return "phong_tam";
    if (path.includes("phong_bep")) return "phong_bep";
    if (path.includes("gach_ngoi") || path.includes("gach_da_op_lat")) return "gach_op_lat";
    if (path.includes("quat_tran") || path.some((key) => key.startsWith("quat_"))) return "quat_tran";
    return path.at(-1) || String(scopeKey || "other");
  }

  function productGroupLabel(groupKey) {
    if (groupKey === "phong_tam") return "Thiết bị phòng tắm";
    if (groupKey === "phong_bep") return "Thiết bị nhà bếp";
    if (groupKey === "gach_op_lat") return "Gạch ốp lát";
    if (groupKey === "quat_tran") return "Quạt trần";
    return String(nodeByKey.get(groupKey)?.display_name || groupKey || "Mẫu sản phẩm");
  }

  const scopes = requestedScopes.filter((scopeKey) => !requestedScopes.some((otherKey) => {
    if (otherKey === scopeKey) return false;
    return isWithinScope(nodeByKey.get(scopeKey), otherKey);
  }));

  const seen = new Set();
  const resolvedScopes = [];
  const bundleMap = new Map();

  for (const scopeKey of scopes) {
    const childGroups = [];
    for (const node of nodes.filter((candidate) => isWithinScope(candidate, scopeKey))) {
      const assets = [];
      for (const asset of Array.isArray(node.assets) ? node.assets : []) {
        const sourceUrl = validHttpUrl(asset.source_url);
        if (!sourceUrl || /drive\.google\.com\/drive\/folders\//i.test(sourceUrl) || seen.has(sourceUrl)) continue;
        seen.add(sourceUrl);
        assets.push({
          asset_id: asset.asset_id || null,
          catalog_key: scopeKey,
          source_catalog_key: node.catalog_key,
          title: asset.title || node.display_name || "Mẫu sản phẩm",
          source_url: sourceUrl,
          sort_order: Number(asset.sort_order || 0),
        });
      }
      assets.sort((a, b) => a.sort_order - b.sort_order);
      if (assets.length) childGroups.push({ catalog_key: node.catalog_key, assets });
    }

    const scopeAssets = roundRobinAssets(childGroups);
    if (!scopeAssets.length) continue;
    resolvedScopes.push(scopeKey);

    const groupKey = productGroup(scopeKey);
    if (!bundleMap.has(groupKey)) {
      bundleMap.set(groupKey, {
        bundle_key: "media:" + groupKey,
        group_key: groupKey,
        label: productGroupLabel(groupKey),
        catalog_keys: [],
        scope_groups: [],
      });
    }
    const bundle = bundleMap.get(groupKey);
    bundle.catalog_keys.push(scopeKey);
    bundle.scope_groups.push({ catalog_key: scopeKey, assets: scopeAssets });
  }

  const mediaBundles = [...bundleMap.values()].map((bundle) => {
    const assets = roundRobinAssets(bundle.scope_groups);
    return {
      bundle_key: bundle.bundle_key,
      group_key: bundle.group_key,
      label: bundle.label,
      catalog_keys: [...new Set(bundle.catalog_keys)],
      assets,
      asset_count: assets.length,
      max_assets: MAX_MEDIA_ASSETS,
    };
  }).filter((bundle) => bundle.assets.length);

  return {
    assets: mediaBundles.flatMap((bundle) => bundle.assets),
    catalog_keys: resolvedScopes,
    requested_catalog_keys: scopes,
    missing_catalog_keys: scopes.filter((scopeKey) => !resolvedScopes.includes(scopeKey)),
    media_bundles: mediaBundles,
  };
}

`;
  source = source.slice(0, resolveStart) + groupedResolver + source.slice(resolveEnd);

  const salutationSignature = "async function sendCarousel(pageId, recipientId, assets, salutation = null) {";
  const baseSignature = "async function sendCarousel(pageId, recipientId, assets) {";
  if (source.includes(salutationSignature)) {
    source = source.replace(salutationSignature, "async function sendCarousel(pageId, recipientId, assets, salutation = null, groupLabel = null) {");
  } else if (source.includes(baseSignature)) {
    source = source.replace(baseSignature, "async function sendCarousel(pageId, recipientId, assets, salutation = null, groupLabel = null) {");
  } else {
    throw new Error("V10_GROUPED_MEDIA_CAROUSEL_SIGNATURE_MISSING");
  }

  if (source.includes("subtitle: supportCarouselSubtitle(),")) {
    source = source.replace(
      "subtitle: supportCarouselSubtitle(),",
      'subtitle: groupLabel ? String(groupLabel + " · " + supportCarouselSubtitle()).slice(0, 80) : supportCarouselSubtitle(),',
    );
  }

  const processStart = source.indexOf("async function processDecision(decision, config) {");
  const batchStart = source.indexOf("    const batches = [];", processStart);
  const partialAnchor = source.indexOf("    const partial = Boolean(mediaWarning);", batchStart);
  if (processStart < 0 || batchStart < 0 || partialAnchor < 0) {
    throw new Error("V10_GROUPED_MEDIA_DELIVERY_LOOP_MISSING");
  }

  const groupedLoop = String.raw`    const mediaBundles = Array.isArray(media.media_bundles) && media.media_bundles.length
      ? media.media_bundles
      : (media.assets.length ? [{
          bundle_key: "media:mixed_compat",
          group_key: "mixed_compat",
          label: "Mẫu sản phẩm",
          catalog_keys: media.catalog_keys || [],
          assets: media.assets,
          asset_count: media.assets.length,
        }] : []);

    for (const group of mediaBundles) {
      const batches = [];
      for (let index = 0; index < group.assets.length; index += 10) batches.push(group.assets.slice(index, index + 10));
      const safeGroup = String(group.group_key || "product").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "product";
      for (let index = 0; index < batches.length; index += 1) {
        const transport = "meta_messenger_carousel_" + safeGroup + "_" + String(index + 1);
        const alreadySent = (existing || []).some((item) => item.transport === transport && item.status === "sent");
        if (alreadySent) continue;
        try {
          const result = await sendCarousel(claimed.page_id, claimed.sender_id, batches[index], gate.supportSalutation, group.label);
          if (result) await recordAttempt(bundle.id, nextAttempt++, transport, "sent", result);
        } catch (error) {
          mediaWarning = String(error?.message || error).slice(0, 500);
          await recordAttempt(bundle.id, nextAttempt++, transport, "failed", {}, error);
        }
      }
    }

`;
  source = source.slice(0, batchStart) + groupedLoop + source.slice(partialAnchor);

  const metadataAnchor = "      media_asset_count: media.assets.length,";
  if (!source.includes(metadataAnchor)) throw new Error("V10_GROUPED_MEDIA_METADATA_ANCHOR_MISSING");
  source = source.replace(
    metadataAnchor,
    `${metadataAnchor}\n      media_group_count: Array.isArray(media.media_bundles) ? media.media_bundles.length : 0,\n      media_bundle_policy: "one_product_group_per_bundle",\n      media_bundles_resolved: (media.media_bundles || []).map((item) => ({ bundle_key: item.bundle_key, group_key: item.group_key, label: item.label, catalog_keys: item.catalog_keys, asset_count: item.asset_count })),`,
  );

  const heartbeatAnchor = "      balanced_media_max: MAX_MEDIA_ASSETS,";
  if (source.includes(heartbeatAnchor)) {
    source = source.replace(
      heartbeatAnchor,
      `${heartbeatAnchor}\n      media_assets_max_per_group: MAX_MEDIA_ASSETS,\n      media_bundle_policy: "one_product_group_per_bundle",`,
    );
  }

  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_grouped_media_v10";');
  source += `\n// ${MARK}\n`;

  if (!source.includes("one_product_group_per_bundle") || !source.includes("meta_messenger_carousel_\" + safeGroup")) {
    throw new Error("V10_GROUPED_MEDIA_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] grouped media bundles enabled: every broad product group is resolved and delivered independently; catalogs are never flattened across bathroom/kitchen/tile/fan groups");
