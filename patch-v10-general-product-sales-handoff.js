import fs from "node:fs";

// The specific-price patch defines specificPriceSubject() and applies the first price guard.
// Load it here so this general patch is deterministic even when startup workers are detached.
await import("./patch-v10-specific-price-contact.js");

const AI_FILE = "v10-ai-worker-final.js";
const OUTBOUND_FILE = "v10-outbound-worker.js";
const AI_MARK = "AIGUKA_V10_GENERAL_PRODUCT_SALES_HANDOFF_V1";
const OUTBOUND_MARK = "AIGUKA_V10_CUSTOMER_TURN_SUPERSESSION_V1";

if (!fs.existsSync(AI_FILE)) throw new Error("V10_GENERAL_SALES_AI_WORKER_MISSING");
if (!fs.existsSync(OUTBOUND_FILE)) throw new Error("V10_GENERAL_SALES_OUTBOUND_WORKER_MISSING");

let ai = fs.readFileSync(AI_FILE, "utf8");

if (!ai.includes(AI_MARK)) {
  const helperAnchor = "function unsupportedStockClaim(value, modelInput) {";
  if (!ai.includes(helperAnchor)) throw new Error("V10_GENERAL_SALES_HELPER_ANCHOR_MISSING");

  const helpers = String.raw`function currentCustomerRawCluster(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1)
    .filter(function (message) { return message && message.role === "customer"; })
    .map(function (message) { return String(message.text || ""); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hardContactRefusalInTurn(modelInput) {
  const text = qualityNormalize(currentCustomerRawCluster(modelInput));
  return /\b(dung xin|dung hoi|khong cho so|khong dua so|khong can goi|khong lien he|khong sdt|khong so dien thoai|khong zalo)\b/.test(text);
}

function commercialProductNeedDetected(decision, modelInput) {
  const raw = currentCustomerRawCluster(modelInput);
  const text = qualityNormalize(raw);
  const intents = qualityNormalize((Array.isArray(decision && decision.intents) ? decision.intents : []).join(" "));
  const advisors = modelInput && modelInput.knowledge_advisors ? modelInput.knowledge_advisors : {};
  const advisorProducts = Array.isArray(advisors.product_candidates) ? advisors.product_candidates : [];
  const selected = Array.isArray(decision && decision.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  const hasProductEvidence = advisorProducts.length > 0 || selected.length > 0 || /\b(bon cau|bet|sen tam|sen cay|lavabo|guong|tu chau|tu lavabo|bon tam|bep tu|hut mui|chau rua|voi rua|phu kien|quat|den|gach|ngoi|combo|phong tam|nha tam|phong bep|nha bep|san pham|mau)\b/.test(text);
  const commercialSignal = /\b(price|gia|bao gia|bao nhieu|samples|sample|xem mau|gui mau|gui anh|catalog|specs|thong so|kich thuoc|cong suat|stock|con hang|co hang|availability|delivery|giao hang|van chuyen|lap dat|bao hanh|xuat xu|thuong hieu|brand|purchase|mua|dat hang|lay hang|chot|uu dai|khuyen mai|giam gia)\b/.test(intents + " " + text);
  return (hasProductEvidence && commercialSignal) || /\b(muon mua|can mua|dat hang|chot don|mua hang)\b/.test(text);
}

function containsCjkOrForeignGlyph(value) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(String(value || ""));
}

function stripRepeatedBusinessIntroduction(value) {
  let text = String(value || "").trim();
  text = text
    .replace(/^\s*(?:chào|xin chào)[^.!?]{0,80}[.!?]\s*/i, "")
    .replace(/^\s*(?:dạ[, ]*)?(?:em|cháu)\s+là\s+(?:nhân viên|tư vấn viên|trợ lý|cố vấn|顾问)[^.!?]{0,160}[.!?]?\s*/i, "")
    .replace(/^\s*(?:em|cháu)\s+(?:đến|từ)\s+showroom[^.!?]{0,120}[.!?]?\s*/i, "")
    .trim();
  return text;
}

function saleHandoffDetected(value) {
  const text = qualityNormalize(value);
  return /\b(chuyen|noi|gui).{0,24}\b(sale|nhan vien kinh doanh|tu van vien)\b|\b(sale|nhan vien kinh doanh).{0,32}\b(kiem tra|bao gia|lien he|tu van)\b/.test(text);
}

function unresolvedPromiseWithoutHandoff(value) {
  const text = qualityNormalize(value);
  return /\b(de em|em se|cho em).{0,40}\b(kiem tra|xem lai).{0,40}\b(bao lai|phan hoi lai|tra loi lai)\b/.test(text)
    && !saleHandoffDetected(value)
    && !contactRequestDetected(value);
}

function generalSalesSubject(modelInput) {
  const subject = typeof specificPriceSubject === "function" ? specificPriceSubject(modelInput) : "mẫu sản phẩm anh/chị đang quan tâm";
  return String(subject || "mẫu sản phẩm anh/chị đang quan tâm")
    .replace(/\s+/g, " ")
    .trim();
}

function generalCommercialHandoffReply(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = generalSalesSubject(modelInput);
  const price = priceIntentDetected(decision, modelInput);
  const sendingSamples = Boolean(decision && (decision.needs_slides || decision.action === "reply_with_slides"));
  let text;
  if (price) {
    text = known
      ? "Dạ, em đã ghi nhận " + subject + ". Em chuyển Sale kiểm tra đúng mẫu/phiên bản và gửi báo giá cùng ưu đãi hiện tại theo thông tin liên hệ mình đã để lại ạ."
      : "Dạ, em đã ghi nhận " + subject + ". Anh/chị cho em xin SĐT hoặc Zalo, em chuyển Sale kiểm tra đúng mẫu/phiên bản, gửi báo giá và ưu đãi hiện tại ạ.";
  } else if (sendingSamples) {
    text = known
      ? "Dạ, em gửi một số mẫu " + subject + " để tham khảo. Em chuyển Sale lọc đúng mẫu, báo giá và ưu đãi theo thông tin liên hệ mình đã để lại ạ."
      : "Dạ, em gửi một số mẫu " + subject + " để tham khảo. Anh/chị cho em xin SĐT hoặc Zalo, em chuyển Sale lọc đúng mẫu, gửi báo giá và ưu đãi hiện tại ạ.";
  } else {
    text = known
      ? "Dạ, em đã ghi nhận nhu cầu về " + subject + ". Em chuyển Sale kiểm tra đúng mẫu/cấu hình và tư vấn theo thông tin liên hệ mình đã để lại ạ."
      : "Dạ, em đã ghi nhận nhu cầu về " + subject + ". Anh/chị cho em xin SĐT hoặc Zalo, em chuyển Sale gửi đúng mẫu, báo giá và ưu đãi hiện tại ạ.";
  }
  return applySalutation(text, style);
}

function enforceGeneralProductSalesHandoff(decision, modelInput) {
  if (!commercialProductNeedDetected(decision, modelInput)) return decision;
  const known = contactIsKnown(modelInput);
  const refused = hardContactRefusalInTurn(modelInput);
  let reply = stripRepeatedBusinessIntroduction(decision.final_reply || "");
  const corrupted = containsCjkOrForeignGlyph(reply) || languageLooksCorrupted(reply);
  const tooLong = reply.length > 520 || (reply.match(/[.!?](?:\s|$)/g) || []).length > 3;
  const missingRequiredContact = !known && !refused && !contactRequestDetected(reply);
  const wrongKnownContact = known && contactRequestDetected(reply);
  const missingSaleHandoff = !refused && !saleHandoffDetected(reply);
  if (corrupted || tooLong || missingRequiredContact || wrongKnownContact || missingSaleHandoff || unresolvedPromiseWithoutHandoff(reply)) {
    reply = generalCommercialHandoffReply(decision, modelInput);
  }
  reply = stripRepeatedBusinessIntroduction(reply).replace(/\s+/g, " ").trim();
  if (containsCjkOrForeignGlyph(reply)) reply = generalCommercialHandoffReply(decision, modelInput);
  decision.final_reply = applySalutation(reply.slice(0, 560), salutationStyle(modelInput));
  decision.contact_state = known ? "known" : "missing";
  decision.should_request_contact = !known && !refused;
  decision.contact_benefit = known
    ? "chuyển Sale lọc đúng mẫu/cấu hình, gửi báo giá và ưu đãi theo liên hệ đã có"
    : refused
      ? "tiếp tục hỗ trợ ngắn trên Messenger theo yêu cầu của khách"
      : "chuyển Sale gửi đúng mẫu, báo giá và ưu đãi hiện tại";
  decision.sales_handoff_required = true;
  decision.general_product_sales_guard = true;
  return decision;
}

// ${AI_MARK}

`;
  ai = ai.replace(helperAnchor, helpers + helperAnchor);

  // Extend the language firewall to reject Chinese/Japanese/Korean glyphs globally.
  const languageTarget = '  if (/[�åäöüæøßłŁćĆśŚźŹżŻńŃ]/i.test(text)) return true;';
  if (!ai.includes(languageTarget)) throw new Error("V10_GENERAL_SALES_LANGUAGE_TARGET_MISSING");
  ai = ai.replace(languageTarget, '  if (/[\\u3400-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]/u.test(text) || /[�åäöüæøßłŁćĆśŚźŹżŻńŃ]/i.test(text)) return true;');

  // Replace the earlier price-only promise with an explicit Sale handoff.
  const safePricePattern = /function safePriceReply\(decision, modelInput\) \{[\s\S]*?\n\}\n\n\/\/ AIGUKA_V10_DECISION_INTEGRITY_V8/;
  if (!safePricePattern.test(ai)) throw new Error("V10_GENERAL_SALES_PRICE_BLOCK_MISSING");
  ai = ai.replace(safePricePattern, String.raw`function safePriceReply(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = generalSalesSubject(modelInput);
  const text = known
    ? "Dạ, em đã ghi nhận " + subject + ". Em chuyển Sale kiểm tra đúng mẫu/phiên bản và gửi báo giá cùng ưu đãi hiện tại theo thông tin liên hệ mình đã để lại ạ."
    : "Dạ, em đã ghi nhận " + subject + ". Anh/chị cho em xin SĐT hoặc Zalo, em chuyển Sale kiểm tra đúng mẫu/phiên bản, gửi báo giá và ưu đãi hiện tại ạ.";
  return applySalutation(text, style);
}

// AIGUKA_V10_DECISION_INTEGRITY_V8`);

  const finalAnchor = "  ensureCurrentTurnCoverage(decision, modelInput);\n  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || \"\"))) throw new Error(\"V10_DECISION_FINAL_REPLY_LEAK_REJECTED\");";
  if (!ai.includes(finalAnchor)) throw new Error("V10_GENERAL_SALES_FINAL_ANCHOR_MISSING");
  ai = ai.replace(finalAnchor, "  ensureCurrentTurnCoverage(decision, modelInput);\n  enforceGeneralProductSalesHandoff(decision, modelInput);\n  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || \"\"))) throw new Error(\"V10_DECISION_FINAL_REPLY_LEAK_REJECTED\");");

  ai = ai.replace("v10_ai_quality_guard_v15", "v10_ai_quality_guard_v16_general_sales");
  if (!ai.includes(AI_MARK) || !ai.includes("sales_handoff_required")) throw new Error("V10_GENERAL_SALES_AI_VALIDATION_FAILED");
  fs.writeFileSync(AI_FILE, ai, "utf8");
}

let outbound = fs.readFileSync(OUTBOUND_FILE, "utf8");
if (!outbound.includes(OUTBOUND_MARK)) {
  const target = `  const customerAt = latestCustomerAt(decision);\n  const pageAt = Date.parse(state.last_page_event_at || \"\");`;
  if (!outbound.includes(target)) throw new Error("V10_CUSTOMER_TURN_SUPERSESSION_TARGET_MISSING");
  const replacement = `  const customerAt = latestCustomerAt(decision);\n  const liveCustomerAt = Date.parse(state.last_customer_event_at || \"\");\n  if (customerAt > 0 && Number.isFinite(liveCustomerAt) && liveCustomerAt > customerAt + 250) {\n    return { allowed: false, reason: \"CUSTOMER_TURN_SUPERSEDED\" };\n  }\n  const pageAt = Date.parse(state.last_page_event_at || \"\");\n\n  // ${OUTBOUND_MARK}`;
  outbound = outbound.replace(target, replacement);
  outbound = outbound.replace("v10_outbound_safety_only_v1", "v10_outbound_turn_supersession_v2");
  if (!outbound.includes(OUTBOUND_MARK) || !outbound.includes("CUSTOMER_TURN_SUPERSEDED")) throw new Error("V10_CUSTOMER_TURN_SUPERSESSION_VALIDATION_FAILED");
  fs.writeFileSync(OUTBOUND_FILE, outbound, "utf8");
}

console.log("[AIGUKA V10] general product sales handoff enabled: concise contact-first replies, Sale transfer, CJK block and stale-turn supersession");
