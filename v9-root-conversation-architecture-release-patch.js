import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_ROOT_CONVERSATION_ARCH_V1";

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ROOT_ARCH_SYNTAX_${file}:${result.stderr || result.stdout}`);
}

function requireAnchor(source, anchor, label) {
  if (!source.includes(anchor)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
}

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  requireAnchor(source, oldValue, label);
  return source.replace(oldValue, newValue);
}

function replaceRegex(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

// The Direct Core builds one short active turn for response timing and a separate,
// bounded customer context for product continuity. It also persists the last reliable
// product/intent so short anaphoric messages such as "Cho xem" remain resolvable.
{
  const file = "v9-direct-core-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = replaceOnce(
      source,
      'import { buildConversationTurn } from "./v9/core/turn-builder.js";',
      'import { buildConversationTurn } from "./v9/core/conversation-intelligence.js";',
      "ROOT_ARCH_DIRECT_IMPORT",
    );

    source = replaceOnce(
      source,
      "  return {\n    display_name: row.display_name || null,",
      "  return {\n    profile,\n    display_name: row.display_name || null,",
      "ROOT_ARCH_CUSTOMER_PROFILE",
    );

    const turnPattern = /  const turn = buildConversationTurn\(events, \{[\s\S]*?\n  \}\);/;
    const turnMatch = source.match(turnPattern)?.[0];
    if (!turnMatch) throw new Error("ROOT_ARCH_TURN_OPTIONS_ANCHOR_NOT_FOUND");
    let turnReplacement = turnMatch;
    if (!turnReplacement.includes("customer,")) {
      turnReplacement = turnReplacement.replace(/\n    state,/, "\n    state,\n    customer,");
    }
    if (!turnReplacement.includes("contextCustomerMessages")) {
      turnReplacement = turnReplacement.replace(
        /\n    customer,/,
        "\n    customer,\n    contextCustomerMessages: 12,\n    contextMaxMinutes: 45,",
      );
    }
    source = source.replace(turnMatch, turnReplacement);

    const persistHelper = `async function persistConversationMemory(job, customer, turn) {\n  const products = Array.isArray(turn?.salesSignals?.products) ? turn.salesSignals.products : [];\n  const intents = Array.isArray(turn?.salesSignals?.intents) ? turn.salesSignals.intents : [];\n  const lastProduct = products.length === 1 ? String(products[0] || "").trim() : null;\n  const lastIntent = intents.length ? String(intents[0] || "").trim() : null;\n  if (!lastProduct && !lastIntent) return;\n  const profile = { ...(customer?.profile && typeof customer.profile === "object" ? customer.profile : {}) };\n  if (lastProduct) {\n    profile.last_product_key = lastProduct;\n    profile.last_product_source = turn?.salesSignals?.productSource || "conversation";\n    profile.last_product_confidence = Number(turn?.salesSignals?.productConfidence || 0);\n    profile.last_product_at = new Date().toISOString();\n  }\n  if (lastIntent) {\n    profile.last_intent_type = lastIntent;\n    profile.last_intent_at = new Date().toISOString();\n  }\n  await core(\`v9_customers?page_id=eq.\${encodeURIComponent(job.page_id)}&customer_id=eq.\${encodeURIComponent(job.sender_id)}\`, {\n    method: "PATCH",\n    prefer: "return=minimal",\n    body: { profile, updated_at: new Date().toISOString() },\n  }).catch(() => {});\n}\n\n`;
    source = replaceOnce(
      source,
      "async function saveTurn(job, turn) {",
      `${persistHelper}async function saveTurn(job, turn) {`,
      "ROOT_ARCH_PERSIST_HELPER",
    );

    source = replaceOnce(
      source,
      "  await saveDecision(job, turnRow, turn, customer, state, config);\n  await complete(job);",
      "  await saveDecision(job, turnRow, turn, customer, state, config);\n  await persistConversationMemory(job, customer, turn);\n  await complete(job);",
      "ROOT_ARCH_PERSIST_CALL",
    );

    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_direct_context_arch_v2";');
    source += `\n// ${MARKER}: bounded conversation context and persistent product memory installed.\n`;
    fs.writeFileSync(file, source);
    syntaxCheck(file);
  }
}

// The AI worker now consumes the same conversation intelligence, the latest Knowledge
// document version and a live folder→catalog resolver. Broad campaign mappings are context,
// never proof that an arbitrary slide should be sent.
{
  const file = "v9-ai-shadow-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = replaceOnce(
      source,
      'import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v9/core/decision-contract.js";',
      'import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v9/core/decision-contract-v2.js";',
      "ROOT_ARCH_DECISION_IMPORT",
    );
    source = replaceOnce(
      source,
      'import { selectKnowledgeContext } from "./v9/core/knowledge-selector.js";',
      'import { selectKnowledgeContext } from "./v9/core/knowledge-selector-v2.js";',
      "ROOT_ARCH_KNOWLEDGE_IMPORT",
    );

    const helpers = `async function rootLiveMappingContext(snapshot = {}, knowledgeSnapshot = {}) {\n  const referral = snapshot?.turn?.referral || {};\n  const adId = String(referral.ad_id || referral.adId || "").trim();\n  if (!adId) return { ad_id: null, keys: [], candidates: [], mapping_target_type: null };\n  try {\n    const rows = await knowledgeRest("rpc/v9_mapping_catalog_candidates", {\n      method: "POST",\n      body: { p_ad_id: adId },\n      timeout: 10000,\n    });\n    const index = supportVisionCatalogIndex(knowledgeSnapshot);\n    const candidates = (Array.isArray(rows) ? rows : [])\n      .map((row) => ({\n        catalog_key: supportResolveCatalogKey(row?.catalog_key, index),\n        asset_count: Number(row?.asset_count || 0),\n        source: row?.source || null,\n        mapping_target_type: row?.mapping_target_type || null,\n        mapping_mode: row?.mapping_mode || null,\n      }))\n      .filter((row) => row.catalog_key && row.asset_count > 0)\n      .sort((a, b) => b.asset_count - a.asset_count || a.catalog_key.localeCompare(b.catalog_key));\n    return {\n      ad_id: adId,\n      keys: [...new Set(candidates.map((row) => row.catalog_key))],\n      candidates,\n      mapping_target_type: candidates[0]?.mapping_target_type || null,\n    };\n  } catch (error) {\n    return { ad_id: adId, keys: [], candidates: [], mapping_target_type: null, error: String(error?.message || error).slice(0, 240) };\n  }\n}\n\nfunction rootEnrichSelectedKnowledge(selectedKnowledge = {}, knowledgeSnapshot = {}, snapshot = {}, liveMapping = {}) {\n  const turnProducts = Array.isArray(snapshot?.turn?.salesSignals?.products)\n    ? snapshot.turn.salesSignals.products.map((value) => String(value || "").trim()).filter(Boolean)\n    : [];\n  const candidateSet = new Set(Array.isArray(liveMapping?.keys) ? liveMapping.keys : []);\n  const exactTurnKeys = turnProducts.filter((key) => candidateSet.has(key));\n  const keysToEnsure = exactTurnKeys.length ? exactTurnKeys : candidateSet.size === 1 ? [...candidateSet] : [];\n  if (keysToEnsure.length) supportEnsureSelectedCatalog(selectedKnowledge, knowledgeSnapshot, keysToEnsure);\n  if (liveMapping?.ad_id) {\n    selectedKnowledge.ad_mappings = [{\n      ad_id: liveMapping.ad_id,\n      catalog_keys: keysToEnsure,\n      candidate_catalog_keys: [...candidateSet],\n      mapping_target_type: liveMapping.mapping_target_type || null,\n      live_folder_resolution: true,\n      candidates: liveMapping.candidates || [],\n    }];\n  }\n  return selectedKnowledge;\n}\n\n`;
    source = replaceOnce(
      source,
      "async function providerCall(ai, modelInput) {",
      `${helpers}async function providerCall(ai, modelInput) {`,
      "ROOT_ARCH_AI_HELPERS",
    );

    source = replaceRegex(
      source,
      /function supportTextWantsSamples\(snapshot = \{\}\) \{[\s\S]*?\n\}/,
      `function supportTextWantsSamples(snapshot = {}) {\n  const signals = snapshot?.turn?.salesSignals || {};\n  const intents = Array.isArray(signals.intents) ? signals.intents : [];\n  return signals.explicitSampleRequest === true || intents.includes("samples");\n}`,
      "ROOT_ARCH_SUPPORT_SAMPLE_INTENT",
    );

    source = replaceRegex(
      source,
      /async function supportLiveAdMapping\(snapshot = \{\}, knowledgeSnapshot = \{\}\) \{[\s\S]*?\n\}\n\nfunction supportTextInstructions/,
      `async function supportLiveAdMapping(snapshot = {}, knowledgeSnapshot = {}) {\n  return rootLiveMappingContext(snapshot, knowledgeSnapshot);\n}\n\nfunction supportTextInstructions`,
      "ROOT_ARCH_SUPPORT_MAPPING",
    );

    const supportIntentAnchor = "  const intents = Array.isArray(turn?.salesSignals?.intents) ? turn.salesSignals.intents : [];";
    const supportIntentGate = `${supportIntentAnchor}\n  if (!intents.includes("samples")) {\n    return {\n      action: "suppress", final_reply: "", should_request_contact: false, contact_benefit: "",\n      products: [], intents, needs_slides: false, confidence: 1,\n      reason: "SUPPORT: non-media request belongs to the primary text bot.",\n      risk_flags: ["support_non_media_suppressed"], support_mode: true,\n      support_catalog_signature: "", support_fixed_salutation: "em-anh_chi",\n    };\n  }`;
    source = replaceOnce(source, supportIntentAnchor, supportIntentGate, "ROOT_ARCH_SUPPORT_NON_MEDIA_GATE");

    source = replaceOnce(
      source,
      "  const products = (aiProducts.length ? aiProducts : mappingFallback.length ? mappingFallback : turnFallback).slice(0, 3);",
      "  const reliableMappingFallback = mappingFallback.length === 1 ? mappingFallback : [];\n  const products = (aiProducts.length ? aiProducts : reliableMappingFallback.length ? reliableMappingFallback : turnFallback).slice(0, 3);",
      "ROOT_ARCH_MAPPING_FALLBACK",
    );

    const selectionBlock = `  const selectedKnowledge = selectKnowledgeContext(knowledgeSnapshot, snapshot, {\n    maxDocuments: 6,\n    maxDocumentChars: 1800,\n    maxCatalogNodes: 6,\n    maxAssetsPerNode: 6,\n  });\n  const modelInput = { conversation: compactConversation(snapshot), knowledge: selectedKnowledge };`;
    const selectionReplacement = `  const selectedKnowledge = selectKnowledgeContext(knowledgeSnapshot, snapshot, {\n    maxDocuments: 6,\n    maxDocumentChars: 1800,\n    maxCatalogNodes: 6,\n    maxAssetsPerNode: 6,\n  });\n  const rootLiveMapping = await rootLiveMappingContext(snapshot, knowledgeSnapshot);\n  rootEnrichSelectedKnowledge(selectedKnowledge, knowledgeSnapshot, snapshot, rootLiveMapping);\n  const modelInput = {\n    conversation: compactConversation(snapshot),\n    knowledge: selectedKnowledge,\n    live_mapping_context: rootLiveMapping,\n  };`;
    source = replaceOnce(source, selectionBlock, selectionReplacement, "ROOT_ARCH_MODEL_CONTEXT");

    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_ai_root_context_arch_v8";');
    source += `\n// ${MARKER}: unified context, live mapping and fail-safe media decisions installed.\n`;
    fs.writeFileSync(file, source);
    syntaxCheck(file);
  }
}

console.log(`[AIGUKA V9] ${MARKER} installed: context continuity, intent separation, live Mapping resolution and fail-safe media`);
