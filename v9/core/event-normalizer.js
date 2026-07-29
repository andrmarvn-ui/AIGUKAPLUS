const MIN_REASONABLE_EVENT_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function parseTime(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function resolveOccurredAt(row, nowMs = Date.now()) {
  const eventMs = parseTime(row.event_time);
  if (
    eventMs !== null &&
    eventMs >= MIN_REASONABLE_EVENT_MS &&
    eventMs <= nowMs + MAX_FUTURE_SKEW_MS
  ) {
    return new Date(eventMs).toISOString();
  }

  const timestampMs = Number(row.timestamp_ms);
  if (
    Number.isFinite(timestampMs) &&
    timestampMs >= MIN_REASONABLE_EVENT_MS &&
    timestampMs <= nowMs + MAX_FUTURE_SKEW_MS
  ) {
    return new Date(timestampMs).toISOString();
  }

  const createdMs = parseTime(row.created_at);
  return new Date(createdMs ?? nowMs).toISOString();
}

function resolveActorType(row) {
  const pageId = String(row.page_id || "");
  const senderId = String(row.sender_id || "");
  const recipientId = String(row.recipient_id || "");

  if (pageId && senderId && senderId === pageId) return "page_unknown";
  if (pageId && senderId && recipientId === pageId && senderId !== pageId) return "customer";
  return "unknown";
}

function resolveEventType(row, actorType) {
  const raw = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
  if (raw.referral || row.referral) return "referral";
  if (raw.delivery) return "delivery";
  if (raw.read) return "read";
  if (raw.postback) return actorType === "customer" ? "customer_postback" : "page_postback";
  if (raw.message || row.message_id || row.message_text || row.attachments) {
    return actorType === "customer" ? "customer_message" : actorType === "page_unknown" ? "page_message" : "message";
  }
  return "unknown";
}

export function normalizeV8MetaEvent(row, nowMs = Date.now()) {
  if (!row || !row.id) throw new TypeError("V9_SOURCE_EVENT_ID_REQUIRED");

  const actorType = resolveActorType(row);
  const eventType = resolveEventType(row, actorType);
  const occurredAt = resolveOccurredAt(row, nowMs);
  const receivedAt = new Date(parseTime(row.created_at) ?? nowMs).toISOString();

  return {
    sourceSystem: "v8_meta_events",
    sourceEventId: String(row.id),
    pageId: row.page_id == null ? null : String(row.page_id),
    senderId: row.sender_id == null ? null : String(row.sender_id),
    recipientId: row.recipient_id == null ? null : String(row.recipient_id),
    customerId: actorType === "customer"
      ? (row.sender_id == null ? null : String(row.sender_id))
      : actorType === "page_unknown"
        ? (row.recipient_id == null ? null : String(row.recipient_id))
        : null,
    messageId: row.message_id == null ? null : String(row.message_id),
    actorType,
    actorEvidence: {
      method: "page_sender_recipient_identity_v1",
      page_id: row.page_id ?? null,
      sender_id: row.sender_id ?? null,
      recipient_id: row.recipient_id ?? null,
      confidence: actorType === "unknown" ? 0 : 0.9,
      human_verified: false,
    },
    eventType,
    text: row.message_text == null ? null : String(row.message_text),
    attachments: row.attachments ?? [],
    referral: row.referral ?? null,
    occurredAt,
    receivedAt,
    payload: row.raw_payload ?? {},
  };
}

export const __private__ = {
  resolveOccurredAt,
  resolveActorType,
  resolveEventType,
};
