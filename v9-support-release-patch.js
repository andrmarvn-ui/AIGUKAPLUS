import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_SUPPORT_SLIDE_ONLY_V1";

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(oldValue, newValue);
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`SUPPORT_SYNTAX_${file}:${result.stderr || result.stdout}`);
  }
}

// 1) In SUPPORT, AICAKE/Page automation is expected and must not suppress slide assistance.
// Verified human takeover and prior AIGUKA replies still suppress normally.
{
  const file = "v9/core/turn-builder.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = replaceOnce(
      source,
      '  const state = options.state || {};',
      `  const state = options.state || {};\n  const supportSlideOnly = options.supportSlideOnly === true; // ${MARKER}`,
      "SUPPORT_TURN_OPTION",
    );
    source = replaceOnce(
      source,
      '  else if (automation && coexistenceMode === "AICAKE_ACTIVE") action = "external_bot_replied";\n  else if (ambiguous) action = "wait_actor_reconciliation";',
      '  else if (!supportSlideOnly && automation && coexistenceMode === "AICAKE_ACTIVE") action = "external_bot_replied";\n  else if (!supportSlideOnly && ambiguous) action = "wait_actor_reconciliation";',
      "SUPPORT_TURN_AUTOMATION",
    );
    fs.writeFileSync(file, source);
  }
}

// 2) Preserve referral/ad evidence on the turn so a generic "Get Started" can map to the correct catalog.
{
  const file = "v9-direct-core-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    const oldBlock = `  const turn = buildConversationTurn(events, {\n    maxGapSeconds: Math.max(90, Number(config.debounce_seconds || 20) * 3),\n    coexistenceMode: config.external_bot_mode || "AICAKE_ACTIVE",\n    state,\n  });`;
    const newBlock = `  const supportSlideOnly = String(config.external_bot_policy || "").toUpperCase() === "AICAKE_PRIMARY_SUPPORT";\n  const turn = buildConversationTurn(events, {\n    maxGapSeconds: Math.max(90, Number(config.debounce_seconds || 20) * 3),\n    coexistenceMode: config.external_bot_mode || "AICAKE_ACTIVE",\n    supportSlideOnly, // ${MARKER}\n    state,\n  });\n  const latestCustomerEventId = turn?.customerMessages?.at(-1)?.sourceEventId || null;\n  const latestCustomerEvent = latestCustomerEventId\n    ? events.find((event) => String(event?.source_event_id || "") === String(latestCustomerEventId))\n    : null;\n  if (turn?.valid && latestCustomerEvent?.referral) turn.referral = latestCustomerEvent.referral;`;
    source = replaceOnce(source, oldBlock, newBlock, "SUPPORT_DIRECT_CORE_TURN");
    fs.writeFileSync(file, source);
  }
}

// 3) Ad mapping catalog keys participate in catalog selection, not only text-detected product keys.
{
  const file = "v9/core/knowledge-selector.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    const oldRequested = "  const requestedKeys = catalogKeysFromTurn(turn);";
    const newRequested = `  const referral = referralIds(decisionInput);\n  const adMappings = array(content.ad_mappings)\n    .filter((mapping) => {\n      if (mapping?.is_active === false) return false;\n      if (referral.ad_id) return text(mapping.ad_id) === referral.ad_id;\n      if (referral.adset_id) return text(mapping.adset_id) === referral.adset_id;\n      if (referral.campaign_id) return text(mapping.campaign_id) === referral.campaign_id;\n      return false;\n    })\n    .slice(0, 4)\n    .map((mapping) => ({\n      page_id: mapping.page_id,\n      ad_account_id: mapping.ad_account_id,\n      campaign_id: mapping.campaign_id,\n      adset_id: mapping.adset_id,\n      ad_id: mapping.ad_id,\n      catalog_keys: array(mapping.catalog_keys),\n      confidence: mapping.confidence,\n      metadata: mapping.metadata || {},\n    }));\n  const requestedKeys = unique([\n    ...catalogKeysFromTurn(turn),\n    ...adMappings.flatMap((mapping) => array(mapping.catalog_keys).map(text)),\n  ]); // ${MARKER}`;
    source = replaceOnce(source, oldRequested, newRequested, "SUPPORT_SELECTOR_REQUESTED_KEYS");

    const firstReferral = source.indexOf("  const referral = referralIds(decisionInput);");
    const duplicateReferral = source.lastIndexOf("  const referral = referralIds(decisionInput);");
    if (duplicateReferral <= firstReferral) throw new Error("SUPPORT_SELECTOR_DUPLICATE_BLOCK_NOT_FOUND");
    const duplicateEnd = source.indexOf("\n\n  return {", duplicateReferral);
    if (duplicateEnd < 0) throw new Error("SUPPORT_SELECTOR_DUPLICATE_END_NOT_FOUND");
    source = source.slice(0, duplicateReferral) + source.slice(duplicateEnd + 2);
    fs.writeFileSync(file, source);
  }
}

// 4) SUPPORT decisions are deterministic and provider-free. No gender inference; always em - anh/chị.
{
  const file = "v9-ai-shadow-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = source.replace(
      'const VERSION = "v9_ai_live_multi_provider_v3";',
      'const VERSION = "v9_support_slide_only_v4";',
    );
    source = source.replace(
      '  if (!usable.length) throw new Error("V9_AI_PROVIDER_NOT_READY");',
      `  // ${MARKER}: empty provider list is allowed; SUPPORT uses no AI and other modes fall back to rules.`,
    );

    const helperAnchor = "async function providerCall(ai, modelInput) {";
    const helpers = `async function supportPage(pageId) {\n  const rows = await coreRest(\n    \`v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,is_active,settings&page_id=eq.\${encodeURIComponent(pageId)}&limit=1\`,\n    { timeout: 10000 },\n  );\n  const page = rows?.[0] || null;\n  return page?.is_active && String(page.operating_mode || "").toUpperCase() === "SUPPORT" ? page : null;\n}\n\nfunction supportSlideDecision(snapshot = {}, selectedKnowledge = {}, page = {}) {\n  const turn = snapshot.turn || {};\n  const contactCaptured = Boolean(turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);\n  const products = Array.isArray(turn?.salesSignals?.products) ? turn.salesSignals.products : [];\n  const intents = Array.isArray(turn?.salesSignals?.intents) ? turn.salesSignals.intents : [];\n  const adMappings = Array.isArray(selectedKnowledge.ad_mappings) ? selectedKnowledge.ad_mappings : [];\n  const catalog = (Array.isArray(selectedKnowledge.catalog) ? selectedKnowledge.catalog : [])\n    .filter((node) => Array.isArray(node?.assets) && node.assets.some((asset) => String(asset?.source_url || "").trim()));\n  const catalogKeys = [...new Set(catalog.map((node) => String(node.catalog_key || "").trim()).filter(Boolean))].sort();\n  const signature = catalogKeys.join("|");\n\n  if (contactCaptured) {\n    return {\n      action: "contact_captured", final_reply: "", should_request_contact: false, contact_benefit: "",\n      products, intents, needs_slides: false, confidence: 1,\n      reason: "SUPPORT: contact already captured; do not ask again.", risk_flags: [],\n      support_mode: true, support_catalog_signature: signature, support_fixed_salutation: "em-anh_chi",\n    };\n  }\n\n  const recognizedProduct = catalogKeys.length > 0 && (products.length > 0 || adMappings.length > 0);\n  if (!recognizedProduct) {\n    return {\n      action: "suppress", final_reply: "", should_request_contact: false, contact_benefit: "",\n      products, intents, needs_slides: false, confidence: 1,\n      reason: "SUPPORT: no exact product catalog with published assets.", risk_flags: [],\n      support_mode: true, support_catalog_signature: signature, support_fixed_salutation: "em-anh_chi",\n    };\n  }\n\n  return {\n    action: "reply_with_slides",\n    final_reply: "Em gửi anh/chị vài mẫu tham khảo ạ. Anh/chị cho em xin SĐT hoặc Zalo để bên em tư vấn kỹ hơn và gửi đúng mẫu theo nhu cầu của mình nhé.",\n    should_request_contact: true,\n    contact_benefit: "Tư vấn kỹ hơn và gửi đúng mẫu theo nhu cầu.",\n    products,\n    intents,\n    needs_slides: true,\n    confidence: 1,\n    reason: "SUPPORT: deterministic slide assistance for AICAKE.",\n    risk_flags: [],\n    support_mode: true,\n    support_catalog_signature: signature,\n    support_fixed_salutation: "em-anh_chi",\n    support_page_id: page.page_id || snapshot.page_id || null,\n  };\n}\n\n${helperAnchor}`;
    source = replaceOnce(source, helperAnchor, helpers, "SUPPORT_AI_HELPERS");

    const loopStart = source.indexOf("  for (const ai of providerRows) {");
    const loopEnd = source.indexOf("\n\n  let fallback = false;", loopStart);
    if (loopStart < 0 || loopEnd < 0) throw new Error("SUPPORT_AI_PROVIDER_LOOP_NOT_FOUND");
    const originalLoop = source.slice(loopStart, loopEnd);
    const supportLoop = `  const page = await supportPage(snapshot.page_id);\n  if (page) {\n    rawDecision = supportSlideDecision(snapshot, selectedKnowledge, page);\n    usedProvider = "support_rule";\n    usedModel = "support_slide_only_v1";\n    providerCache.lastProviderKey = usedProvider;\n  }\n\n  if (!rawDecision) {\n${originalLoop.replace(/^  /gm, "    ")}\n  }`;
    source = source.slice(0, loopStart) + supportLoop + source.slice(loopEnd);
    fs.writeFileSync(file, source);
  }
}

// 5) Final gate permits only slide assistance in SUPPORT, tolerates AICAKE replies,
// dedupes by catalog for 24h, requires real assets, and sends carousel before the fixed text.
{
  const file = "v9-live-outbound-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = source.replace(
      'const VERSION = "v9_live_outbound_v1";',
      'const VERSION = "v9_live_outbound_support_v2";',
    );

    const finalStart = source.indexOf("async function finalGate(decision, config) {");
    const finalEnd = source.indexOf("\n\nasync function claim(decision)", finalStart);
    if (finalStart < 0 || finalEnd < 0) throw new Error("SUPPORT_OUTBOUND_FINAL_GATE_NOT_FOUND");
    const finalGate = `async function supportAlreadyDelivered(decision, signature) {\n  if (!signature) return false;\n  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();\n  const rows = await core(\n    \`v9_decisions?select=id,output,updated_at&page_id=eq.\${encodeURIComponent(decision.page_id)}&sender_id=eq.\${encodeURIComponent(decision.sender_id)}&status=in.(live_delivered,live_delivered_partial)&updated_at=gte.\${encodeURIComponent(since)}&order=updated_at.desc&limit=50\`,\n    { timeout: 10000 },\n  );\n  return (rows || []).some((row) => String(row?.output?.support_catalog_signature || "") === String(signature));\n}\n\nasync function finalGate(decision, config) {\n  if (String(config.mode || "").toUpperCase() !== "ACTIVE") return { allowed: false, reason: "RUNTIME_NOT_ACTIVE" };\n  if (String(config.ingest_mode || "").toUpperCase() !== "DIRECT_CORE") return { allowed: false, reason: "INGEST_NOT_DIRECT_CORE" };\n\n  const page = await pageRow(decision.page_id);\n  if (!page?.is_active) return { allowed: false, reason: "PAGE_NOT_ACTIVE" };\n  const pageMode = String(page.operating_mode || "").toUpperCase();\n  const supportMode = pageMode === "SUPPORT"; // ${MARKER}\n  const output = decision.output || {};\n\n  if (supportMode) {\n    if (String(config.external_bot_mode || "").toUpperCase() !== "AICAKE_ACTIVE") return { allowed: false, reason: "SUPPORT_REQUIRES_AICAKE_ACTIVE" };\n    if (String(config.external_bot_policy || "").toUpperCase() !== "AICAKE_PRIMARY_SUPPORT") return { allowed: false, reason: "SUPPORT_POLICY_NOT_ACTIVE" };\n    if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_ACTIVE") return { allowed: false, reason: "PAGE_AICAKE_NOT_ACTIVE" };\n    if (output.support_mode !== true || decision.action !== "reply_with_slides" || output.needs_slides !== true) {\n      return { allowed: false, reason: "SUPPORT_SLIDE_ONLY" };\n    }\n  } else {\n    if (pageMode !== "ACTIVE") return { allowed: false, reason: "PAGE_NOT_ACTIVE" };\n    if (String(config.external_bot_mode || "").toUpperCase() !== "AICAKE_DISABLED") return { allowed: false, reason: "EXTERNAL_BOT_NOT_DISABLED" };\n    if (String(config.external_bot_policy || "").toUpperCase() !== "AIGUKA_PRIMARY") return { allowed: false, reason: "AIGUKA_NOT_PRIMARY" };\n    if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_DISABLED") return { allowed: false, reason: "PAGE_EXTERNAL_BOT_NOT_DISABLED" };\n  }\n\n  const cutover = supportMode ? page?.settings?.support_cutover_at : page?.settings?.active_cutover_at;\n  if (!cutover || !isAfterOrEqual(decision.created_at, cutover)) return { allowed: false, reason: "PRE_CUTOVER_DECISION" };\n  if (Date.now() - Date.parse(decision.created_at) > MAX_DECISION_AGE_MS) return { allowed: false, reason: "DECISION_TOO_OLD" };\n\n  const text = String(output.final_reply || "").trim();\n  if (!text || ["suppress", "contact_captured"].includes(decision.action)) return { allowed: false, reason: "NO_SEND_ACTION" };\n  if (Number(decision.confidence || output.confidence || 0) < 0.55) return { allowed: false, reason: "CONFIDENCE_TOO_LOW" };\n\n  const state = await stateRow(decision.page_id, decision.sender_id);\n  const takeoverUntil = Date.parse(state.human_takeover_until || "");\n  if (state.human_takeover && (!Number.isFinite(takeoverUntil) || takeoverUntil > Date.now())) return { allowed: false, reason: "HUMAN_TAKEOVER" };\n  if (state.phone || state.zalo || ["captured", "verified"].includes(String(state.contact_status || "").toLowerCase())) return { allowed: false, reason: "CONTACT_ALREADY_CAPTURED" };\n\n  if (supportMode) {\n    const signature = String(output.support_catalog_signature || "");\n    if (await supportAlreadyDelivered(decision, signature)) return { allowed: false, reason: "SUPPORT_CATALOG_ALREADY_SENT_24H" };\n  } else if (state.last_page_event_at && state.last_customer_event_at && isAfterOrEqual(state.last_page_event_at, state.last_customer_event_at)) {\n    return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };\n  }\n  return { allowed: true, page, state, text, supportMode };\n}`;
    source = source.slice(0, finalStart) + finalGate + source.slice(finalEnd);

    const assetsAnchor = "  const assets = await resolveAssets(claimed).catch(() => []);\n  const bundle = await bundleFor(claimed, gate.text, assets);";
    const assetsReplacement = `  const assets = await resolveAssets(claimed).catch(() => []);\n  if (gate.supportMode && !assets.length) {\n    await patchDecision(claimed, "live_suppressed", {\n      should_send: false,\n      transport_locked: true,\n      live_suppression_reason: "SUPPORT_NO_PUBLISHED_ASSET",\n    });\n    return { sent: 0, suppressed: 1, failed: 0 };\n  }\n  const bundle = await bundleFor(claimed, gate.text, assets);`;
    source = replaceOnce(source, assetsAnchor, assetsReplacement, "SUPPORT_OUTBOUND_ASSETS");

    const tryAnchor = "  try {\n    let textResult = null;";
    const supportDelivery = `  if (gate.supportMode) {\n    try {\n      let slideResult = null;\n      let textResult = null;\n      if (!slidesAlreadySent) {\n        slideResult = await sendCarousel(claimed.page_id, claimed.sender_id, assets);\n        if (!slideResult) throw new Error("SUPPORT_CAROUSEL_EMPTY");\n        await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_carousel", "sent", slideResult);\n      }\n      if (!textAlreadySent) {\n        textResult = await sendText(claimed.page_id, claimed.sender_id, gate.text);\n        await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_text", "sent", textResult);\n      }\n      await core(\`v9_delivery_bundles?id=eq.\${bundle.id}\`, {\n        method: "PATCH", prefer: "return=minimal",\n        body: { status: "sent", updated_at: new Date().toISOString() },\n      });\n      await patchDecision(claimed, "live_delivered", {\n        should_send: true,\n        transport_locked: false,\n        delivery_bundle_id: bundle.id,\n        provider_message_id: textResult?.message_id\n          || (existing || []).find((item) => item.transport === "meta_messenger_text" && item.status === "sent")?.provider_message_id\n          || null,\n        delivered_at: new Date().toISOString(),\n        media_warning: null,\n      });\n      await core(\`v9_conversation_state?page_id=eq.\${encodeURIComponent(claimed.page_id)}&sender_id=eq.\${encodeURIComponent(claimed.sender_id)}\`, {\n        method: "PATCH", prefer: "return=minimal",\n        body: { state: "BOT_REPLIED", last_page_event_at: new Date().toISOString(), updated_at: new Date().toISOString() },\n      }).catch(() => {});\n      return { sent: 1, suppressed: 0, failed: 0 };\n    } catch (error) {\n      await recordAttempt(bundle.id, nextAttempt, "meta_messenger_support", "failed", {}, error).catch(() => {});\n      await core(\`v9_delivery_bundles?id=eq.\${bundle.id}\`, {\n        method: "PATCH", prefer: "return=minimal",\n        body: { status: "failed", updated_at: new Date().toISOString() },\n      }).catch(() => {});\n      await patchDecision(claimed, "live_delivery_failed", {\n        should_send: true,\n        transport_locked: false,\n        delivery_bundle_id: bundle.id,\n        live_delivery_error: String(error.message || error).slice(0, 800),\n      }).catch(() => {});\n      return { sent: 0, suppressed: 0, failed: 1 };\n    }\n  }\n\n${tryAnchor}`;
    source = replaceOnce(source, tryAnchor, supportDelivery, "SUPPORT_OUTBOUND_SEND_ORDER");

    source = source.replace(
      'body: { status: partial ? "partial" : "sent", updated_at: new Date().toISOString() },',
      'body: { status: partial ? "failed" : "sent", updated_at: new Date().toISOString() },',
    );
    fs.writeFileSync(file, source);
  }
}

for (const file of [
  "v9/core/turn-builder.js",
  "v9-direct-core-worker.js",
  "v9/core/knowledge-selector.js",
  "v9-ai-shadow-worker.js",
  "v9-live-outbound-worker.js",
]) syntaxCheck(file);

console.log("[AIGUKA V9] SUPPORT slide-only installed: AICAKE primary, deterministic catalog/media assistant, no AI provider calls");
