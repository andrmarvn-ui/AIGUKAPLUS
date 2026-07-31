const ACTIONS = new Set(["reply_text", "reply_with_slides", "ask_clarification", "contact_captured", "suppress"]);

function cleanList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
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
  if (!ACTIONS.has(value.action)) throw new TypeError("V9_DECISION_ACTION_INVALID");
  const reply = String(value.final_reply || "").trim();
  const products = cleanList(value.products);
  const intents = cleanList(value.intents);
  const riskFlags = cleanList(value.risk_flags);
  const hasContact = Boolean(context.contactCaptured);
  const suppressed = ["suppress", "contact_captured"].includes(value.action);
  if (!suppressed && !reply) throw new TypeError("V9_DECISION_REPLY_REQUIRED");
  if (hasContact && value.should_request_contact) throw new TypeError("V9_CONTACT_LOCK_VIOLATION");
  if (value.action === "contact_captured" && !hasContact) throw new TypeError("V9_CONTACT_CAPTURE_NOT_EVIDENCED");
  if (value.action === "reply_with_slides" && value.needs_slides !== true) {
    throw new TypeError("V9_SLIDE_ACTION_MEDIA_FLAG_REQUIRED");
  }
  if (value.needs_slides === true && !products.length) {
    throw new TypeError("V9_MEDIA_PRODUCT_REQUIRED");
  }
  if (reply && /đã gửi|gửi rồi|em gửi mẫu rồi/i.test(reply) && value.needs_slides !== true) {
    throw new TypeError("V9_MEDIA_TRUTH_VIOLATION");
  }
  return {
    ...value,
    final_reply: reply,
    products,
    intents,
    risk_flags: riskFlags,
    should_request_contact: hasContact ? false : Boolean(value.should_request_contact),
    confidence: Math.max(0, Math.min(1, Number(value.confidence || 0))),
  };
}

export function buildDecisionInstructions() {
  return [
    "Bạn là AIGUKA V9 Decision Engine ở chế độ SHADOW.",
    "Đọc toàn bộ customer turn, hồ sơ khách, lịch sử gần nhất, referral quảng cáo, Mapping và bằng chứng actor.",
    "Mục tiêu đầu tiên là trả lời đúng điều khách vừa hỏi; mục tiêu kinh doanh là xin SĐT/Zalo bằng một lợi ích cụ thể.",
    "Mapping và Knowledge là dữ liệu tham khảo để hiểu quảng cáo, ngữ cảnh và các catalog sẵn có; quyền quyết định cuối cùng thuộc về bạn.",
    "Nếu khách nói rõ sản phẩm thì ưu tiên nội dung hiện tại; nếu khách nói mơ hồ thì dùng referral/Mapping để xác định sản phẩm.",
    "Khi needs_slides=true, products bắt buộc chỉ chứa catalog_key chính xác có trong knowledge.catalog; không dùng tên tự nhiên và không tự tạo key mới.",
    "Chỉ đưa vào products những catalog thực sự cần gửi cho yêu cầu hiện tại; không đưa các catalog chỉ xuất hiện trong Knowledge tham khảo.",
    "Không xin lại liên hệ nếu đã có SĐT/Zalo. Không coi AIcake, automation, bot hoặc page_unknown là Sale/Admin.",
    "Nếu verified human đã tiếp quản hoặc AIcake đã trả lời trong chế độ cùng tồn tại thì action=suppress.",
    "Ưu tiên lời khách hiện tại hơn quảng cáo và mapping cũ. Giữ đầy đủ ý khi khách hỏi nhiều sản phẩm hoặc nhiều yêu cầu.",
    "Không bịa giá, tồn kho, thông số, ưu đãi hoặc cam kết. Không nói đã gửi ảnh nếu chưa có delivery bundle.",
    "Cách xưng hô mặc định: em - anh/chị khi chưa có bằng chứng giới tính đáng tin cậy.",
    "Bắt buộc gọi submit_v9_decision theo schema.",
  ].join("\n");
}

export const __private__ = { cleanList };
