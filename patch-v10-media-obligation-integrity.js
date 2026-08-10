import fs from "node:fs";

const AI_FILE = "v10-ai-worker-final.js";
const OUTBOUND_FILE = "v10-outbound-worker.js";
const AI_MARK = "AIGUKA_V10_MEDIA_OBLIGATION_INTEGRITY_V1";
const OUTBOUND_MARK = "AIGUKA_V10_BALANCED_PRODUCT_SCOPE_MEDIA_V1";

function replaceFunction(source, functionName, nextFunctionName, replacement) {
  const start = source.indexOf(`function ${functionName}(`);
  const end = source.indexOf(`function ${nextFunctionName}(`, start + 1);
  if (start < 0 || end < 0) throw new Error(`V10_MEDIA_PATCH_FUNCTION_TARGET_MISSING:${functionName}`);
  return source.slice(0, start) + replacement.trimEnd() + "\n\n" + source.slice(end);
}

if (!fs.existsSync(AI_FILE)) throw new Error("V10_MEDIA_PATCH_AI_WORKER_MISSING");
if (!fs.existsSync(OUTBOUND_FILE)) throw new Error("V10_MEDIA_PATCH_OUTBOUND_WORKER_MISSING");

let ai = fs.readFileSync(AI_FILE, "utf8");
if (!ai.includes(AI_MARK)) {
  const importAnchor = 'import { buildKnowledgeAdvisors } from "./v10/core/knowledge-advisor.js";';
  const mediaImport = 'import { deriveMediaScope, explicitMediaRequestFromMessages, mediaExpectedFromMessages } from "./v10/core/media-obligation.js";';
  if (!ai.includes(importAnchor)) throw new Error("V10_MEDIA_PATCH_AI_IMPORT_ANCHOR_MISSING");
  if (!ai.includes(mediaImport)) ai = ai.replace(importAnchor, `${importAnchor}\n${mediaImport}`);

  ai = replaceFunction(ai, "explicitSlideRequest", "languageLooksCorrupted", String.raw`
function explicitSlideRequest(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  return explicitMediaRequestFromMessages(messages);
}`);

  ai = replaceFunction(ai, "currentTurnSlideKeys", "continuationSlideRequest", String.raw`
function currentTurnSlideKeys(modelInput, slideKeys) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  const explicitScope = deriveMediaScope(messages, slideKeys);
  if (explicitScope.length || !explicitMediaRequestFromMessages(messages)) return explicitScope;

  const mappings = modelInput && modelInput.knowledge_advisors && Array.isArray(modelInput.knowledge_advisors.ad_mappings)
    ? modelInput.knowledge_advisors.ad_mappings
    : [];
  if (mappings.length !== 1) return [];
  const mapping = mappings[0] || {};
  const preferred = Array.isArray(mapping.fallback_catalog_keys) && mapping.fallback_catalog_keys.length
    ? mapping.fallback_catalog_keys
    : (Array.isArray(mapping.catalog_keys) ? mapping.catalog_keys : []);
  const available = slideKeys instanceof Set ? slideKeys : new Set(Array.isArray(slideKeys) ? slideKeys.map(String) : []);
  return [...new Set(preferred.map((value) => String(value || "").trim()).filter((value) => available.has(value)))].slice(0, 3);
}`);

  const scopeStart = '  const scope = scopedSlideKeys(modelInput, slide);';
  const scopeEnd = '  if (decision.needs_slides || decision.action === "reply_with_slides") {';
  const start = ai.indexOf(scopeStart);
  const end = ai.indexOf(scopeEnd, start);
  if (start < 0 || end < 0) throw new Error("V10_MEDIA_PATCH_AI_SCOPE_TARGET_MISSING");
  const scopeReplacement = String.raw`  const scope = currentTurnSlideKeys(modelInput, slide);
  const slideRequested = explicitSlideRequest(modelInput);
  const messagesForMedia = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  const mediaExpected = mediaExpectedFromMessages(messagesForMedia, scope);
  if (scope.length && (mediaExpected || decision.needs_slides || decision.action === "reply_with_slides")) {
    if (mediaExpected) {
      decision.needs_slides = true;
      decision.action = "reply_with_slides";
      decision.decision_reason = String(decision.decision_reason || "") + " | customer_media_obligation_preserved";
    }
    decision.selected_catalog_keys = scope.slice(0, 6);
  } else {
    decision.selected_catalog_keys = selected.filter(function (selectedKey) { return slide.has(selectedKey); }).slice(0, 6);
  }

`;
  ai = ai.slice(0, start) + scopeReplacement + ai.slice(end);
  ai += `\n// ${AI_MARK}\n`;
  fs.writeFileSync(AI_FILE, ai, "utf8");
}

let outbound = fs.readFileSync(OUTBOUND_FILE, "utf8");
if (!outbound.includes(OUTBOUND_MARK)) {
  const start = outbound.indexOf("async function resolveAssets(decision) {");
  const end = outbound.indexOf("function isAfterOrEqual(", start);
  if (start < 0 || end < 0) throw new Error("V10_MEDIA_PATCH_OUTBOUND_RESOLVER_TARGET_MISSING");

  const replacement = String.raw`async function resolveAssets(decision) {
  const output = decision.output || {};
  if (!output.needs_slides && decision.action !== "reply_with_slides") return { assets: [], catalog_keys: [] };
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

  // Product-name fallback is only used when the AI decision did not provide a valid key.
  // Prefer the catalog root so a parent request can inherit all of its active children.
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

  // If both a parent and one of its children slipped into the decision, keep only the
  // parent scope. This prevents one requested product from receiving extra weight.
  const scopes = requestedScopes.filter((scopeKey) => !requestedScopes.some((otherKey) => {
    if (otherKey === scopeKey) return false;
    return isWithinScope(nodeByKey.get(scopeKey), otherKey);
  }));

  const seen = new Set();
  const scopeGroups = [];
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
    if (scopeAssets.length) scopeGroups.push({ catalog_key: scopeKey, assets: scopeAssets });
  }

  // Balance by the products the customer asked for, not by child folders. A request for
  // bồn cầu + lavabo therefore gets roughly half of the media from each product scope.
  return {
    assets: roundRobinAssets(scopeGroups),
    catalog_keys: scopeGroups.map((group) => group.catalog_key),
  };
}

`;
  outbound = outbound.slice(0, start) + replacement + outbound.slice(end);
  outbound = outbound.replace(
    /const VERSION = "v10_outbound_[^"]+";/,
    'const VERSION = "v10_outbound_media_scope_v3";',
  );
  outbound += `\n// ${OUTBOUND_MARK}\n`;
  fs.writeFileSync(OUTBOUND_FILE, outbound, "utf8");
}

console.log("[AIGUKA V10] media obligation integrity enabled: explicit image/sample requests are preserved and multi-product slides are balanced by requested product scope");
