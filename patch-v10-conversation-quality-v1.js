import fs from "node:fs";

const MARK = "AIGUKA_V10_CONVERSATION_QUALITY_V1";

function patchFile(path, transform) {
  if (!fs.existsSync(path)) throw new Error(`V10_QUALITY_FILE_MISSING:${path}`);
  const before = fs.readFileSync(path, "utf8");
  if (before.includes(MARK)) return;
  const after = transform(before);
  if (after === before) throw new Error(`V10_QUALITY_PATCH_NO_CHANGE:${path}`);
  fs.writeFileSync(path, after, "utf8");
}

patchFile("v10/core/decision-contract.js", (source) => {
  const target = '    "Xưng em và gọi anh/chị khi chưa có bằng chứng giới tính đáng tin cậy.",';
  if (!source.includes(target)) throw new Error("V10_QUALITY_PROMPT_TARGET_MISSING");
  return source.replace(target, [
    '    "ƯU TIÊN NGỮ CẢNH: câu khách vừa nói và nhu cầu rõ gần nhất có quyền ưu tiên cao hơn quảng cáo, mapping và nhu cầu cũ. Câu ngắn như số đó, gọi đi, cô đang rảnh phải được hiểu nối tiếp các tin ngay trước, không được đổi sang chủ đề khác.",',
    '    "CATALOG: selected_catalog_keys chỉ được chứa từng mã catalog_key nguyên vẹn có trong knowledge_advisors.allowed_catalog_keys; mỗi phần tử đúng một mã, không dấu chấm/phẩy, không gộp nhiều mã, không giải thích, không ghi tên trường schema.",',
    '    "SLIDE: chỉ needs_slides=true khi có ít nhất một nhóm trong knowledge_advisors.slide_catalog. Với nhu cầu rộng toàn bộ phòng bếp, phải chia mẫu cân bằng giữa bếp từ/máy hút mùi và chậu/vòi nếu cả hai nhóm có ảnh; không được gửi toàn bộ ảnh từ một nhóm phụ.",',
    '    "Không bao giờ đưa suy nghĩ nội bộ, hướng dẫn, phân tích, tiếng Anh giải thích quyết định, tên trường như selected_catalog_keys/intents/final_reply hoặc câu kiểu we need/customer mentioned/provide concise vào bất kỳ trường đầu ra nào.",',
    '    "XƯNG HÔ THEO LỜI KHÁCH: khách tự xưng cô thì gọi cô và xưng cháu; tự xưng chú thì gọi chú và xưng cháu; tự xưng bác thì gọi bác và xưng cháu; tự xưng chị thì gọi chị và xưng em; tự xưng anh thì gọi anh và xưng em. Không dùng cô-em, chú-em hoặc bác-em.",',
    '    "Khi chưa có bằng chứng cách xưng hô đáng tin cậy, xưng em và gọi anh/chị.",',
    `    "${MARK}",`,
  ].join("\n"));
});

patchFile("v10/core/knowledge-advisor.js", (source) => {
  let out = source;
  const documentsLine = '  const documents = Array.isArray(content.documents) ? content.documents : [];';
  if (!out.includes(documentsLine)) throw new Error("V10_QUALITY_DOCUMENTS_TARGET_MISSING");
  out = out.replace(documentsLine, `  const rawDocuments = Array.isArray(content.documents) ? content.documents : [];\n  const latestDocumentByKey = new Map();\n  for (const document of rawDocuments) {\n    const key = String(document?.document_key || document?.title || "");\n    if (!key) continue;\n    const current = latestDocumentByKey.get(key);\n    if (!current || Number(document?.version_no || 0) > Number(current?.version_no || 0)) latestDocumentByKey.set(key, document);\n  }\n  const documents = [...latestDocumentByKey.values()]; // ${MARK}`);

  const conversationBlock = `  const conversationText = (conversation.messages || []).filter((message) => message.role === "customer").map((message) => message.text).join(" ");\n  const candidateKeys = (conversation.advisors?.product_candidates || []).map((item) => item.key);\n  const tokens = words(\`${'${conversationText}'} ${'${candidateKeys.join(" ")}'}\`);`;
  if (!out.includes(conversationBlock)) throw new Error("V10_QUALITY_CONVERSATION_TARGET_MISSING");
  out = out.replace(conversationBlock, `  const customerMessages = (conversation.messages || []).filter((message) => message.role === "customer" && String(message.text || "").trim());\n  const latestCustomerText = String(customerMessages.at(-1)?.text || "");\n  const recentCustomerText = customerMessages.slice(-4, -1).map((message) => message.text).join(" ");\n  const conversationText = customerMessages.map((message) => message.text).join(" ");\n  const candidateKeys = (conversation.advisors?.product_candidates || []).map((item) => item.key);\n  const latestTokens = words(latestCustomerText);\n  const recentTokens = words(recentCustomerText);\n  const tokens = unique([...latestTokens, ...recentTokens, ...words(candidateKeys.join(" "))]);`);

  const scoreBlock = `      const exact = candidateKeys.includes(node.catalog_key) ? 10 : 0;\n      const score = exact + scoreText(catalogText(node), tokens);`;
  if (!out.includes(scoreBlock)) throw new Error("V10_QUALITY_CATALOG_SCORE_TARGET_MISSING");
  out = out.replace(scoreBlock, `      const exact = candidateKeys.includes(node.catalog_key) ? 4 : 0;\n      const latestScore = scoreText(catalogText(node), latestTokens) * 8;\n      const recentScore = scoreText(catalogText(node), recentTokens) * 2;\n      const score = exact + latestScore + recentScore;`);

  const fallbackFilter = '    .filter((item, index) => item.score > 0 || index < 4)';
  if (!out.includes(fallbackFilter)) throw new Error("V10_QUALITY_CATALOG_FILTER_TARGET_MISSING");
  out = out.replace(fallbackFilter, '    .filter((item) => item.score > 0)');

  const returnCatalog = `    catalog: selectedCatalog,\n    ad_mappings: selectedMappings,`;
  if (!out.includes(returnCatalog)) throw new Error("V10_QUALITY_CATALOG_RETURN_TARGET_MISSING");
  out = out.replace(returnCatalog, `    latest_customer_text: latestCustomerText,\n    catalog: selectedCatalog,\n    slide_catalog: selectedCatalog.filter((item) => Number(item.asset_count || 0) > 0),\n    allowed_catalog_keys: selectedCatalog.map((item) => item.catalog_key).filter(Boolean),\n    ad_mappings: selectedMappings,`);
  return out;
});

patchFile("v10/core/conversation-assembler.js", (source) => {
  let out = source;
  const roleLine = '  if (["bot", "automation", "page"].includes(actor) || ["bot_message", "automation_message", "page_message"].includes(type)) return actor === "automation" ? "automation" : actor === "bot" ? "bot" : "page";';
  if (!out.includes(roleLine)) throw new Error("V10_QUALITY_ROLE_TARGET_MISSING");
  out = out.replace(roleLine, '  if (["bot", "automation", "page", "page_unknown"].includes(actor) || ["bot_message", "automation_message", "page_message"].includes(type)) return actor === "automation" ? "automation" : actor === "bot" ? "bot" : "page"; // ' + MARK);
  out = out.replace('      latest_message_is_not_authoritative: true,', '      latest_explicit_customer_intent_has_priority: true,');
  return out;
});

patchFile("v10-outbound-worker.js", (source) => {
  let out = source;
  out = out.replace('const MAX_MEDIA_ASSETS = Math.max(10, Math.min(30, Number(process.env.AIGUKA_V10_MAX_MEDIA_ASSETS || 30)));', `const MAX_MEDIA_ASSETS = Math.max(10, Math.min(20, Number(process.env.AIGUKA_V10_MAX_MEDIA_ASSETS || 20))); // ${MARK}`);

  const fuzzyBlock = `  const selectedCatalogKeys = new Set((output.selected_catalog_keys || []).map(String));\n  const selectedProducts = (output.selected_products || []).map((value) => normalizeVietnamese(value));\n  const candidates = nodes.filter((node) => {\n    if (selectedCatalogKeys.has(String(node.catalog_key))) return true;\n    const text = nodeText(node);\n    return selectedProducts.some((product) => product && (text.includes(product) || product.includes(normalizeVietnamese(node.catalog_key))));\n  });`;
  if (!out.includes(fuzzyBlock)) throw new Error("V10_QUALITY_OUTBOUND_CANDIDATE_TARGET_MISSING");
  out = out.replace(fuzzyBlock, `  const knownKeys = new Set(nodes.map((node) => String(node.catalog_key || "")).filter(Boolean));\n  const selectedCatalogKeys = new Set((output.selected_catalog_keys || [])\n    .map((value) => String(value || "").trim().replace(/^[\\s\\[\\]\\x60'\"]+|[\\s\\[\\]\\x60'\".,;:]+$/g, ""))\n    .filter((value) => knownKeys.has(value)));\n  const candidates = nodes.filter((node) => selectedCatalogKeys.has(String(node.catalog_key)));`);

  const patchDecisionEnd = `async function patchDecision(decision, status, details = {}) {\n  await core(\`v9_decisions?id=eq.${'${decision.id}'}\`, {\n    method: "PATCH",\n    prefer: "return=minimal",\n    body: { status, output: { ...(decision.output || {}), ...details }, updated_at: new Date().toISOString() },\n  });\n}`;
  if (!out.includes(patchDecisionEnd)) throw new Error("V10_QUALITY_OUTBOUND_EVENT_TARGET_MISSING");
  out = out.replace(patchDecisionEnd, `${patchDecisionEnd}\n\nasync function recordOutboundEvent(decision, text, assets, providerMessageId = null) {\n  const occurredAt = new Date().toISOString();\n  await core("v9_events?on_conflict=source_event_id", {\n    method: "POST",\n    prefer: "resolution=ignore-duplicates,return=minimal",\n    body: {\n      source_system: "aiguka_v10_outbound",\n      source_event_id: \`v10_outbound:${'${decision.id}'}\`,\n      page_id: String(decision.page_id || ""),\n      sender_id: String(decision.page_id || ""),\n      customer_id: String(decision.sender_id || ""),\n      recipient_id: String(decision.sender_id || ""),\n      message_id: providerMessageId || \`v10:${'${decision.id}'}\`,\n      actor_type: "bot",\n      actor_evidence: { method: "v10_outbound_delivery_v1", human_verified: false },\n      event_type: "bot_message",\n      message_text: String(text || ""),\n      attachments: Array.isArray(assets) ? assets.map((asset) => ({ type: "image", catalog_key: asset.catalog_key, source_url: asset.source_url })) : [],\n      referral: null,\n      occurred_at: occurredAt,\n      received_at: occurredAt,\n      payload: { decision_id: decision.id, catalog_keys: [...new Set((assets || []).map((asset) => asset.catalog_key).filter(Boolean))] },\n    },\n  });\n}`);

  const deliveryPatch = `    await patchDecision(claimed, partial ? "live_delivered_partial" : "live_delivered", {`;
  if (!out.includes(deliveryPatch)) throw new Error("V10_QUALITY_OUTBOUND_RECORD_CALL_TARGET_MISSING");
  const afterDecisionPatch = `      contact_request_sanitized: Boolean(gate.contactKnown && claimed.output?.should_request_contact),\n    });\n    await core(\`v9_conversation_state?page_id=eq.${'${encodeURIComponent(claimed.page_id)}'}&sender_id=eq.${'${encodeURIComponent(claimed.sender_id)}'}\`, {`;
  if (!out.includes(afterDecisionPatch)) throw new Error("V10_QUALITY_OUTBOUND_RECORD_INSERT_TARGET_MISSING");
  out = out.replace(afterDecisionPatch, `      contact_request_sanitized: Boolean(gate.contactKnown && claimed.output?.should_request_contact),\n    });\n    await recordOutboundEvent(claimed, gate.text, media.assets, textResult?.message_id || null).catch(() => {});\n    await core(\`v9_conversation_state?page_id=eq.${'${encodeURIComponent(claimed.page_id)}'}&sender_id=eq.${'${encodeURIComponent(claimed.sender_id)}'}\`, {`);
  return out;
});

console.log("[AIGUKA V10] conversation quality v1 installed: clean context, exact catalog mapping, two-way history");
