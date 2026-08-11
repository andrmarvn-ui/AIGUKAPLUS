function clean(value) {
  return String(value || "").trim();
}

function isoTime(value, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}

export function observedPageReplyDisposition(reply = {}) {
  const source = clean(reply.source_system).toLowerCase();
  if (source === "human_admin") {
    return {
      actor_type: "admin",
      event_type: "human_message",
      resolution: "human_replied",
      human_takeover: true,
    };
  }
  if (["aicake", "page_automation"].includes(source)) {
    return {
      actor_type: "automation",
      event_type: "automation_message",
      resolution: "external_primary_replied",
      human_takeover: false,
    };
  }
  return {
    actor_type: "page_unknown",
    event_type: "page_message",
    resolution: "verified_page_replied",
    human_takeover: false,
  };
}

export function observedPageReplySourceId({ pageId, senderId, reply = {} } = {}) {
  const sentAt = isoTime(reply.sent_at);
  const conversationId = clean(reply.conversation_id) || clean(senderId) || "unknown";
  return `pancake_live:${clean(pageId)}:${conversationId}:${sentAt}`;
}

export function buildObservedPageReplyEvent(decision = {}, reply = {}, nowMs = Date.now()) {
  const disposition = observedPageReplyDisposition(reply);
  const occurredAt = isoTime(reply.sent_at, nowMs);
  const sourceEventId = observedPageReplySourceId({
    pageId: decision.page_id,
    senderId: decision.sender_id,
    reply: { ...reply, sent_at: occurredAt },
  });
  return {
    source_system: "pancake_live",
    source_event_id: sourceEventId,
    page_id: clean(decision.page_id),
    sender_id: clean(decision.page_id),
    customer_id: clean(decision.sender_id),
    recipient_id: clean(decision.sender_id),
    message_id: sourceEventId,
    actor_type: disposition.actor_type,
    actor_evidence: {
      method: "pancake_live_verified_page_reply_v1",
      human_verified: disposition.human_takeover,
      source_system: clean(reply.source_system) || "page",
      actor_name: clean(reply.actor_name) || null,
      actor_app_id: clean(reply.actor_app_id) || null,
      conversation_id: clean(reply.conversation_id) || null,
    },
    event_type: disposition.event_type,
    message_text: clean(reply.message_text) || null,
    attachments: [],
    referral: {},
    occurred_at: occurredAt,
    received_at: new Date(nowMs).toISOString(),
    payload: {
      kind: "pancake_live_page_reply",
      evidence: clean(reply.evidence) || "pancake_live_shared_page_snapshot",
      source_system: clean(reply.source_system) || "page",
      conversation_id: clean(reply.conversation_id) || null,
    },
  };
}

export function observedPageReplyStatePatch(current = {}, reply = {}, nowMs = Date.now()) {
  const disposition = observedPageReplyDisposition(reply);
  const occurredAt = isoTime(reply.sent_at, nowMs);
  const currentPageAt = Date.parse(String(current.last_page_event_at || ""));
  const observedAt = Date.parse(occurredAt);
  const humanAlreadyActive = current.human_takeover === true
    && (!current.human_takeover_until || Date.parse(String(current.human_takeover_until)) > nowMs);
  const contactTerminal = String(current.state || "").toUpperCase() === "CONTACT_CAPTURED";
  const patch = {
    response_deadline_at: null,
    updated_at: new Date(nowMs).toISOString(),
  };
  if (!Number.isFinite(currentPageAt) || observedAt > currentPageAt) patch.last_page_event_at = occurredAt;
  if (disposition.human_takeover) {
    patch.state = "ANSWERED_BY_HUMAN";
    patch.human_takeover = true;
    patch.human_takeover_until = null;
  } else if (!humanAlreadyActive && !contactTerminal) {
    patch.state = "BOT_REPLIED";
  }
  return patch;
}

export function customerSlaSourceIds(decision = {}) {
  const messages = Array.isArray(decision?.input_snapshot?.conversation?.messages)
    ? decision.input_snapshot.conversation.messages
    : [];
  const customer = messages.filter((message) => message?.role === "customer");
  const times = customer.map((message) => Date.parse(String(message?.occurred_at || ""))).filter(Number.isFinite);
  const latestAt = times.length ? Math.max(...times) : 0;
  const active = latestAt
    ? customer.filter((message) => {
      const occurredAt = Date.parse(String(message?.occurred_at || ""));
      return Number.isFinite(occurredAt) && occurredAt >= latestAt - 10 * 60_000;
    })
    : customer;
  return [...new Set(active
    .map((message) => clean(message?.id || message?.source_event_id))
    .filter(Boolean))];
}

export const pageReplyEvidenceVersion = "v10_page_reply_evidence_v1_persist_and_resolve_sla";
