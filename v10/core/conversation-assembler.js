import { buildAdvisoryBundle, hasOptOutIntent } from "./advisory-engine.js";

function asTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function normalizeRole(event = {}) {
  const actor = String(event.actor_type || event.actorType || "").toLowerCase();
  const type = String(event.event_type || event.eventType || "").toLowerCase();
  if (actor === "customer" || type.startsWith("customer_")) return "customer";
  if (["human", "admin", "sale"].includes(actor) || type === "human_message") return "human";
  if (["bot", "automation", "page"].includes(actor) || ["bot_message", "automation_message", "page_message"].includes(type)) return actor === "automation" ? "automation" : actor === "bot" ? "bot" : "page";
  return "unknown";
}

function normalizeEvent(event = {}) {
  return {
    id: String(event.source_event_id || event.sourceEventId || event.id || ""),
    role: normalizeRole(event),
    event_type: String(event.event_type || event.eventType || ""),
    text: String(event.message_text ?? event.text ?? ""),
    attachments: Array.isArray(event.attachments) ? event.attachments : (event.attachments || []),
    referral: event.referral && typeof event.referral === "object" ? event.referral : null,
    occurred_at: event.occurred_at || event.occurredAt || event.received_at || event.created_at || null,
  };
}

function selectSession(messages, { maxEvents = 60, sessionGapMinutes = 360 } = {}) {
  const sorted = messages
    .map((message, input_order) => ({ ...message, input_order }))
    .sort((a, b) => asTime(a.occurred_at) - asTime(b.occurred_at) || a.input_order - b.input_order)
    .map(({ input_order, ...message }) => message);
  const capped = sorted.slice(-Math.max(10, maxEvents));
  if (capped.length < 2) return capped;
  const maxGapMs = Math.max(30, sessionGapMinutes) * 60_000;
  let start = 0;
  for (let index = 1; index < capped.length; index += 1) {
    const gap = asTime(capped[index].occurred_at) - asTime(capped[index - 1].occurred_at);
    if (gap > maxGapMs) start = index;
  }
  return capped.slice(start);
}

function latestByRole(messages, roles) {
  const allowed = new Set(roles);
  return [...messages].reverse().find((message) => allowed.has(message.role)) || null;
}

function verifiedPageReplyAfterLatestCustomer(messages) {
  let latestCustomerIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "customer") {
      latestCustomerIndex = index;
      break;
    }
  }
  if (latestCustomerIndex < 0) return false;

  return messages.slice(latestCustomerIndex + 1).some((message) =>
    ["human", "bot", "automation", "page"].includes(message?.role)
  );
}

function carryReferral(messages) {
  let referral = null;
  for (const message of messages) {
    if (message.referral && Object.keys(message.referral).length) referral = message.referral;
  }
  return referral;
}

export function buildConversationContext(events = [], options = {}) {
  const allMessages = (events || []).map(normalizeEvent).filter((message) => message.id || message.text || message.attachments?.length);
  const messages = selectSession(allMessages, options);
  const customerMessages = messages.filter((message) => message.role === "customer");
  const latestCustomer = customerMessages.at(-1) || null;
  if (!latestCustomer) return { valid: false, reason: "NO_CUSTOMER_MESSAGE", messages: [] };

  const referral = carryReferral(messages);
  const advisors = buildAdvisoryBundle({
    messages,
    referral,
    customer: options.customer || {},
    state: options.state || {},
    mappingCandidates: options.mappingCandidates || [],
    catalog: options.catalog || [],
  });

  const safety = {
    opt_out: hasOptOutIntent(messages),
    human_takeover: Boolean(options.state?.human_takeover && (!options.state?.human_takeover_until || asTime(options.state.human_takeover_until) > Date.now())),
    verified_page_reply_after_latest_customer: verifiedPageReplyAfterLatestCustomer(messages),
  };
  const hardStopReason = safety.opt_out
    ? "OPT_OUT"
    : safety.human_takeover
      ? "HUMAN_TAKEOVER"
      : safety.verified_page_reply_after_latest_customer
        ? "PAGE_ALREADY_REPLIED"
        : null;

  return {
    valid: true,
    architecture: "v10_ai_sovereign_advisory",
    messages,
    latest_customer_message: latestCustomer,
    referral,
    advisors,
    safety,
    hard_stop_reason: hardStopReason,
    requires_ai: !hardStopReason,
    policy: {
      latest_message_is_not_authoritative: true,
      page_reply_requires_message_after_latest_customer: true,
      rules_are_advisory_only: true,
      ai_is_sole_business_decision_maker: true,
    },
  };
}
