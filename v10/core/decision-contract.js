const ACTIONS = ["reply_text", "reply_with_slides", "ask_clarification", "acknowledge_contact", "suppress"];
const CONTACT_STATES = ["known", "missing", "missing_recently_requested", "refused_messenger_only", "unclear"];

export function decisionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "action",
      "final_reply",
      "selected_products",
      "selected_catalog_keys",
      "intents",
      "needs_slides",
      "contact_state",
      "should_request_contact",
      "contact_benefit",
      "confidence",
      "decision_reason",
      "follow_up_plan",
    ],
    properties: {
      action: { type: "string", enum: ACTIONS },
      final_reply: { type: "string", maxLength: 650 },
      selected_products: { type: "array", items: { type: "string" }, maxItems: 10 },
      selected_catalog_keys: { type: "array", items: { type: "string" }, maxItems: 10 },
      intents: { type: "array", items: { type: "string" }, maxItems: 12 },
      needs_slides: { type: "boolean" },
      contact_state: { type: "string", enum: CONTACT_STATES },
      should_request_contact: { type: "boolean" },
      contact_benefit: { type: "string", maxLength: 240 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      decision_reason: { type: "string", maxLength: 600 },
      follow_up_plan: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["topic", "status"],
          properties: {
            topic: { type: "string", maxLength: 120 },
            status: { type: "string", enum: ["answer_now", "send_media", "ask_clarification", "keep_pending", "completed"] },
          },
        },
      },
    },
  };
}

export function buildDecisionInstructions() {
  return [
    "Bạn là AI duy nhất ra quyết định kinh doanh cho hội thoại AIGUKA/GUKA. Code, rules, mapping và knowledge chỉ cung cấp dữ liệu hoặc kiểm tra tính hợp lệ; chúng không được quyết định thay bạn.",
    "Mục tiêu: hiểu đúng toàn bộ nhu cầu khách, trả lời ngắn gọn có ích, gửi đúng mẫu khi cần và xin SĐT/Zalo đúng nhịp để Sale tư vấn, báo giá và chốt đơn.",
    "Đọc toàn bộ conversation theo thời gian và đặc biệt đọc unresolved_needs. Tin mới nhất không được xóa nhu cầu cũ chưa hoàn thành.",
    "Nếu khách hỏi nhiều nhóm sản phẩm, giữ đủ từng nhóm trong selected_products, selected_catalog_keys và follow_up_plan. Không tự bỏ một nhóm chỉ vì nó được nhắc sớm hơn.",
    "Nếu unresolved_needs có status=pending_media, phải chọn đủ catalog tương ứng có ảnh và action=reply_with_slides, needs_slides=true. Chỉ coi media hoàn thành khi hội thoại có bằng chứng ảnh/carousel đã được gửi.",
    "Catalog trong knowledge_advisors là bằng chứng khả dụng. Chỉ chọn catalog_key thực sự có trong dữ liệu; catalog cha có thể đại diện toàn bộ thư mục con của nó.",
    "Trả lời trực tiếp câu khách hỏi trước. Không gửi một tin chỉ để xin SĐT/Zalo. Khi xin liên hệ, nêu lợi ích cụ thể và đặt câu xin ở cuối.",
    "Nếu đã có SĐT/Zalo thì contact_state=known, should_request_contact=false và tuyệt đối không xin lại. Nếu vừa xin số mà khách chưa có ít nhất 2 tin mới thì contact_state=missing_recently_requested và không xin lại.",
    "Nếu khách từ chối cho số hoặc muốn tiếp tục trên Messenger, contact_state=refused_messenger_only và tôn trọng lựa chọn đó.",
    "Không bịa giá, tồn kho, thông số, thương hiệu, ưu đãi, khoảng cách, vận chuyển hay cam kết. Nếu dữ liệu chưa đủ, nói rõ cần kiểm tra hoặc chuyển chuyên viên; không tự tạo con số.",
    "Không nói đã gửi mẫu nếu needs_slides=false. Không hứa sẽ gửi sau nếu lượt hiện tại có thể gửi bằng reply_with_slides.",
    "Mỗi phản hồi thường 1-3 câu, dưới 450 ký tự nếu có thể, tối đa 650 ký tự. Chỉ hỏi tối đa một câu.",
    "Xưng em và gọi anh/chị khi chưa có bằng chứng giới tính đáng tin cậy.",
    "Nếu model_input có validation_feedback, sửa đúng các lỗi được liệt kê nhưng vẫn tự quyết định nội dung; không lặp lại câu trả lời vừa bị từ chối.",
    "Chỉ trả về tool call submit_v10_decision.",
  ].join("\n");
}

function strings(values, limit = 12) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function compactReply(value, maxLength = 650) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  throw new Error("V10_DECISION_REPLY_TOO_LONG");
}

function normalizedContactState(value) {
  const state = String(value || "unclear");
  if (!CONTACT_STATES.includes(state)) throw new Error(`V10_CONTACT_STATE_INVALID:${state}`);
  return state;
}

export function validateDecision(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("V10_DECISION_INVALID");
  const action = String(input.action || "");
  if (!ACTIONS.includes(action)) throw new Error(`V10_ACTION_INVALID:${action}`);

  const decision = {
    action,
    final_reply: compactReply(input.final_reply),
    selected_products: strings(input.selected_products, 10),
    selected_catalog_keys: strings(input.selected_catalog_keys, 10),
    intents: strings(input.intents, 12),
    needs_slides: Boolean(input.needs_slides),
    contact_state: normalizedContactState(input.contact_state),
    should_request_contact: Boolean(input.should_request_contact),
    contact_benefit: String(input.contact_benefit || "").replace(/\s+/g, " ").trim().slice(0, 240),
    confidence: Math.max(0, Math.min(1, Number(input.confidence || 0))),
    decision_reason: String(input.decision_reason || "").replace(/\s+/g, " ").trim().slice(0, 600),
    follow_up_plan: Array.isArray(input.follow_up_plan)
      ? input.follow_up_plan.slice(0, 8).map((item) => ({
          topic: String(item?.topic || "").replace(/\s+/g, " ").trim().slice(0, 120),
          status: ["answer_now", "send_media", "ask_clarification", "keep_pending", "completed"].includes(String(item?.status || ""))
            ? String(item.status)
            : "keep_pending",
        })).filter((item) => item.topic)
      : [],
  };

  if (decision.action === "reply_with_slides" && !decision.needs_slides) throw new Error("V10_DECISION_SLIDE_FLAG_MISMATCH");
  if (decision.needs_slides && decision.action !== "reply_with_slides") throw new Error("V10_DECISION_SLIDE_ACTION_MISMATCH");
  if (decision.needs_slides && !decision.selected_catalog_keys.length) throw new Error("V10_DECISION_SLIDE_CATALOG_REQUIRED");
  if (decision.should_request_contact && decision.contact_state !== "missing") throw new Error("V10_DECISION_CONTACT_STATE_MISMATCH");
  if (["known", "missing_recently_requested", "refused_messenger_only"].includes(decision.contact_state) && decision.should_request_contact) {
    throw new Error("V10_DECISION_CONTACT_REQUEST_NOT_ALLOWED");
  }

  if (decision.action === "suppress") {
    if (decision.final_reply) throw new Error("V10_DECISION_SUPPRESS_REPLY_NOT_EMPTY");
  } else if (!decision.final_reply) {
    throw new Error("V10_FINAL_REPLY_REQUIRED");
  }

  return decision;
}

export function neutralUnavailableDecision({ contactKnown = false } = {}) {
  return {
    action: "reply_text",
    final_reply: "Dạ em đã nhận nội dung anh/chị vừa gửi. Hệ thống tư vấn đang quá tải; anh/chị không cần gửi lại, bên em sẽ tiếp tục xử lý tại Messenger ạ.",
    selected_products: [],
    selected_catalog_keys: [],
    intents: ["service_unavailable"],
    needs_slides: false,
    contact_state: contactKnown ? "known" : "unclear",
    should_request_contact: false,
    contact_benefit: "",
    confidence: 0.7,
    decision_reason: contactKnown
      ? "Operational acknowledgement after repeated AI processing failures; contact already known."
      : "Operational acknowledgement after repeated AI processing failures.",
    follow_up_plan: [{ topic: "customer_request", status: "keep_pending" }],
  };
}
