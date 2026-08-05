import fs from "node:fs";

const file = "v10/core/knowledge-advisor.js";
const MARK = "AIGUKA_V10_HIERARCHICAL_KNOWLEDGE_V1";
if (!fs.existsSync(file)) throw new Error("V10_HIERARCHICAL_KNOWLEDGE_FILE_MISSING");
let source = fs.readFileSync(file, "utf8");

if (!source.includes(MARK)) {
  const catalogLine = "  const catalog = Array.isArray(content.catalog) ? content.catalog : [];";
  if (!source.includes(catalogLine)) throw new Error("V10_HIERARCHICAL_KNOWLEDGE_CATALOG_TARGET_MISSING");
  const helpers = String.raw`
  const catalogByKey = new Map(catalog
    .map((node) => [String(node?.catalog_key || "").trim(), node])
    .filter(([key]) => Boolean(key)));
  const childrenByParent = new Map();
  for (const node of catalog) {
    const parent = String(node?.parent_key || "").trim();
    if (!parent) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(node);
  }
  const scopeAssetCache = new Map();
  function catalogScopeAssets(node) {
    const startKey = String(node?.catalog_key || "").trim();
    if (!startKey) return [];
    if (scopeAssetCache.has(startKey)) return scopeAssetCache.get(startKey);
    const queue = [node];
    const visitedKeys = new Set();
    const seenUrls = new Set();
    const groups = [];
    while (queue.length) {
      const current = queue.shift();
      const currentKey = String(current?.catalog_key || "").trim();
      if (!currentKey || visitedKeys.has(currentKey)) continue;
      visitedKeys.add(currentKey);
      const assets = (Array.isArray(current?.assets) ? current.assets : [])
        .filter((asset) => asset?.source_url && !seenUrls.has(String(asset.source_url)))
        .map((asset) => { seenUrls.add(String(asset.source_url)); return asset; });
      if (assets.length) groups.push(assets);
      for (const child of childrenByParent.get(currentKey) || []) queue.push(child);
    }
    const balanced = [];
    let cursor = 0;
    while (true) {
      let added = false;
      for (const group of groups) {
        if (cursor < group.length) {
          balanced.push(group[cursor]);
          added = true;
        }
      }
      if (!added) break;
      cursor += 1;
    }
    scopeAssetCache.set(startKey, balanced);
    return balanced;
  }
  // ${MARK}
`;
  source = source.replace(catalogLine, `${catalogLine}${helpers}`);

  const countTarget = "      asset_count: Array.isArray(node.assets) ? node.assets.filter((asset) => asset?.source_url).length : 0,";
  const assetsTarget = "      assets: (Array.isArray(node.assets) ? node.assets : []).filter((asset) => asset?.source_url).slice(0, maxAssets).map((asset) => ({";
  if (!source.includes(countTarget) || !source.includes(assetsTarget)) {
    throw new Error("V10_HIERARCHICAL_KNOWLEDGE_ASSET_TARGET_MISSING");
  }
  source = source
    .replace(countTarget, "      asset_count: catalogScopeAssets(node).length,")
    .replace(assetsTarget, "      assets: catalogScopeAssets(node).slice(0, maxAssets).map((asset) => ({");

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] hierarchical knowledge enabled: parent catalogs inherit descendant asset availability");
}
