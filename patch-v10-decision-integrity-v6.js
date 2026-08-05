import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V6";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V6_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");
if (!source.includes(MARK)) {
  if (!source.includes("AIGUKA_V10_DECISION_INTEGRITY_V5")) throw new Error("V10_DECISION_INTEGRITY_V6_BASE_MISSING");

  const salutationStart = source.indexOf("function salutationStyle(modelInput) {");
  const salutationEnd = source.indexOf("function cleanProviderMarkup", salutationStart);
  if (salutationStart < 0 || salutationEnd < 0) throw new Error("V10_DECISION_INTEGRITY_V6_SALUTATION_TARGET_MISSING");
  const salutation = String.raw`function salutationStyle(modelInput) {
  const recent = customerMessagesFrom(modelInput).slice(-12).map(function (message) { return String(message.text || ""); }).join(" \n");
  const normalized = qualityNormalize(recent);
  const customer = modelInput && modelInput.customer ? modelInput.customer : {};
  const preferred = qualityNormalize(customer.preferred_salutation || "");

  function selfRef(term) {
    const firstPersonVerbs = "(?:dang|dag|muon|can|hoi|xem|mua|lay|dat|o|ranh|danh|co nhu cau|quan tam|xin|nhan)";
    const startsSentence = new RegExp("(?:^|[.!?\\n]\\s*)" + term + "\\s+" + firstPersonVerbs + "\\b", "i");
    const addressedAction = new RegExp("\\b(?:goi|gui|nhan|bao|tu van).{0,24}\\bcho\\s+" + term + "\\b", "i");
    return startsSentence.test(normalized) || addressedAction.test(normalized);
  }

  if (selfRef("co") || preferred === "co") return { customer: "cô", self: "cháu" };
  if (selfRef("chu") || preferred === "chu") return { customer: "chú", self: "cháu" };
  if (selfRef("bac") || preferred === "bac") return { customer: "bác", self: "cháu" };
  if (selfRef("chi") || preferred === "chi") return { customer: "chị", self: "em" };
  if (selfRef("anh") || preferred === "anh") return { customer: "anh", self: "em" };
  return { customer: "anh/chị", self: "em" };
}

// ${MARK}

`;
  source = source.slice(0, salutationStart) + salutation + source.slice(salutationEnd);

  const applyStart = source.indexOf("function applySalutation(value, style) {");
  const applyEnd = source.indexOf("function contactIsKnown", applyStart);
  if (applyStart < 0 || applyEnd < 0) throw new Error("V10_DECISION_INTEGRITY_V6_APPLY_TARGET_MISSING");
  let applyBlock = source.slice(applyStart, applyEnd);
  const returnIndex = applyBlock.lastIndexOf("  return text;");
  if (returnIndex < 0) throw new Error("V10_DECISION_INTEGRITY_V6_APPLY_RETURN_MISSING");
  const defaultNormalize = String.raw`  if (style.customer === "anh/chị") {
    const placeholder = "__AIGUKA_CUSTOMER__";
    text = text
      .replace(/anh\s*\/\s*chị/gi, placeholder)
      .replace(/\banh\b/gi, "anh/chị")
      .replace(/\bchị\b/gi, "anh/chị")
      .replace(new RegExp(placeholder, "g"), "anh/chị");
  }
`;
  applyBlock = applyBlock.slice(0, returnIndex) + defaultNormalize + applyBlock.slice(returnIndex);
  source = source.slice(0, applyStart) + applyBlock + source.slice(applyEnd);

  const helperTarget = "function enforceDecisionIntegrity(input, modelInput) {";
  if (!source.includes(helperTarget)) throw new Error("V10_DECISION_INTEGRITY_V6_ENFORCE_TARGET_MISSING");
  const priceHelpers = String.raw`function verifiedKnowledgeText(modelInput) {
  const advisors = modelInput && modelInput.knowledge_advisors ? modelInput.knowledge_advisors : {};
  return qualityNormalize(JSON.stringify(advisors));
}

function unsupportedPriceReply(reply, modelInput) {
  const priceMatches = String(reply || "").match(/\b\d[\d\s.,-]*(?:k|tr|triệu|trieu|đồng|dong|vnd|₫)\b/gi) || [];
  if (!priceMatches.length) return false;
  const knowledge = verifiedKnowledgeText(modelInput).replace(/\s+/g, "");
  return priceMatches.some(function (match) {
    const normalized = qualityNormalize(match).replace(/\s+/g, "");
    return normalized && !knowledge.includes(normalized);
  });
}

function explicitSlideRequest(modelInput) {
  const active = activeProductText(modelInput);
  return /\b(xem|gui|cho xem|tham khao).{0,24}\bmau\b|\bmau khac\b|\bxem them\b/.test(active);
}

`;
  source = source.replace(helperTarget, priceHelpers + helperTarget);

  const scopeTarget = `  const scope = scopedSlideKeys(modelInput, slide);\n  if (scope.length && (decision.needs_slides || decision.action === "reply_with_slides")) {`;
  const scopeReplacement = `  const scope = scopedSlideKeys(modelInput, slide);\n  const slideRequested = explicitSlideRequest(modelInput);\n  if (scope.length && (slideRequested || decision.needs_slides || decision.action === "reply_with_slides")) {\n    if (slideRequested) {\n      decision.needs_slides = true;\n      decision.action = "reply_with_slides";\n    }`;
  if (!source.includes(scopeTarget)) throw new Error("V10_DECISION_INTEGRITY_V6_SCOPE_TARGET_MISSING");
  source = source.replace(scopeTarget, scopeReplacement);

  const knownTarget = `  const known = contactIsKnown(modelInput);\n  if (known) {`;
  const priceGuard = `  const known = contactIsKnown(modelInput);\n  const latestIntentText = latestExplicitText(modelInput);\n  if (/\\b(gia|bao gia|bao nhieu|cost)\\b/.test(latestIntentText) && unsupportedPriceReply(decision.final_reply, modelInput)) {\n    decision.final_reply = known\n      ? "Dạ giá mẫu này còn tùy màu và phiên bản. Bên em đã nhận số của anh/chị và sẽ kiểm tra đúng mẫu để báo giá chính xác ạ."\n      : "Dạ giá mẫu này còn tùy màu và phiên bản. Anh/chị cho em xin SĐT hoặc Zalo, bên em kiểm tra đúng mẫu và báo giá chính xác ạ.";\n  }\n  if (known) {`;
  if (!source.includes(knownTarget)) throw new Error("V10_DECISION_INTEGRITY_V6_PRICE_TARGET_MISSING");
  source = source.replace(knownTarget, priceGuard);

  source = source.replace("v10_ai_quality_guard_v8", "v10_ai_quality_guard_v9");
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v6 enabled: verified prices, contextual salutation and explicit slide intent");
}
