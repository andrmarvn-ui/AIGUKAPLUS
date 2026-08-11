import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLegacyWebhookInboxRow } from "../v9/core/legacy-inbox-normalizer.js";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  page_id: "page-1",
  sender_id: "customer-1",
  recipient_id: "page-1",
  message_id: "mid-1",
  event_time: "2026-07-29T10:00:00Z",
  created_at: "2026-07-29T10:00:01Z",
};

test("normalizes inbound message and detects contact", () => {
  const event = normalizeLegacyWebhookInboxRow({
    ...base,
    payload: {
      kind: "meta_event",
      event_kind: "message",
      event: {
        page_id: "page-1",
        sender_id: "customer-1",
        recipient_id: "page-1",
        message_id: "mid-1",
        message_text: "Zalo 0965 499 803",
        event_time: "2026-07-29T10:00:00Z",
        attachments: [],
        referral: { ad_id: "ad-1" },
        raw_payload: { sender: { id: "customer-1" }, recipient: { id: "page-1" }, message: { mid: "mid-1", text: "Zalo 0965 499 803" } },
      },
    },
  });
  assert.equal(event.actor_type, "customer");
  assert.equal(event.event_type, "customer_message");
  assert.equal(event.customer_id, "customer-1");
  assert.equal(event.contact_phone, "0965499803");
  assert.equal(event.decision_eligible, true);
  assert.equal(event.source_event_id, `legacy_inbox:${base.id}`);
});

test("keeps outbound echo unverified and captures app evidence", () => {
  const event = normalizeLegacyWebhookInboxRow({
    ...base,
    sender_id: "page-1",
    recipient_id: "customer-1",
    payload: {
      kind: "meta_event",
      event_kind: "message_echo",
      event: {
        page_id: "page-1",
        sender_id: "page-1",
        recipient_id: "customer-1",
        message_id: "echo-1",
        message_text: "Automated reply",
        event_time: "2026-07-29T10:00:00Z",
        raw_payload: { sender: { id: "page-1" }, recipient: { id: "customer-1" }, message: { mid: "echo-1", is_echo: true, app_id: "app-9" } },
      },
    },
  });
  assert.equal(event.actor_type, "page_unknown");
  assert.equal(event.event_type, "page_message");
  assert.equal(event.customer_id, "customer-1");
  assert.equal(event.actor_app_id, "app-9");
  assert.equal(event.actor_evidence.human_verified, false);
  assert.equal(event.decision_eligible, false);
});

test("referral is durable but never decision eligible by itself", () => {
  const event = normalizeLegacyWebhookInboxRow({
    ...base,
    payload: {
      kind: "meta_event",
      event_kind: "referral",
      event: {
        page_id: "page-1",
        sender_id: "customer-1",
        recipient_id: "page-1",
        message_id: "ref-1",
        event_time: "2026-07-29T10:00:00Z",
        referral: { ad_id: "ad-1" },
        raw_payload: { sender: { id: "customer-1" }, recipient: { id: "page-1" }, referral: { ad_id: "ad-1" } },
      },
    },
  });
  assert.equal(event.event_type, "customer_referral");
  assert.equal(event.decision_eligible, false);
});

test("customer comment is preserved without creating a Messenger AI job", () => {
  const event = normalizeLegacyWebhookInboxRow({
    ...base,
    payload: {
      kind: "feed_change",
      page_id: "page-1",
      change: { value: { from: { id: "customer-2" }, item: "comment", verb: "add", message: "Comment", created_time: 1785310000 } },
    },
  });
  assert.equal(event.actor_type, "customer");
  assert.equal(event.event_type, "customer_comment");
  assert.equal(event.customer_id, "customer-2");
  assert.equal(event.decision_eligible, false);
});

test("page-authored comments are never classified as customers", () => {
  const event = normalizeLegacyWebhookInboxRow({
    ...base,
    payload: {
      kind: "feed_change",
      page_id: "page-1",
      change: { value: { from: { id: "page-1" }, item: "comment", verb: "add", message: "Vui lòng kiểm tra tin nhắn", created_time: 1785310000 } },
    },
  });
  assert.equal(event.actor_type, "page_unknown");
  assert.equal(event.event_type, "page_comment");
  assert.equal(event.customer_id, null);
});

test("page hide and reaction events cannot create fake customer state", () => {
  for (const value of [
    { from: { id: "page-1" }, item: "comment", verb: "hide", message: "Customer text" },
    { from: { id: "page-1" }, item: "reaction", verb: "add" },
  ]) {
    const event = normalizeLegacyWebhookInboxRow({
      ...base,
      payload: { kind: "feed_change", page_id: "page-1", change: { value } },
    });
    assert.notEqual(event.actor_type, "customer");
    assert.equal(event.event_type, "feed_activity");
    assert.equal(event.customer_id, null);
  }
});

test("unknown inbox payload is ignored safely", () => {
  assert.equal(normalizeLegacyWebhookInboxRow({ ...base, payload: { kind: "unknown" } }), null);
});
