import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V7";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V7_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");
if (!source.includes(MARK)) {
  if (!source.includes("AIGUKA_V10_DECISION_INTEGRITY_V6")) throw new Error("V10_DECISION_INTEGRITY_V7_BASE_MISSING");

  const enforceTarget = "function enforceDecisionIntegrity(input, modelInput) {";
  if (!source.includes(enforceTarget)) throw new Error("V10_DECISION_INTEGRITY_V7_ENFORCE_TARGET_MISSING");
  const helpers = String.raw`function languageLooksCorrupted(value) {
  const text = String(value || "");
  const normalized = qualityNormalize(text);
  if (/[�åäöüæøß]/i.test(text)) return true;
  if (/\b(cosi|ldo|showoom|ben em|pho keo|gia lam noii|zddw)\b/i.test(normalized)) return true;
  if (/\b(?:ld|dd|lđ)[a-z]{1,8}\b/i.test(normalized)) return true;
  const words = text.match(/[A-Za-zÀ-ỹĐđ]+/g) || [];
  const endingIWhitelist = new Set(["gi", "thi", "vi", "mi", "li", "ki", "khi"]);
  for (const word of words) {
    const clean = qualityNormalize(word);
    if (/[ìòèù]$/i.test(word) && clean.length > 3 && !endingIWhitelist.has(clean)) return true;
  }
  return false;
}

function unsupportedStockClaim(value, modelInput) {
  const text = qualityNormalize(value);
  if (!/\b(co san|con hang|trong kho|san kho|con kho|co mau.{0,20}trong kho)\b/.test(text)) return false;
  const knowledge = verifiedKnowledgeText(modelInput);
  return !/\b(co san|con hang|trong kho|san kho)\b/.test(knowledge);
}

function groundedProductReply(decision, modelInput) {
  const latest = latestExplicitText(modelInput);
  const style = salutationStyle(modelInput);
  const known = contactIsKnown(modelInput);
  const keys = Array.isArray(decision.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  const joined = keys.join(" ");
  let subject = "mẫu sản phẩm anh/chị đang quan tâm";

  if (/quat_10_canh|quat_tran/.test(joined) || /\bquat.{0,16}10 canh\b/.test(latest)) {
    const color = /\bmau vang\b/.test(latest) ? " màu vàng" : /\bmau den\b/.test(latest) ? " màu đen" : /\bmau nau\b/.test(latest) ? " màu nâu" : /\bvan go\b/.test(latest) ? " màu vân gỗ" : "";
    const size = /\b1\s*[,.]?\s*67\b|\b1m67\b/.test(latest) ? ", sải cánh 1,67 m" : "";
    subject = "mẫu quạt trần 10 cánh" + color + size;
  } else if (keys.includes("bep_tu_hut_mui") && keys.includes("chau_voi_rua_bat")) {
    subject = "các mẫu phòng bếp gồm bếp từ–hút mùi và chậu–vòi";
  } else if (keys.includes("bep_tu_hut_mui")) {
    subject = "các mẫu bếp từ và máy hút mùi";
  } else if (keys.includes("chau_voi_rua_bat")) {
    subject = "các mẫu chậu và vòi rửa bát";
  } else if (/bon_cau/.test(joined)) {
    subject = "các mẫu bồn cầu phù hợp";
  } else if (/combo_phong_tam/.test(joined)) {
    subject = "các mẫu combo phòng tắm";
  }

  let text = "Dạ, " + (decision.needs_slides ? "em gửi anh/chị " : "em đã ghi nhận ") + subject + (decision.needs_slides ? " để tham khảo ạ." : " ạ.");
  if (!known && decision.should_request_contact) {
    text += " Anh/chị cho em xin SĐT hoặc Zalo, bên em kiểm tra đúng mẫu và báo giá chính xác nhé.";
  } else if (known && /\b(mua|lay|dat|1c|1 chiec)\b/.test(latest)) {
    text += " Bên em đã nhận số và chuyển Sale liên hệ tư vấn cho mình ạ.";
  }
  return applySalutation(text, style);
}

// ${MARK}

`;
  source = source.replace(enforceTarget, helpers + enforceTarget);

  const replyCheckTarget = `  const reply = String(decision.final_reply || "").trim();\n  if (DECISION_GIBBERISH_PATTERN.test(reply)) throw new Error("V10_DECISION_GIBBERISH_REJECTED");`;
  const replyCheckReplacement = `  const reply = String(decision.final_reply || "").trim();\n  if (DECISION_GIBBERISH_PATTERN.test(reply) || languageLooksCorrupted(reply)) throw new Error("V10_DECISION_GIBBERISH_REJECTED");`;
  if (!source.includes(replyCheckTarget)) throw new Error("V10_DECISION_INTEGRITY_V7_REPLY_CHECK_MISSING");
  source = source.replace(replyCheckTarget, replyCheckReplacement);

  const finalTarget = `  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");\n  return decision;`;
  const finalReplacement = `  if (unsupportedStockClaim(decision.final_reply, modelInput) || languageLooksCorrupted(decision.final_reply)) {\n    decision.final_reply = groundedProductReply(decision, modelInput);\n  }\n  if (contactIsKnown(modelInput)) {\n    decision.contact_state = "known";\n    decision.should_request_contact = false;\n  }\n  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");\n  return decision;`;
  if (!source.includes(finalTarget)) throw new Error("V10_DECISION_INTEGRITY_V7_FINAL_TARGET_MISSING");
  source = source.replace(finalTarget, finalReplacement);

  const validateTarget = "    const decision = validateDecision(result.decision);";
  if (!source.includes(validateTarget)) throw new Error("V10_DECISION_INTEGRITY_V7_POST_VALIDATE_TARGET_MISSING");
  source = source.replace(validateTarget, "    const decision = enforceDecisionIntegrity(validateDecision(result.decision), modelInput);");

  source = source.replace("v10_ai_quality_guard_v9", "v10_ai_quality_guard_v10");
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v7 enabled: grounded replies, stock guard and post-validation enforcement");
}
