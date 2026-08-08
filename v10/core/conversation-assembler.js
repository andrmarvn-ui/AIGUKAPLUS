import { buildAdvisoryBundle, hasOptOutIntent, normalizeVietnamese } from "./advisory-engine.js";

const STRUCTURED_REPLACE_WINDOW_MS = 2_000;

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

function rawPostback(event = {}) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return payload?.raw_payload?.postback || payload?.postback || event?.postback || null;
}

function titleSemanticPayload(value = "") {
  const text = normalizeVietnamese(value);
  if (!text) return null;
  if (/\b(gach|op lat|lat nen|da op lat)\b/.test(text)) return "XEM_GACH_OP_LAT";
  if (/\b(nha tam|phong tam|nha ve sinh)\b/.test(text) && /\b(nha bep|phong bep|bep)\b/.test(text)) return "XEM_NHA_TAM_NHA_BEP";
  if (/\b(nha tam|phong tam|nha ve sinh|thiet bi ve sinh)\b/.test(text)) return "XEM_NHA_TAM";
  if (/\b(nha bep|phong bep|bep|chau rua bat|voi rua bat)\b/.test(text)) return "XEM_NHA_BEP";
  if (/\b(quat|quant|den chum|den trum)\b/.test(text)) return "XEM_QUAT_TRAN";
  if (/\b(bon cau|toilet|bet)\b/.test(text)) return "XEM_BON_CAU";
  return null;
}

function structuredMenuGroup(message = {}) {
  if (!message?.postback) return null;
  const effectivePayload = String(message.postback.effective_payload || message.postback.payload || "").toUpperCase();
  const title = normalizeVietnamese(message.postback.title || message.text || "");
  if (effectivePayload.startsWith("XEM_") || /\b(tu van|xem|mau)\b/.test(title)) return "PRODUCT_CONSULT_MENU";
  return `POSTBACK:${effectivePayload || "UNKNOWN"}`;
}

function inferTextRelationHint(value = "") {
  const text = normalizeVietnamese(value);
  if (!text) return "CONTINUE";
  if (/\b(khong can|bo qua|bo di|thoi khong|khong xem|huy)\b/.test(text)) return "CANCEL";
  if (/\b(chi xem|chi can|chi lay|chuyen sang|thoi xem|xem moi|doi sang)\b/.test(text)) return "REPLACE";
  if (/\b(nua|them|ca hai|ca 2|ca ba|ca 3|va ca|voi ca|xem them)\b/.test(text)) return "ADD";
  if (/\b(mau den|mau vang|mau nau|mau go|gold|black|brown|wood|8 canh|10 canh|5 canh|6 canh|kich thuoc|loai re|loai dep|loai khac)\b/.test(text)) return "REFINE";
  return "CONTINUE";
}

function normalizeEvent(event = {}) {
  const postback = rawPostback(event);
  const text = String(event.message_text ?? event.text ?? postback?.title ?? "");
  const payloadValue = postback?.payload == null ? null : String(postback.payload);
  const titleValue = String(postback?.title || text || "");
  const titlePayload = titleSemanticPayload(titleValue);
  const payloadMismatch = Boolean(titlePayload && payloadValue && titlePayload !== payloadValue);
  return {
    id: String(event.source_event_id || event.sourceEventId || event.id || ""),
    role: normalizeRole(event),
    event_type: String(event.event_type || event.eventType || ""),
    text,
    attachments: Array.isArray(event.attachments) ? event.attachments : (event.attachments || []),
    referral: event.referral && typeof event.referral === "object" ? event.referral : null,
    payload: event.payload && typeof event.payload === "object" ? event.payload : null,
    postback: postback ? {
      title: titleValue || null,
      payload: payloadValue,
      effective_payload: titlePayload || payloadValue,
      payload_title_mismatch: payloadMismatch,
      semantic_source: titlePayload ? "title_authoritative" : "payload_only",
    } : null,
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

function annotateInputSemantics(messages = []) {
  const annotated = messages.map((message) => ({
    ...message,
    semantic_status: "active",
    semantic_relation: message.role === "customer" && !message.postback ? inferTextRelationHint(message.text) : null,
    menu_group: structuredMenuGroup(message),
  }));
  let lastStructuredIndex = -1;
  let supersededStructuredChoices = 0;
  let payloadTitleMismatches = 0;

  for (let index = 0; index < annotated.length; index += 1) {
    const current = annotated[index];
    if (current?.postback?.payload_title_mismatch) payloadTitleMismatches += 1;
    if (current?.role !== "customer" || !current?.postback || !current.menu_group) continue;

    if (lastStructuredIndex >= 0) {
      const previous = annotated[lastStructuredIndex];
      const gap = asTime(current.occurred_at) - asTime(previous.occurred_at);
      const noNonCustomerBetween = annotated.slice(lastStructuredIndex + 1, index).every((item) => item?.role === "customer");
      if (
        gap >= 0
        && gap <= STRUCTURED_REPLACE_WINDOW_MS
        && noNonCustomerBetween
        && previous.menu_group === current.menu_group
      ) {
        previous.semantic_status = "superseded";
        previous.semantic_relation = "REPLACED_BY_STRUCTURED_CHOICE";
        previous.superseded_by_message_id = current.id || null;
        current.semantic_relation = "REPLACE";
        current.replaces_message_id = previous.id || null;
        supersededStructuredChoices += 1;
      } else {
        current.semantic_relation = "CONTINUE";
      }
    } else {
      current.semantic_relation = "CONTINUE";
    }
    lastStructuredIndex = index;
  }

  return {
    messages: annotated,
    summary: {
      structured_choice_replace_window_ms: STRUCTURED_REPLACE_WINDOW_MS,
      superseded_structured_choices: supersededStructuredChoices,
      payload_title_mismatches: payloadTitleMismatches,
      title_is_authoritative_when_payload_conflicts: true,
      free_text_relation_is_advisory_only: true,
    },
  };
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
  const selectedMessages = selectSession(allMessages, options);
  const semantic = annotateInputSemantics(selectedMessages);
  const messages = semantic.messages;
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
    input_semantics: semantic.summary,
    safety,
    hard_stop_reason: hardStopReason,
    requires_ai: !hardStopReason,
    policy: {
      latest_message_is_not_authoritative: true,
      structured_choice_same_menu_latest_replaces_previous: true,
      page_reply_requires_message_after_latest_customer: true,
      rules_are_advisory_only: true,
      ai_is_sole_business_decision_maker: true,
    },
  };
}
