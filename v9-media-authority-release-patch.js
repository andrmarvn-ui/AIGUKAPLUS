import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_MEDIA_AUTHORITY_V1";

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`MEDIA_AUTHORITY_SYNTAX_${file}:${result.stderr || result.stdout}`);
  }
}

function injectImport(source, statement, anchor) {
  if (source.includes(statement)) return source;
  if (!source.includes(anchor)) throw new Error("MEDIA_AUTHORITY_IMPORT_ANCHOR_NOT_FOUND");
  return source.replace(anchor, `${anchor}\n${statement}`);
}

function replaceBetween(source, startAnchor, endAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (start < 0 || end < 0) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.slice(0, start) + replacement + source.slice(end);
}

// The decision engine owns the final product/catalog choice. Knowledge remains context only.
{
  const file = "v9-ai-shadow-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = injectImport(
      source,
      'import { resolveAuthoritativeCatalogKeys } from "./v9/core/media-authority.js";',
      'import { selectKnowledgeContext } from "./v9/core/knowledge-selector.js";',
    );
    source = source.replace(
      /const VERSION = "[^"]+";/,
      'const VERSION = "v9_ai_media_authority_v5";',
    );

    const decisionAnchor = "    const decision = validateDecision(rawDecision, { contactCaptured });";
    const decisionBlock = `    const mappedSupportProducts = rawDecision?.support_mode === true\n      ? [...new Set((selectedKnowledge.ad_mappings || [])\n        .flatMap((mapping) => Array.isArray(mapping?.catalog_keys) ? mapping.catalog_keys : [])\n        .map((value) => String(value || "").trim())\n        .filter(Boolean))]\n      : [];\n    if (rawDecision?.support_mode === true\n      && rawDecision?.needs_slides === true\n      && (!Array.isArray(rawDecision.products) || rawDecision.products.length === 0)\n      && mappedSupportProducts.length) {\n      rawDecision = { ...rawDecision, products: mappedSupportProducts };\n    }\n    const decision = validateDecision(rawDecision, { contactCaptured });\n    const detectedMediaProducts = Array.isArray(decision.products)\n      ? decision.products.map((value) => String(value || "").trim()).filter(Boolean)\n      : [];\n    const requestedMediaProducts = detectedMediaProducts.length\n      ? detectedMediaProducts\n      : mappedSupportProducts;\n    const mediaCatalogKeys = decision.needs_slides === true\n      ? resolveAuthoritativeCatalogKeys({\n        requestedKeys: requestedMediaProducts,\n        catalog: selectedKnowledge.catalog || [],\n      })\n      : []; // ${MARKER}`;
    if (!source.includes(decisionAnchor)) throw new Error("MEDIA_AUTHORITY_AI_DECISION_ANCHOR_NOT_FOUND");
    source = source.replace(decisionAnchor, decisionBlock);

    const outputAnchor = "          ...decision,\n          should_send: false,";
    const outputReplacement = `          ...decision,\n          media_catalog_keys: mediaCatalogKeys,\n          media_catalog_source: decision.support_mode === true\n            ? (detectedMediaProducts.length ? "support_customer_decision" : "support_ad_mapping")\n            : "ai_products",\n          media_authority_version: "v1",\n          should_send: false,`;
    if (!source.includes(outputAnchor)) throw new Error("MEDIA_AUTHORITY_AI_OUTPUT_ANCHOR_NOT_FOUND");
    source = source.replace(outputAnchor, outputReplacement);
    fs.writeFileSync(file, source);
  }
}

// The delivery worker is an executor only. It cannot infer, broaden or cross-fallback catalogs.
{
  const file = "v9-live-outbound-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = injectImport(
      source,
      'import { selectAuthoritativeMedia } from "./v9/core/media-authority.js";',
      'import { loadActiveMetaConnection } from "./meta-token-store.js";',
    );
    source = source.replace(
      /const VERSION = "[^"]+";/,
      'const VERSION = "v9_live_outbound_media_authority_v3";',
    );

    const resolver = `async function resolveAssets(decision) {\n  const needsSlides = Boolean(decision?.output?.needs_slides || decision.action === "reply_with_slides");\n  if (!needsSlides) return { assets: [], catalog_keys: [], requested_keys: [] };\n  const content = await publishedKnowledge();\n  return selectAuthoritativeMedia({\n    decision,\n    catalog: Array.isArray(content.catalog) ? content.catalog : [],\n    maxAssets: 10,\n  }); // ${MARKER}\n}\n\n`;
    source = replaceBetween(
      source,
      "async function resolveAssets(decision) {",
      "function isAfterOrEqual(a, b) {",
      resolver,
      "MEDIA_AUTHORITY_RESOLVER",
    );

    const oldResolution = "  const assets = await resolveAssets(claimed).catch(() => []);";
    const newResolution = `  const needsSlides = Boolean(claimed?.output?.needs_slides || claimed.action === "reply_with_slides");\n  let mediaSelection = { assets: [], catalog_keys: [], requested_keys: [] };\n  try {\n    mediaSelection = await resolveAssets(claimed);\n  } catch (error) {\n    await patchDecision(claimed, "live_suppressed", {\n      should_send: false,\n      transport_locked: true,\n      live_suppression_reason: "MEDIA_RESOLUTION_BLOCKED",\n      media_resolution_error: String(error?.code || error?.message || error).slice(0, 300),\n      media_resolution_details: error?.details && typeof error.details === "object" ? error.details : {},\n      media_authority_version: "v1",\n    });\n    return { sent: 0, suppressed: 1, failed: 0 };\n  }\n  const assets = mediaSelection.assets;\n  if (needsSlides && !assets.length) {\n    await patchDecision(claimed, "live_suppressed", {\n      should_send: false,\n      transport_locked: true,\n      live_suppression_reason: "MEDIA_ASSET_NOT_FOUND",\n      media_catalog_keys_resolved: mediaSelection.catalog_keys,\n      media_authority_version: "v1",\n    });\n    return { sent: 0, suppressed: 1, failed: 0 };\n  }\n  claimed.output = {\n    ...(claimed.output || {}),\n    media_catalog_keys_resolved: mediaSelection.catalog_keys,\n    media_requested_keys: mediaSelection.requested_keys,\n    media_asset_catalog_keys: [...new Set(assets.map((asset) => asset.catalog_key))],\n    media_authority_version: "v1",\n  };`;
    if (!source.includes(oldResolution)) throw new Error("MEDIA_AUTHORITY_PROCESS_ANCHOR_NOT_FOUND");
    source = source.replace(oldResolution, newResolution);

    source = source.replace(
      "      historical_replay: false,",
      '      historical_replay: false,\n      media_authority: "decision_products_only",',
    );
    fs.writeFileSync(file, source);
  }
}

for (const file of ["v9-ai-shadow-worker.js", "v9-live-outbound-worker.js", "v9/core/media-authority.js"]) {
  syntaxCheck(file);
}

console.log("[AIGUKA V9] Media authority installed: AI decision is final, cross-catalog fallback is blocked");
