import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_SUPPORT_FAST_VISION_V1";

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(oldValue, newValue);
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`SUPPORT_VISION_SYNTAX_${file}:${result.stderr || result.stdout}`);
}

// Keep customer attachments on the turn. Sticker images are not treated as product photos.
{
  const file = "v9/core/turn-builder.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = replaceOnce(
      source,
      "  const salesSignals = extractSalesSignals(combinedText);",
      `  const salesSignals = extractSalesSignals(combinedText);\n  const combinedAttachments = customerEvents.flatMap((event) => Array.isArray(event?.attachments) ? event.attachments : []);\n  const realImageAttachments = combinedAttachments.filter((attachment) => {\n    const type = String(attachment?.type || "").toLowerCase();\n    const stickerId = attachment?.payload?.sticker_id || attachment?.sticker_id;\n    const url = String(attachment?.payload?.url || attachment?.url || "").trim();\n    return type === "image" && !stickerId && /^https?:\\/\\//i.test(url);\n  }); // ${MARKER}`,
      "SUPPORT_VISION_TURN_ATTACHMENTS",
    );
    source = replaceOnce(
      source,
      "      text: event?.message_text ?? event?.text ?? null,\n    })),",
      "      text: event?.message_text ?? event?.text ?? null,\n      attachments: Array.isArray(event?.attachments) ? event.attachments : [],\n    })),",
      "SUPPORT_VISION_CUSTOMER_MESSAGE_ATTACHMENTS",
    );
    source = replaceOnce(
      source,
      "    combinedText,\n    contact,",
      "    combinedText,\n    combinedAttachments,\n    hasImage: realImageAttachments.length > 0,\n    imageCount: realImageAttachments.length,\n    contact,",
      "SUPPORT_VISION_TURN_OUTPUT",
    );
    fs.writeFileSync(file, source);
  }
}

// SUPPORT fast path: normal text remains AIcake-owned; explicit sample requests use Mapping;
// real customer photos are sent to a vision-capable provider and may receive exactly one sentence.
{
  const file = "v9-ai-shadow-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_support_fast_vision_v6";');
    source = source.replace(
      'const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V9_AI_POLL_MS || 5000));',
      'const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_V9_AI_POLL_MS || 1500));',
    );

    const helperAnchor = "async function supportPage(pageId) {";
    const helpers = `function supportImageUrls(snapshot = {}) {\n  const turn = snapshot.turn || {};\n  const attachments = Array.isArray(turn.combinedAttachments)\n    ? turn.combinedAttachments\n    : (Array.isArray(turn.customerMessages) ? turn.customerMessages : [])\n      .flatMap((message) => Array.isArray(message?.attachments) ? message.attachments : []);\n  return [...new Set(attachments\n    .filter((attachment) => {\n      const type = String(attachment?.type || "").toLowerCase();\n      const stickerId = attachment?.payload?.sticker_id || attachment?.sticker_id;\n      return type === "image" && !stickerId;\n    })\n    .map((attachment) => String(attachment?.payload?.url || attachment?.url || "").trim())\n    .filter((url) => /^https?:\\/\\//i.test(url)))]\n    .slice(0, 2);\n}\n\nfunction supportVisionCatalogIndex(knowledgeSnapshot = {}) {\n  const nodes = Array.isArray(knowledgeSnapshot?.content?.catalog) ? knowledgeSnapshot.content.catalog : [];\n  return nodes\n    .filter((node) => node?.is_active !== false\n      && String(node?.catalog_key || "").trim()\n      && Array.isArray(node?.assets)\n      && node.assets.some((asset) => String(asset?.source_url || "").trim()))\n    .slice(0, 120)\n    .map((node) => ({\n      catalog_key: String(node.catalog_key),\n      display_name: String(node.display_name || node.catalog_key),\n      aliases: Array.isArray(node.aliases) ? node.aliases.slice(0, 12) : [],\n    }));\n}\n\nfunction supportEnsureSelectedCatalog(selectedKnowledge = {}, knowledgeSnapshot = {}, keys = []) {\n  const requested = new Set((Array.isArray(keys) ? keys : []).map((value) => String(value || "").trim()).filter(Boolean));\n  if (!requested.size) return;\n  const existing = Array.isArray(selectedKnowledge.catalog) ? selectedKnowledge.catalog : [];\n  const existingKeys = new Set(existing.map((node) => String(node?.catalog_key || "")));\n  const allNodes = Array.isArray(knowledgeSnapshot?.content?.catalog) ? knowledgeSnapshot.content.catalog : [];\n  const additions = allNodes\n    .filter((node) => requested.has(String(node?.catalog_key || "")) && !existingKeys.has(String(node?.catalog_key || "")))\n    .map((node) => ({\n      catalog_key: node.catalog_key,\n      parent_key: node.parent_key || null,\n      root_key: node.root_key || null,\n      display_name: node.display_name,\n      node_type: node.node_type,\n      aliases: Array.isArray(node.aliases) ? node.aliases.slice(0, 20) : [],\n      intents: Array.isArray(node.intents) ? node.intents.slice(0, 12) : [],\n      rules: Array.isArray(node.rules) ? node.rules.slice(0, 20) : [],\n      asset_policy: node.asset_policy || {},\n      assets: (Array.isArray(node.assets) ? node.assets : []).slice(0, 10),\n    }));\n  selectedKnowledge.catalog = [...existing, ...additions];\n}\n\nfunction supportVisionInstructions() {\n  return [\n    "Bạn đang xử lý nhánh SUPPORT ảnh của AIGUKA; AIcake vẫn là bot trả lời chính cho hội thoại thông thường.",\n    "Hãy quan sát ảnh khách vừa gửi và chọn catalog_key chính xác nhất chỉ từ vision_catalog_index.",\n    "Nếu ảnh không đủ rõ để xác định, products phải là mảng rỗng; tuyệt đối không đoán bừa.",\n    "Không báo giá, không khẳng định mã sản phẩm, chất liệu hoặc thông số nếu ảnh không chứng minh được.",\n    "Chỉ trả về quyết định theo tool schema; phần gửi ra khách sẽ được hệ thống chuẩn hóa thành đúng một câu xin SĐT/Zalo.",\n  ].join("\\n");\n}\n\nfunction supportImageDecision(raw = {}, snapshot = {}, selectedKnowledge = {}, knowledgeSnapshot = {}, page = {}, imageUrls = []) {\n  const turn = snapshot.turn || {};\n  const contactCaptured = Boolean(turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);\n  const intents = [...new Set([...(Array.isArray(raw.intents) ? raw.intents : []), "image"] )];\n  if (contactCaptured) {\n    return {\n      action: "contact_captured", final_reply: "", should_request_contact: false, contact_benefit: "",\n      products: [], intents, needs_slides: false, confidence: 1,\n      reason: "SUPPORT image: contact already captured.", risk_flags: [],\n      support_mode: true, support_image_reply: true, customer_image_count: imageUrls.length,\n      support_catalog_signature: "", support_fixed_salutation: "em-anh_chi",\n    };\n  }\n\n  const index = supportVisionCatalogIndex(knowledgeSnapshot);\n  const byKey = new Map(index.map((item) => [item.catalog_key, item]));\n  const products = [...new Set((Array.isArray(raw.products) ? raw.products : [])\n    .map((value) => String(value || "").trim())\n    .filter((key) => byKey.has(key)))]\n    .slice(0, 3);\n  supportEnsureSelectedCatalog(selectedKnowledge, knowledgeSnapshot, products);\n  const labels = products.map((key) => byKey.get(key)?.display_name || key).filter(Boolean);\n  const hasSlides = products.length > 0;\n  const finalReply = hasSlides\n    ? \`Dạ em đã xem ảnh, mẫu này thuộc nhóm \${labels.join(", ")}; anh/chị cho em xin SĐT hoặc Zalo để bên em tư vấn chính xác và gửi thêm mẫu phù hợp nhé.\`\n    : "Dạ em đã xem ảnh mẫu anh/chị gửi; anh/chị cho em xin SĐT hoặc Zalo để bên em xác định đúng sản phẩm, tư vấn chính xác và gửi mẫu phù hợp nhé.";\n  return {\n    action: hasSlides ? "reply_with_slides" : "reply_text",\n    final_reply: finalReply.replace(/\\s+/g, " ").trim().slice(0, 300),\n    should_request_contact: true,\n    contact_benefit: "Xác định đúng sản phẩm, tư vấn chính xác và gửi mẫu phù hợp.",\n    products, intents, needs_slides: hasSlides,\n    confidence: Math.max(0.55, Math.min(1, Number(raw.confidence || (hasSlides ? 0.82 : 0.62)))),\n    reason: hasSlides ? "SUPPORT image: vision matched an exact published catalog." : "SUPPORT image: vision could not safely resolve an exact catalog.",\n    risk_flags: [...new Set([...(Array.isArray(raw.risk_flags) ? raw.risk_flags : []), ...(hasSlides ? [] : ["vision_catalog_unresolved"])])],\n    support_mode: true,\n    support_image_reply: true,\n    customer_image_count: imageUrls.length,\n    support_catalog_signature: products.join("|"),\n    support_fixed_salutation: "em-anh_chi",\n    support_page_id: page.page_id || snapshot.page_id || null,\n  };\n}\n\n${helperAnchor}`;
    source = replaceOnce(source, helperAnchor, helpers, "SUPPORT_VISION_HELPERS");

    source = replaceOnce(
      source,
      "  const apiKey = decryptProviderKey(ai.api_key_ciphertext);\n  const providerName = String(ai.provider_key || ai.provider_type || \"\").toLowerCase();",
      `  const apiKey = decryptProviderKey(ai.api_key_ciphertext);\n  const providerName = String(ai.provider_key || ai.provider_type || "").toLowerCase();\n  const supportImages = Array.isArray(modelInput?.support_images) ? modelInput.support_images.slice(0, 2) : [];\n  const systemInstructions = [buildDecisionInstructions(), String(modelInput?.support_system_instructions || "").trim()]\n    .filter(Boolean).join("\\n"); // ${MARKER}`,
      "SUPPORT_VISION_PROVIDER_SETUP",
    );
    source = replaceOnce(
      source,
      '{ role: "system", content: buildDecisionInstructions() },\n          { role: "user", content: JSON.stringify(modelInput) },',
      `{ role: "system", content: systemInstructions },\n          {\n            role: "user",\n            content: supportImages.length\n              ? [\n                { type: "text", text: JSON.stringify(modelInput) },\n                ...supportImages.map((url) => ({ type: "image_url", image_url: { url } })),\n              ]\n              : JSON.stringify(modelInput),\n          },`,
      "SUPPORT_VISION_GEMINI_INPUT",
    );
    source = replaceOnce(
      source,
      "      instructions: buildDecisionInstructions(),",
      "      instructions: systemInstructions,",
      "SUPPORT_VISION_OPENAI_INSTRUCTIONS",
    );
    source = replaceOnce(
      source,
      '      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(modelInput) }] }],',
      `      input: [{\n        role: "user",\n        content: [\n          { type: "input_text", text: JSON.stringify(modelInput) },\n          ...supportImages.map((url) => ({ type: "input_image", image_url: url, detail: "low" })),\n        ],\n      }],`,
      "SUPPORT_VISION_OPENAI_INPUT",
    );

    source = replaceOnce(
      source,
      '  const recognizedProduct = catalogKeys.length > 0 && (products.length > 0 || adMappings.length > 0);\n  if (!recognizedProduct) {',
      `  const wantsSamples = intents.includes("samples") || /mẫu|hình|ảnh|catalog|slide|xem/i.test(String(turn.combinedText || ""));\n  const recognizedProduct = catalogKeys.length > 0 && (products.length > 0 || adMappings.length > 0);\n  if (!wantsSamples || !recognizedProduct) { // ${MARKER}`,
      "SUPPORT_VISION_SAMPLE_ONLY",
    );

    const supportStart = source.indexOf("  const page = await supportPage(snapshot.page_id);");
    const supportEnd = source.indexOf("\n\n  let fallback = false;", supportStart);
    if (supportStart < 0 || supportEnd < 0) throw new Error("SUPPORT_VISION_DECISION_BLOCK_NOT_FOUND");
    const supportBlock = `  const page = await supportPage(snapshot.page_id);\n  const supportImages = supportImageUrls(snapshot);\n  if (page && supportImages.length) {\n    modelInput.support_images = supportImages;\n    modelInput.support_system_instructions = supportVisionInstructions();\n    modelInput.vision_catalog_index = supportVisionCatalogIndex(knowledgeSnapshot);\n    for (const ai of providerRows) {\n      try {\n        const result = await providerCall(ai, modelInput);\n        rawDecision = result.decision;\n        responseId = result.responseId;\n        usedModel = result.model;\n        usedProvider = ai.provider_key || ai.provider_type;\n        providerCache.lastProviderKey = usedProvider;\n        break;\n      } catch (error) {\n        providerErrors.push(\`\${ai.provider_key || ai.provider_type}:\${String(error?.message || error).slice(0, 240)}\`);\n      }\n    }\n    rawDecision = supportImageDecision(rawDecision || {}, snapshot, selectedKnowledge, knowledgeSnapshot, page, supportImages);\n    usedProvider ||= "support_vision_fallback";\n    usedModel ||= "support_fast_vision_v1";\n    providerCache.lastProviderKey = usedProvider;\n  } else if (page) {\n    rawDecision = supportSlideDecision(snapshot, selectedKnowledge, page);\n    usedProvider = "support_rule";\n    usedModel = "support_slide_only_v2";\n    providerCache.lastProviderKey = usedProvider;\n  }\n\n  if (!rawDecision) {\n    for (const ai of providerRows) {\n      try {\n        const result = await providerCall(ai, modelInput);\n        rawDecision = result.decision;\n        responseId = result.responseId;\n        usedModel = result.model;\n        usedProvider = ai.provider_key || ai.provider_type;\n        providerCache.lastProviderKey = usedProvider;\n        break;\n      } catch (error) {\n        providerErrors.push(\`\${ai.provider_key || ai.provider_type}:\${String(error?.message || error).slice(0, 240)}\`);\n      }\n    }\n  }`;
    source = source.slice(0, supportStart) + supportBlock + source.slice(supportEnd);
    fs.writeFileSync(file, source);
  }
}

// Outbound guard: SUPPORT may send slides, or exactly one short text when a real photo was received.
{
  const file = "v9-live-outbound-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_live_outbound_support_fast_vision_v4";');
    source = source.replace(
      'const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_V9_LIVE_OUTBOUND_POLL_MS || 3000));',
      'const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_V9_LIVE_OUTBOUND_POLL_MS || 1500));',
    );
    source = replaceOnce(
      source,
      `    if (output.support_mode !== true || decision.action !== "reply_with_slides" || output.needs_slides !== true) {\n      return { allowed: false, reason: "SUPPORT_SLIDE_ONLY" };\n    }`,
      `    const supportImageReply = output.support_image_reply === true && Number(output.customer_image_count || 0) > 0;\n    const supportSlideReply = decision.action === "reply_with_slides" && output.needs_slides === true;\n    const supportImageAction = supportImageReply && ["reply_text", "reply_with_slides"].includes(decision.action);\n    if (output.support_mode !== true || (!supportSlideReply && !supportImageAction)) {\n      return { allowed: false, reason: "SUPPORT_SLIDE_OR_IMAGE_ONLY" };\n    }\n    if (supportImageReply) {\n      const imageText = String(output.final_reply || "").trim();\n      const terminators = (imageText.match(/[.!?](?:\\s|$)/g) || []).length;\n      if (!imageText || imageText.includes("\\n") || imageText.length > 300 || terminators > 1 || output.should_request_contact !== true) {\n        return { allowed: false, reason: "SUPPORT_IMAGE_ONE_SENTENCE_REQUIRED" };\n      }\n    } // ${MARKER}`,
      "SUPPORT_VISION_FINAL_GATE",
    );
    source = replaceOnce(
      source,
      `  if (supportMode) {\n    const signature = String(output.support_catalog_signature || "");\n    if (await supportAlreadyDelivered(decision, signature)) return { allowed: false, reason: "SUPPORT_CATALOG_ALREADY_SENT_24H" };\n  } else if`,
      `  if (supportMode) {\n    const signature = String(output.support_catalog_signature || "");\n    if (output.support_image_reply !== true && await supportAlreadyDelivered(decision, signature)) {\n      return { allowed: false, reason: "SUPPORT_CATALOG_ALREADY_SENT_24H" };\n    }\n  } else if`,
      "SUPPORT_VISION_DEDUPE",
    );
    source = replaceOnce(
      source,
      `  if (gate.supportMode && !assets.length) {\n    await patchDecision(claimed, "live_suppressed", {\n      should_send: false,\n      transport_locked: true,\n      live_suppression_reason: "SUPPORT_NO_PUBLISHED_ASSET",\n    });\n    return { sent: 0, suppressed: 1, failed: 0 };\n  }`,
      `  if (gate.supportMode && !assets.length && claimed?.output?.support_image_reply !== true) {\n    await patchDecision(claimed, "live_suppressed", {\n      should_send: false,\n      transport_locked: true,\n      live_suppression_reason: "SUPPORT_NO_PUBLISHED_ASSET",\n    });\n    return { sent: 0, suppressed: 1, failed: 0 };\n  }`,
      "SUPPORT_VISION_ASSET_FALLBACK",
    );
    source = replaceOnce(
      source,
      `      if (!slidesAlreadySent) {\n        slideResult = await sendCarousel(claimed.page_id, claimed.sender_id, assets);\n        if (!slideResult) throw new Error("SUPPORT_CAROUSEL_EMPTY");\n        await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_carousel", "sent", slideResult);\n      }`,
      `      if (!slidesAlreadySent && assets.length) {\n        slideResult = await sendCarousel(claimed.page_id, claimed.sender_id, assets);\n        if (!slideResult) throw new Error("SUPPORT_CAROUSEL_EMPTY");\n        await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_carousel", "sent", slideResult);\n      }`,
      "SUPPORT_VISION_OPTIONAL_CAROUSEL",
    );
    fs.writeFileSync(file, source);
  }
}

// Faster ingestion without removing the five-second co-existence settling window.
{
  const file = "v9-direct-core-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_direct_core_support_fast_v2";');
    source = source.replace(
      'const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V9_CORE_POLL_MS || 5000));',
      'const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_V9_CORE_POLL_MS || 1500));',
    );
    source = `${source}\n// ${MARKER}\n`;
    fs.writeFileSync(file, source);
  }
}

for (const file of [
  "v9/core/turn-builder.js",
  "v9-direct-core-worker.js",
  "v9-ai-shadow-worker.js",
  "v9-live-outbound-worker.js",
]) syntaxCheck(file);

console.log("[AIGUKA V9] SUPPORT fast vision installed: AIcake primary; AIGUKA reads real customer photos, sends exact slides and may send one contact sentence");
