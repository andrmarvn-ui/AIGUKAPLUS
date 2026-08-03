const ACTIONS = ["reply_text", "reply_with_slides", "ask_clarification", "acknowledge_contact", "suppress"];
const CONTACT_STATES = ["known", "missing", "missing_recently_requested", "refused_messenger_only", "unclear"];
const SALES_INTENTS = new Set([
  "product",
  "purchase",
  "samples",
  "price",
  "quote",
  "promotion",
  "specification",
  "availability",
  "delivery",
  "address",
  "location",
  "showroom",
]);
const CONTACT_REQUEST_PATTERN = /(sđt|số điện thoại|điện thoại|zalo|số liên hệ|liên hệ của anh|liên hệ của chị)/i;
const DIRECT_CONTACT_REQUEST_PATTERN = /((cho|gửi)\s+(em|bên em)\s+xin|để lại|cho bên em).{0,60}(sđt|số điện thoại|điện thoại|zalo|số liên hệ)|(sđt|số điện thoại|zalo).{0,35}(của anh|của chị|của anh\/chị)/i;

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
        maxItems: 6,
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
    "Bạn là AI ra quyết định kinh doanh duy nhất cho hội thoại khách hàng của AIGUKA/GUKA.",
    "HIẾN PHÁP MỤC TIÊU: nhiệm vụ số 1 là tạo lead có SĐT hoặc Zalo để Sale tư vấn và chốt đơn; bạn không phải chatbot tư vấn sâu kéo dài trên Messenger.",
    "HIẾN PHÁP HỘI THOẠI: phải hiểu đúng câu khách vừa hỏi và trả lời trực tiếp trước. Tuyệt đối không bỏ câu hỏi của khách để chỉ xin SĐT/Zalo.",
    "Thứ tự xử lý: (1) trả lời đúng ý bằng thông tin ngắn nhưng có ích; (2) gửi vài mẫu bán chạy nếu khách xin xem và có catalog phù hợp; (3) khi đúng nhịp mới xin SĐT/Zalo để tư vấn cho tiện, gửi mẫu và báo giá chính xác; (4) dừng, không diễn giải lan man.",
    "KHÔNG XIN SỐ DỒN DẬP: đọc toàn bộ messages để nhận biết lần gần nhất bot/page/human đã xin SĐT/Zalo. Nếu sau lần xin gần nhất khách mới gửi dưới 2 tin nhắn, contact_state=missing_recently_requested, should_request_contact=false và lượt này chỉ trả lời câu hỏi hoặc gửi mẫu.",
    "Chỉ được nhắc lại xin liên hệ sau ít nhất 2 tin nhắn mới của khách kể từ lần xin gần nhất. Khi nhắc lại, phải cung cấp giá trị mới trước và câu xin SĐT/Zalo luôn là câu cuối.",
    "contact_state=missing khi chưa có liên hệ, khách chưa từ chối và nhịp xin số hiện tại được phép. Với nhu cầu bán hàng rõ, should_request_contact=true sau khi đã trả lời câu hỏi.",
    "Khi khách hỏi sản phẩm, mẫu, ảnh, giá, báo giá, ưu đãi, thông số, tồn hàng, vận chuyển, địa chỉ hoặc showroom mà được phép xin liên hệ: câu xin phải gắn lợi ích cụ thể như tư vấn cho tiện, gửi đúng mẫu, báo giá chính xác, thông số, ưu đãi hoặc định vị.",
    "Không bao giờ gửi một tin chỉ có nội dung xin SĐT/Zalo. Phần trước câu xin liên hệ phải trả lời được ít nhất một ý thực tế của khách hoặc xác nhận đang gửi mẫu đúng nhóm họ hỏi.",
    "Mỗi phản hồi tối đa 2-3 câu ngắn, mục tiêu dưới 450 ký tự và tuyệt đối không quá 650 ký tự. Không viết bài tư vấn dài, không liệt kê kiến thức chung, không kể lại toàn bộ nhu cầu.",
    "Mỗi phản hồi chỉ đặt tối đa một câu hỏi. Nếu được phép xin liên hệ thì câu hỏi xin SĐT/Zalo được ưu tiên và đặt cuối; không hỏi thêm câu khảo sát khác trong cùng lượt.",
    "Nếu khách hỏi nhiều nhóm sản phẩm, giữ đủ các nhóm trong selected_products/follow_up_plan nhưng không tư vấn dài từng nhóm; gửi mẫu cân bằng rồi xin liên hệ khi đúng nhịp.",
    "Chỉ ask_clarification khi thực sự không xác định được khách đang hỏi sản phẩm nào. Câu hỏi làm rõ phải ngắn và không biến thành cuộc phỏng vấn nhiều bước.",
    "Đọc toàn bộ hội thoại theo thời gian; tin mới nhất không được xóa các nhu cầu chưa hoàn thành trước đó.",
    "Mappings, catalog hints, rules, locks và knowledge chỉ là cố vấn không ràng buộc. Phải suy luận từ lời khách thực tế và tự quyết định.",
    "Không thay sản phẩm khách yêu cầu bằng sản phẩm suy ra từ quảng cáo hoặc mapping.",
    "Không bịa giá, thông số, thương hiệu, tồn kho, ưu đãi, thời gian giao hoặc cam kết. Không nói đã gửi mẫu nếu needs_slides=false.",
    "contact_state=known khi hệ thống hoặc hội thoại đã có SĐT/Zalo; tuyệt đối không xin lại. contact_state=refused_messenger_only khi khách từ chối cho số hoặc yêu cầu tiếp tục trên Messenger; tôn trọng và trả lời ngắn tại Messenger.",
    "Xưng em và gọi anh/chị khi chưa có bằng chứng giới tính đáng tin cậy.",
    "Chỉ trả về tool call submit_v10_decision.",
  ].join("\n");
}

function strings(values, limit = 12) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function compactReply(value, maxLength = 650) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  const shortened = normalized.slice(0, maxLength - 1).trimEnd();
  const sentenceBoundary = Math.max(shortened.lastIndexOf(". "), shortened.lastIndexOf("! "), shortened.lastIndexOf("? "));
  if (sentenceBoundary >= Math.floor(maxLength * 0.55)) return shortened.slice(0, sentenceBoundary + 1).trim();
  const wordBoundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, wordBoundary > 0 ? wordBoundary : shortened.length).trim()}…`;
}

function normalizedContactState(value) {
  const state = String(value || "unclear");
  return CONTACT_STATES.includes(state) ? state : "unclear";
}

function hasSalesIntent(decision) {
  if (decision.selected_products.length || decision.selected_catalog_keys.length) return true;
  return decision.intents.some((intent) => SALES_INTENTS.has(String(intent || "").toLowerCase()));
}

function contactRequestSentence(benefit) {
  const cleanBenefit = String(benefit || "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (cleanBenefit) return `Anh/chị cho em xin SĐT hoặc Zalo, bên em ${cleanBenefit.charAt(0).toLowerCase()}${cleanBenefit.slice(1)} nhé.`;
  return "Anh/chị cho em xin SĐT hoặc Zalo để bên em tư vấn cho tiện, gửi đúng mẫu và báo giá chính xác nhé.";
}

function replySentences(value) {
  return String(value || "")
    .match(/[^.!?]+[.!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
}

function isDirectContactRequest(sentence) {
  return DIRECT_CONTACT_REQUEST_PATTERN.test(String(sentence || ""));
}

function withoutContactRequest(value) {
  return compactReply(replySentences(value).filter((sentence) => !isDirectContactRequest(sentence)).join(" "));
}

function contactRequestLast(value) {
  const sentences = replySentences(value);
  const valueSentences = sentences.filter((sentence) => !isDirectContactRequest(sentence));
  const requestSentences = sentences.filter((sentence) => isDirectContactRequest(sentence));
  return compactReply([...valueSentences, ...requestSentences.slice(-1)].join(" "));
}

export function validateDecision(input = {}) {
  if (!input || typeof input !== "object") throw new Error("V10_DECISION_INVALID");
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
    decision_reason: String(input.decision_reason || "").slice(0, 600),
    follow_up_plan: Array.isArray(input.follow_up_plan)
      ? input.follow_up_plan.slice(0, 6).map((item) => ({
          topic: String(item?.topic || "").slice(0, 120),
          status: ["answer_now", "send_media", "ask_clarification", "keep_pending", "completed"].includes(String(item?.status || ""))
            ? String(item.status)
            : "keep_pending",
        })).filter((item) => item.topic)
      : [],
  };

  if (decision.needs_slides && decision.action !== "reply_with_slides") decision.action = "reply_with_slides";
  if (!decision.needs_slides && decision.action === "reply_with_slides") decision.needs_slides = true;

  const contactBlocked = ["known", "missing_recently_requested", "refused_messenger_only"].includes(decision.contact_state)
    || ["acknowledge_contact", "suppress"].includes(decision.action);

  if (contactBlocked) {
    decision.should_request_contact = false;
    decision.final_reply = withoutContactRequest(decision.final_reply);
  } else if (decision.contact_state === "missing" && hasSalesIntent(decision) && ["reply_text", "reply_with_slides"].includes(decision.action)) {
    decision.should_request_contact = true;
  }

  if (decision.should_request_contact) {
    const valueReply = withoutContactRequest(decision.final_reply);
    if (!valueReply) throw new Error("V10_CONTACT_ONLY_REPLY_INVALID");

    if (!CONTACT_REQUEST_PATTERN.test(decision.final_reply) || !replySentences(decision.final_reply).some(isDirectContactRequest)) {
      const baseReply = compactReply(valueReply, 430);
      decision.final_reply = compactReply(`${baseReply}${/[.!?]$/.test(baseReply) ? "" : "."} ${contactRequestSentence(decision.contact_benefit)}`);
    } else {
      decision.final_reply = contactRequestLast(decision.final_reply);
    }
  }

  if (!["suppress"].includes(decision.action) && !decision.final_reply) {
    if (decision.contact_state === "missing_recently_requested") throw new Error("V10_REPEATED_CONTACT_ONLY_REPLY_INVALID");
    throw new Error("V10_FINAL_REPLY_REQUIRED");
  }
  if (decision.action === "suppress") decision.final_reply = "";
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
