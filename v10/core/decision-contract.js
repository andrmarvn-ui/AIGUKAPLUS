const ACTIONS = ["reply_text", "reply_with_slides", "ask_clarification", "acknowledge_contact", "suppress"];

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
      "should_request_contact",
      "confidence",
      "decision_reason",
    ],
    properties: {
      action: { type: "string", enum: ACTIONS },
      final_reply: { type: "string", maxLength: 2000 },
      selected_products: { type: "array", items: { type: "string" }, maxItems: 10 },
      selected_catalog_keys: { type: "array", items: { type: "string" }, maxItems: 10 },
      intents: { type: "array", items: { type: "string" }, maxItems: 12 },
      needs_slides: { type: "boolean" },
      should_request_contact: { type: "boolean" },
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
    "You are the sole business decision maker for AIGUKA customer conversations.",
    "Read the complete chronological conversation. Never let the latest message erase unresolved needs stated earlier.",
    "The advisory bundle, mappings, catalog hints, previous product keys, rules and locks are non-binding suggestions. They may conflict. You must reason from the actual conversation and decide yourself.",
    "Preserve every simultaneous product need unless the customer explicitly cancels, changes or prioritizes one. If several groups are active, selected_products and follow_up_plan must include all relevant groups.",
    "Do not replace a customer-requested group with an advertising or mapping candidate.",
    "Ask a clarification when evidence is genuinely ambiguous. Do not guess prices, specifications, brands, stock or delivery promises.",
    "If contact details are already known, continue answering and do not ask for them again. If the customer prefers Messenger, continue on Messenger.",
    "For media, choose catalog keys only when they genuinely match the conversation. Multiple product groups should receive balanced media, not one group only.",
    "Write natural Vietnamese using em and anh/chị when gender is uncertain.",
    "Return only the submit_v10_decision tool call.",
  ].join("\n");
}

function strings(values, limit = 12) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

export function validateDecision(input = {}) {
  if (!input || typeof input !== "object") throw new Error("V10_DECISION_INVALID");
  const action = String(input.action || "");
  if (!ACTIONS.includes(action)) throw new Error(`V10_ACTION_INVALID:${action}`);
  const finalReply = String(input.final_reply || "").trim();
  if (!["suppress"].includes(action) && !finalReply) throw new Error("V10_FINAL_REPLY_REQUIRED");

  const decision = {
    action,
    final_reply: finalReply,
    selected_products: strings(input.selected_products, 10),
    selected_catalog_keys: strings(input.selected_catalog_keys, 10),
    intents: strings(input.intents, 12),
    needs_slides: Boolean(input.needs_slides),
    should_request_contact: Boolean(input.should_request_contact),
    confidence: Math.max(0, Math.min(1, Number(input.confidence || 0))),
    decision_reason: String(input.decision_reason || "").slice(0, 600),
    follow_up_plan: Array.isArray(input.follow_up_plan)
      ? input.follow_up_plan.slice(0, 8).map((item) => ({
          topic: String(item?.topic || "").slice(0, 120),
          status: ["answer_now", "send_media", "ask_clarification", "keep_pending", "completed"].includes(String(item?.status || ""))
            ? String(item.status)
            : "keep_pending",
        })).filter((item) => item.topic)
      : [],
  };

  if (decision.needs_slides && decision.action !== "reply_with_slides") decision.action = "reply_with_slides";
  if (!decision.needs_slides && decision.action === "reply_with_slides") decision.needs_slides = true;
  return decision;
}

export function neutralUnavailableDecision({ contactKnown = false } = {}) {
  return {
    action: "reply_text",
    final_reply: "Dạ em đã nhận đầy đủ nội dung anh/chị vừa gửi. Hệ thống tư vấn đang quá tải nên bên em chưa thể trả lời chính xác ngay; anh/chị không cần gửi lại, bên em sẽ tiếp tục xử lý và phản hồi tại Messenger ạ.",
    selected_products: [],
    selected_catalog_keys: [],
    intents: ["service_unavailable"],
    needs_slides: false,
    should_request_contact: false,
    confidence: 0.7,
    decision_reason: contactKnown
      ? "Operational acknowledgement after repeated AI processing failures; contact already known."
      : "Operational acknowledgement after repeated AI processing failures.",
    follow_up_plan: [{ topic: "customer_request", status: "keep_pending" }],
  };
}
