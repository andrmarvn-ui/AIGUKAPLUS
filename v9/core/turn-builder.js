import { detectContact } from "./contact-detector.js";

const CUSTOMER_TYPES = new Set(["customer_message", "customer_postback"]);
const RESPONSE_TYPES = new Set(["human_message", "automation_message", "bot_message", "page_message"]);

function timeOf(event) {
  const parsed = Date.parse(String(event?.occurred_at || event?.occurredAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventId(event) {
  return String(event?.source_event_id || event?.sourceEventId || "");
}

export function extractSalesSignals(text) {
  const value = String(text || "").toLowerCase();
  const intents = [];
  const products = [];
  const push = (array, item) => { if (!array.includes(item)) array.push(item); };

  if (/giá|bao nhiêu|báo giá|chi phí/.test(value)) push(intents, "price");
  if (/địa chỉ|ở đâu|vị trí|showroom|đường đi/.test(value)) push(intents, "address");
  if (/mẫu|hình|ảnh|catalog|xem/.test(value)) push(intents, "samples");
  if (/xem hết|tất cả|đầy đủ|có những gì/.test(value)) push(intents, "all_products");
  if (/mua|chốt|đặt|lấy/.test(value)) push(intents, "purchase");
  if (/ship|giao hàng|vận chuyển/.test(value)) push(intents, "delivery");

  const productRules = [
    ["combo_phong_tam", /combo.*phòng tắm|phòng tắm/],
    ["bon_cau", /bồn cầu/],
    ["lavabo", /lavabo|chậu.*rửa mặt/],
    ["sen_tam", /sen tắm/],
    ["bep_tu_hut_mui", /bếp từ|hút mùi/],
    ["chau_voi_rua_bat", /chậu.*rửa bát|vòi.*rửa bát/],
    ["quat_tran", /quạt trần/],
    ["den_trang_tri", /đèn chùm|đèn trang trí/],
    ["gach_op_lat", /gạch|ốp lát/],
  ];
  for (const [key, pattern] of productRules) if (pattern.test(value)) push(products, key);
  return { intents, products, multiIntent: intents.length > 1, multiProduct: products.length > 1 };
}

export function buildConversationTurn(events, options = {}) {
  const maxGapMs = Math.max(15, Number(options.maxGapSeconds || 90)) * 1000;
  const coexistenceMode = String(options.coexistenceMode || "AICAKE_ACTIVE").toUpperCase();
  const state = options.state || {};
  const sorted = [...(events || [])].sort((a, b) => timeOf(a) - timeOf(b) || eventId(a).localeCompare(eventId(b)));
  let latestCustomerIndex = -1;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (CUSTOMER_TYPES.has(sorted[index]?.event_type || sorted[index]?.eventType)) {
      latestCustomerIndex = index;
      break;
    }
  }
  if (latestCustomerIndex < 0) {
    return { valid: false, action: "no_customer_turn", customerMessages: [], combinedText: "" };
  }

  const customerEvents = [sorted[latestCustomerIndex]];
  for (let index = latestCustomerIndex - 1; index >= 0; index -= 1) {
    const current = sorted[index];
    const next = customerEvents[0];
    const type = current?.event_type || current?.eventType;
    if (!CUSTOMER_TYPES.has(type)) break;
    if (timeOf(next) - timeOf(current) > maxGapMs) break;
    customerEvents.unshift(current);
  }

  const latestCustomerAt = timeOf(sorted[latestCustomerIndex]);
  const responses = sorted.filter((event) => RESPONSE_TYPES.has(event?.event_type || event?.eventType) && timeOf(event) >= latestCustomerAt);
  const verifiedHuman = responses.find((event) => {
    const type = event?.event_type || event?.eventType;
    return type === "human_message" && event?.actor_evidence?.human_verified === true;
  });
  const automation = responses.find((event) => (event?.event_type || event?.eventType) === "automation_message");
  const bot = responses.find((event) => (event?.event_type || event?.eventType) === "bot_message");
  const ambiguous = responses.find((event) => (event?.event_type || event?.eventType) === "page_message");
  const combinedText = customerEvents.map((event) => String(event?.message_text ?? event?.text ?? "").trim()).filter(Boolean).join("\n");
  const contact = detectContact(combinedText);
  const salesSignals = extractSalesSignals(combinedText);

  let action = "needs_ai_decision";
  if (contact.contactCaptured) action = "contact_captured";
  else if (verifiedHuman || state.human_takeover === true || state.humanTakeover === true) action = "human_takeover_active";
  else if (bot) action = "aiguka_already_replied";
  else if (automation && coexistenceMode === "AICAKE_ACTIVE") action = "external_bot_replied";
  else if (ambiguous) action = "wait_actor_reconciliation";

  return {
    valid: true,
    action,
    customerMessages: customerEvents.map((event) => ({
      sourceEventId: eventId(event),
      occurredAt: event?.occurred_at || event?.occurredAt || null,
      text: event?.message_text ?? event?.text ?? null,
    })),
    combinedText,
    contact,
    salesSignals,
    responseEvidence: {
      verifiedHuman: verifiedHuman ? eventId(verifiedHuman) : null,
      automation: automation ? {
        sourceEventId: eventId(automation),
        provider: automation?.actor_evidence?.provider || null,
      } : null,
      bot: bot ? eventId(bot) : null,
      ambiguousPage: ambiguous ? eventId(ambiguous) : null,
    },
    shouldRequestContact: !contact.contactCaptured && action === "needs_ai_decision",
  };
}
