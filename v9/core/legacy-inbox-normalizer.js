import { detectContact } from "./contact-detector.js";
import { commentPrivateReplyEligibility } from "./comment-private-reply.js";

function text(value) {
  const valueText = String(value ?? "").trim();
  return valueText || null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function parseTime(value, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}

function inferEventKind(payload, raw) {
  const declared = text(payload.event_kind);
  if (declared) return declared;
  if (raw?.message?.is_echo === true) return "message_echo";
  if (raw?.message) return "message";
  if (raw?.postback) return "postback";
  if (raw?.optin) return "marketing_optin";
  if (raw?.referral) return "referral";
  return "unknown";
}

function eventTypeFor(kind, isEcho) {
  if (isEcho) return "page_message";
  if (kind === "message") return "customer_message";
  if (kind === "postback") return "customer_postback";
  if (kind === "referral") return "customer_referral";
  if (kind === "marketing_optin") return "customer_optin";
  return "unknown";
}

export function normalizeLegacyWebhookInboxRow(row, nowMs = Date.now()) {
  if (!row?.id) throw new TypeError("V9_LEGACY_INBOX_ID_REQUIRED");
  const payload = object(row.payload);
  const sourceEventId = `legacy_inbox:${row.id}`;
  const receivedAt = parseTime(row.created_at || row.updated_at, nowMs);

  if (payload.kind === "feed_change") {
    const change = object(payload.change);
    const value = object(change.value);
    const pageId = text(row.page_id || payload.page_id);
    const senderId = text(value.from?.id || row.sender_id);
    const item = text(value.item);
    const verb = text(value.verb);
    const isComment = item === "comment" && ["add", "edited"].includes(String(verb || ""));
    const isPageActor = Boolean(pageId && senderId && pageId === senderId);
    const isCustomerComment = Boolean(isComment && senderId && !isPageActor);
    const commentEligibility = commentPrivateReplyEligibility({
      page_id: pageId,
      sender_id: senderId,
      message_text: value.message,
      payload: { change },
    });
    return {
      source_system: "legacy_webhook_inbox",
      source_event_id: sourceEventId,
      page_id: pageId,
      sender_id: senderId,
      recipient_id: pageId,
      customer_id: isCustomerComment ? senderId : null,
      message_id: text(row.message_id) || sourceEventId,
      actor_type: isCustomerComment ? "customer" : (isPageActor ? "page_unknown" : "unknown"),
      actor_evidence: {
        method: "legacy_feed_change_v2_actor_direction",
        human_verified: false,
        page_authored: isPageActor,
        item,
        verb,
      },
      event_type: isCustomerComment ? "customer_comment" : (isPageActor && isComment ? "page_comment" : "feed_activity"),
      message_text: text(value.message),
      attachments: [],
      referral: null,
      occurred_at: parseTime(row.event_time || value.created_time, nowMs),
      received_at: receivedAt,
      payload: {
        kind: "feed_change",
        change,
        comment_private_reply: isCustomerComment ? {
          eligible: commentEligibility.eligible,
          reason: commentEligibility.reason,
          comment_id: commentEligibility.commentId,
          public_reply_forbidden: true,
        } : null,
      },
      actor_app_id: null,
      // A customer comment with a commercial need enters the same decision engine as
      // Messenger, but outbound must use Meta's private-reply recipient.comment_id.
      // Public comment replies remain forbidden.
      decision_eligible: Boolean(isCustomerComment && commentEligibility.eligible),
      comment_private_reply: isCustomerComment ? {
        eligible: commentEligibility.eligible,
        reason: commentEligibility.reason,
        comment_id: commentEligibility.commentId,
        public_reply_forbidden: true,
      } : null,
      contact_phone: isCustomerComment ? commentEligibility.phone || null : null,
    };
  }

  if (payload.kind !== "meta_event") return null;
  const event = object(payload.event);
  const raw = object(event.raw_payload);
  const message = object(raw.message);
  const postback = object(raw.postback);
  const optin = object(raw.optin);
  const eventKind = inferEventKind(payload, raw);
  const isEcho = eventKind === "message_echo" || message.is_echo === true;
  const pageId = text(row.page_id || event.page_id || raw.recipient?.id);
  const rawSender = text(event.sender_id || row.sender_id || raw.sender?.id);
  const rawRecipient = text(event.recipient_id || row.recipient_id || raw.recipient?.id || pageId);
  const customerId = isEcho ? rawRecipient : rawSender;
  const messageText = text(event.message_text || message.text || postback.title || postback.payload || optin.title || optin.payload);
  const attachments = array(event.attachments || message.attachments);
  const contact = !isEcho ? detectContact(messageText) : detectContact("");
  const actorAppId = text(message.app_id || raw.app_id);

  return {
    source_system: "legacy_webhook_inbox",
    source_event_id: sourceEventId,
    page_id: pageId,
    sender_id: isEcho ? pageId : rawSender,
    recipient_id: isEcho ? customerId : rawRecipient,
    customer_id: customerId,
    message_id: text(event.message_id || row.message_id || message.mid || postback.mid) || sourceEventId,
    actor_type: isEcho ? "page_unknown" : "customer",
    actor_evidence: {
      method: isEcho ? "meta_echo_unverified_v1" : "meta_inbound_direction_v1",
      human_verified: false,
      is_echo: isEcho,
      app_id: actorAppId,
      event_kind: eventKind,
    },
    event_type: eventTypeFor(eventKind, isEcho),
    message_text: messageText,
    attachments,
    referral: object(event.referral || raw.referral || message.referral || postback.referral),
    occurred_at: parseTime(event.event_time || row.event_time || raw.timestamp, nowMs),
    received_at: receivedAt,
    payload: {
      kind: "meta_event",
      event_kind: eventKind,
      raw_payload: raw,
      legacy_inbox_id: String(row.id),
    },
    actor_app_id: actorAppId,
    decision_eligible: !isEcho && ["message", "postback"].includes(eventKind) && Boolean(messageText || attachments.length),
    contact_phone: contact.primaryPhone,
  };
}

export const legacyInboxNormalizerVersion = "v9_legacy_inbox_normalizer_v3_comment_private_reply";
