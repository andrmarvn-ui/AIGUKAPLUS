import fs from "node:fs";

const file = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_SPECIFIC_PRICE_CONTACT_V1";

if (!fs.existsSync(file)) throw new Error("V10_SPECIFIC_PRICE_CONTACT_WORKER_MISSING");

let source = fs.readFileSync(file, "utf8");

if (!source.includes(MARK)) {
  const helperAnchor = "function safePriceReply(decision, modelInput) {";
  if (!source.includes(helperAnchor)) throw new Error("V10_SPECIFIC_PRICE_CONTACT_HELPER_ANCHOR_MISSING");

  const helpers = String.raw`function specificPriceSubject(modelInput) {
  const raw = customerMessagesFrom(modelInput)
    .slice(-6)
    .map(function (message) { return String(message && message.text || ""); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = qualityNormalize(raw);

  let category = "mẫu sản phẩm";
  if (/\b(bon cau|bet ve sinh|bet)\b/.test(normalized)) category = "bồn cầu";
  else if (/\b(quat tran|quat)\b/.test(normalized)) category = "quạt trần";
  else if (/\b(bep tu|bep dien|may hut mui|hut mui)\b/.test(normalized)) category = "sản phẩm phòng bếp";
  else if (/\b(sen tam|sen cay)\b/.test(normalized)) category = "sen tắm";
  else if (/\b(lavabo|chau rua mat)\b/.test(normalized)) category = "lavabo";
  else if (/\b(chau rua bat|voi rua bat)\b/.test(normalized)) category = "chậu/vòi rửa bát";

  const brandModelMatches = raw.match(/[A-Za-zÀ-ỹĐđ]{3,24}\s+[A-Za-z]{1,8}[-_.\/]?\d{2,6}[A-Za-z0-9._\/-]*/g) || [];
  const codeMatches = raw.match(/\b[A-Za-z]{1,8}[-_.\/]?\d{2,6}[A-Za-z0-9._\/-]*\b/g) || [];
  let reference = brandModelMatches.length ? brandModelMatches[brandModelMatches.length - 1] : (codeMatches[codeMatches.length - 1] || "");
  const firstWord = qualityNormalize(reference).split(" ")[0] || "";
  if (["cau", "quat", "bep", "sen", "voi", "chau", "mau", "pham"].includes(firstWord) && codeMatches.length) {
    reference = codeMatches[codeMatches.length - 1];
  }
  reference = String(reference || "").replace(/[.,!?;:]+$/g, "").trim();

  if (reference) return category + " " + reference;
  if (category !== "mẫu sản phẩm") return category + " anh/chị đang quan tâm";
  return "mẫu sản phẩm anh/chị đang quan tâm";
}

// ${MARK}

`;

  source = source.replace(helperAnchor, helpers + helperAnchor);

  const safePricePattern = /function safePriceReply\(decision, modelInput\) \{[\s\S]*?\n\}\n\n\/\/ AIGUKA_V10_DECISION_INTEGRITY_V8/;
  if (!safePricePattern.test(source)) throw new Error("V10_SPECIFIC_PRICE_CONTACT_SAFE_REPLY_BLOCK_MISSING");

  source = source.replace(safePricePattern, String.raw`function safePriceReply(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = specificPriceSubject(modelInput);
  const text = known
    ? "Dạ, để em kiểm tra giá chính xác của " + subject + " và ưu đãi hiện tại. Bên em đã nhận số của anh/chị và sẽ gửi mẫu, báo giá ngay ạ."
    : "Dạ, để em kiểm tra giá chính xác của " + subject + " và ưu đãi hiện tại. Anh/chị cho em xin SĐT hoặc Zalo, em gửi mẫu và báo giá ngay ạ.";
  return applySalutation(text, style);
}

// AIGUKA_V10_DECISION_INTEGRITY_V8`);

  const finalTarget = `  if (priceIntentDetected(decision, modelInput) && !replyContainsVerifiedPrice(decision.final_reply, modelInput)) {\n    decision.final_reply = safePriceReply(decision, modelInput);\n  } else if (unsupportedStockClaim(decision.final_reply, modelInput) || unsupportedTechnicalFacts(decision.final_reply, modelInput) || languageLooksCorrupted(decision.final_reply) || (knownAtFinal && contactRequestDetected(decision.final_reply))) {`;
  if (!source.includes(finalTarget)) throw new Error("V10_SPECIFIC_PRICE_CONTACT_FINAL_GUARD_MISSING");

  const finalReplacement = `  if (priceIntentDetected(decision, modelInput) && !replyContainsVerifiedPrice(decision.final_reply, modelInput)) {\n    decision.final_reply = safePriceReply(decision, modelInput);\n    decision.contact_state = knownAtFinal ? "known" : "missing";\n    decision.should_request_contact = !knownAtFinal;\n    decision.contact_benefit = knownAtFinal\n      ? "gửi mẫu, báo giá chính xác và ưu đãi hiện tại theo thông tin liên hệ đã có"\n      : "gửi mẫu, báo giá chính xác và ưu đãi hiện tại";\n  } else if (unsupportedStockClaim(decision.final_reply, modelInput) || unsupportedTechnicalFacts(decision.final_reply, modelInput) || languageLooksCorrupted(decision.final_reply) || (knownAtFinal && contactRequestDetected(decision.final_reply))) {`;
  source = source.replace(finalTarget, finalReplacement);

  source = source.replace("v10_ai_quality_guard_v14", "v10_ai_quality_guard_v15");

  if (!source.includes(MARK) || !source.includes("gửi mẫu, báo giá chính xác và ưu đãi hiện tại")) {
    throw new Error("V10_SPECIFIC_PRICE_CONTACT_PATCH_VALIDATION_FAILED");
  }

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] specific product price contact enabled: ask contact with samples, exact quote and current promotion");
}
