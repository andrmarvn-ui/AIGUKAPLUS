const ACTIONS = new Set(["reply_text", "reply_with_slides", "ask_clarification", "contact_captured", "suppress"]);
function cleanList(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))] : [];
}
export function decisionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      final_reply: { type: "string", maxLength: 900 },
      should_request_contact: { type: "boolean" },
      contact_benefit: { type: "string", maxLength: 240 },
      products: { type: "array", items: { type: "string" }, maxItems: 8 },
      intents: { type: "array", items: { type: "string" }, maxItems: 8 },
      needs_slides: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string", maxLength: 400 },
      risk_flags: { type: "array", items: { type: "string" }, maxItems: 8 },
    },
    required: ["action", "final_reply", "should_request_contact", "contact_benefit", "products", "intents", "needs_slides", "confidence", "reason", "risk_flags"],
  };
}
export function validateDecision(value, context = {}) {
  if (!value || typeof value !== "object") throw new TypeError("V9_DECISION_OBJECT_REQUIRED");
  let action = ACTIONS.has(value.action) ? value.action : "suppress";
  let reply = String(value.final_reply || "").trim();
  const products = cleanList(value.products);
  const intents = cleanList(value.intents);
  const riskFlags = cleanList(value.risk_flags);
  const hasContact = Boolean(context.contactCaptured);
  let needsSlides = value.needs_slides === true;

  if (action === "reply_with_slides" && products.length) needsSlides = true;
  if (needsSlides && !products.length) {
    needsSlides = false;
    riskFlags.push("media_product_unresolved");
    action = reply ? "reply_text" : "suppress";
  }
  if (["suppress", "contact_captured"].includes(action)) reply = "";
  if (!["suppress", "contact_captured"].includes(action) && !reply) {
    action = "suppress";
    riskFlags.push("reply_missing_suppressed");
  }
  if (hasContact && value.should_request_contact) riskFlags.push("contact_request_removed");
  if (action === "contact_captured" && !hasContact) {
    action = "suppress";
    riskFlags.push("contact_capture_not_evidenced");
  }
  if (reply && /đã gửi|gửi rồi|em gửi mẫu rồi/i.test(reply) && !needsSlides) {
    throw new TypeError("V9_MEDIA_TRUTH_VIOLATION");
  }
  return {
    ...value,
    action,
    final_reply: reply,
    products,
    intents,
    needs_slides: needsSlides,
    risk_flags: [...new Set(riskFlags)].slice(0, 8),
    should_request_contact: hasContact ? false : Boolean(value.should_request_contact),
    confidence: Math.max(0, Math.min(1, Number(value.confidence || 0))),
  };
}
export function buildDecisionInstructions() {
  return [
    "Bạn là AIGUKA V9 Decision Engine.",
    "Đọc tin hiện tại cùng contextText, hồ sơ khách, referral, Mapping và Knowledge mới nhất.",
    "Trả lời đúng câu khách vừa hỏi trước; không biến câu hỏi địa chỉ hoặc đến xem trực tiếp thành yêu cầu gửi mẫu.",
    "Khi khách nói rõ sản phẩm, ưu tiên lời khách và ngữ cảnh gần nhất; Mapping tổng hợp chỉ là phạm vi tham khảo.",
    "Khi needs_slides=true, products chỉ chứa catalog_key có thật trong knowledge.catalog.",
    "Nếu chưa xác định được catalog chính xác, không yêu cầu slide; trả lời văn bản phù hợp hoặc hỏi lại ngắn.",
    "Không xin lại liên hệ nếu đã có SĐT/Zalo. Không coi automation hoặc AIcake là Sale/Admin thật.",
    "Không bịa giá, tồn kho, thông số, ưu đãi hoặc địa chỉ. Dùng tài liệu location mới nhất trong Knowledge.",
    "Không nói đã gửi ảnh nếu chưa có delivery bundle.",
    "Cách xưng hô mặc định: em - anh/chị khi chưa có bằng chứng giới tính đáng tin cậy.",
    "Bắt buộc gọi submit_v9_decision theo schema.",
  ].join("\n");
}
export const __private__ = { cleanList };
