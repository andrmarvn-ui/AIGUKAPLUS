import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V8";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V8_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");
if (!source.includes(MARK)) {
  if (!source.includes("AIGUKA_V10_DECISION_INTEGRITY_V7")) throw new Error("V10_DECISION_INTEGRITY_V8_BASE_MISSING");

  source = source.replace('/[�åäöüæøß]/i.test(text)', '/[�åäöüæøßłŁćĆśŚźŹżŻńŃ]/i.test(text)');

  const earlyTarget = '  if (DECISION_GIBBERISH_PATTERN.test(reply) || languageLooksCorrupted(reply)) throw new Error("V10_DECISION_GIBBERISH_REJECTED");';
  if (!source.includes(earlyTarget)) throw new Error("V10_DECISION_INTEGRITY_V8_EARLY_TARGET_MISSING");
  source = source.replace(earlyTarget, '  if (DECISION_GIBBERISH_PATTERN.test(reply)) throw new Error("V10_DECISION_GIBBERISH_REJECTED");');

  const helperTarget = "function unsupportedStockClaim(value, modelInput) {";
  if (!source.includes(helperTarget)) throw new Error("V10_DECISION_INTEGRITY_V8_HELPER_TARGET_MISSING");
  const helpers = String.raw`function priceIntentDetected(decision, modelInput) {
  const latest = latestExplicitText(modelInput);
  const active = activeProductText(modelInput);
  const intents = qualityNormalize((Array.isArray(decision && decision.intents) ? decision.intents : []).join(" "));
  return /\b(price|gia|bao gia|bao nhieu|tien the nao|gia tien|cost)\b/.test(intents + " " + latest + " " + active);
}

function replyContainsVerifiedPrice(reply, modelInput) {
  const priceMatches = String(reply || "").match(/\b\d[\d\s.,-]*(?:k|tr|triệu|trieu|đồng|dong|vnd|₫)\b/gi) || [];
  if (!priceMatches.length) return false;
  const knowledge = verifiedKnowledgeText(modelInput).replace(/\s+/g, "");
  return priceMatches.every(function (match) {
    const normalized = qualityNormalize(match).replace(/\s+/g, "");
    return normalized && knowledge.includes(normalized);
  });
}

function contactRequestDetected(value) {
  const text = qualityNormalize(value);
  return /\b(xin|cho|gui|de lai|nhan|qua).{0,32}\b(sdt|so dien thoai|zalo)\b|\b(sdt|so dien thoai|zalo).{0,24}\b(nhe|a|de|qua)\b/.test(text);
}

function unsupportedTechnicalFacts(value, modelInput) {
  const replyFacts = String(value || "").match(/\b\d+(?:[,.]\d+)?\s*(?:m\d+|m|cm|mm|w|kw|kg|l)\b/gi) || [];
  if (!replyFacts.length) return false;
  const customer = qualityNormalize(customerMessagesFrom(modelInput).map(function (message) { return message.text || ""; }).join(" ")).replace(/\s+/g, "");
  const knowledge = verifiedKnowledgeText(modelInput).replace(/\s+/g, "");
  return replyFacts.some(function (fact) {
    const normalized = qualityNormalize(fact).replace(/\s+/g, "");
    return normalized && !customer.includes(normalized) && !knowledge.includes(normalized);
  });
}

function safePriceReply(decision, modelInput) {
  const active = activeProductText(modelInput);
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  let subject = "mẫu này";
  if (/\bquat.{0,20}10 canh\b/.test(active)) {
    const color = /\bmau vang\b/.test(active) ? " màu vàng" : /\bmau den\b/.test(active) ? " màu đen" : /\bmau nau\b/.test(active) ? " màu nâu" : /\bvan go\b/.test(active) ? " màu vân gỗ" : "";
    const size = /\b1\s*[,.]?\s*67\b|\b1m67\b/.test(active) ? ", sải cánh 1,67 m" : "";
    subject = "mẫu quạt trần 10 cánh" + color + size;
  } else if (/\b(phong bep|nha bep|bep tu|hut mui|chau|voi rua)\b/.test(active)) {
    subject = "nhóm sản phẩm phòng bếp mình đang quan tâm";
  } else if (/\b(phong tam|bon cau|sen tam|lavabo)\b/.test(active)) {
    subject = "nhóm sản phẩm phòng tắm mình đang quan tâm";
  }
  const text = known
    ? "Dạ, giá " + subject + " cần kiểm tra theo đúng phiên bản. Bên em đã nhận số của anh/chị và sẽ báo giá chính xác cho mình ạ."
    : "Dạ, giá " + subject + " cần kiểm tra theo đúng phiên bản. Anh/chị cho em xin SĐT hoặc Zalo, bên em báo giá chính xác ạ.";
  return applySalutation(text, style);
}

// ${MARK}

`;
  source = source.replace(helperTarget, helpers + helperTarget);

  source = source.replace('  if (/quat_10_canh|quat_tran/.test(joined) || /\\bquat.{0,16}10 canh\\b/.test(latest)) {', '  const active = activeProductText(modelInput);\n  if (/quat_10_canh|quat_tran/.test(joined) || /\\bquat.{0,20}10 canh\\b/.test(latest + " " + active)) {');

  const finalTarget = `  if (unsupportedStockClaim(decision.final_reply, modelInput) || languageLooksCorrupted(decision.final_reply)) {\n    decision.final_reply = groundedProductReply(decision, modelInput);\n  }\n  if (contactIsKnown(modelInput)) {`;
  const finalReplacement = `  const knownAtFinal = contactIsKnown(modelInput);\n  if (priceIntentDetected(decision, modelInput) && !replyContainsVerifiedPrice(decision.final_reply, modelInput)) {\n    decision.final_reply = safePriceReply(decision, modelInput);\n  } else if (unsupportedStockClaim(decision.final_reply, modelInput) || unsupportedTechnicalFacts(decision.final_reply, modelInput) || languageLooksCorrupted(decision.final_reply) || (knownAtFinal && contactRequestDetected(decision.final_reply))) {\n    decision.final_reply = groundedProductReply(decision, modelInput);\n  }\n  if (knownAtFinal) {`;
  if (!source.includes(finalTarget)) throw new Error("V10_DECISION_INTEGRITY_V8_FINAL_TARGET_MISSING");
  source = source.replace(finalTarget, finalReplacement);

  source = source.replace("v10_ai_quality_guard_v10", "v10_ai_quality_guard_v11");
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v8 enabled: safe price replies, verified technical facts and known-contact cleanup");
}
