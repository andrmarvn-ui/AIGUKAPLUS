import test from "node:test";
import assert from "node:assert/strict";
import { normalizeV8MetaEvent } from "../v9/core/event-normalizer.js";
import { detectContact } from "../v9/core/contact-detector.js";
import { reduceConversationState } from "../v9/core/state-machine.js";

test("normalizes an inbound customer message", () => {
  const event = normalizeV8MetaEvent({
    id: "11111111-1111-4111-8111-111111111111",
    page_id: "page-1",
    sender_id: "customer-1",
    recipient_id: "page-1",
    message_id: "m1",
    message_text: "Cho mình xin giá",
    event_time: "2026-07-29T05:00:00.000Z",
    created_at: "2026-07-29T05:00:01.000Z",
    raw_payload: { message: { mid: "m1" } },
  }, Date.parse("2026-07-29T05:00:02.000Z"));

  assert.equal(event.actorType, "customer");
  assert.equal(event.eventType, "customer_message");
  assert.equal(event.customerId, "customer-1");
  assert.equal(event.text, "Cho mình xin giá");
});

test("does not call a Page-originated message a verified human answer", () => {
  const event = normalizeV8MetaEvent({
    id: "22222222-2222-4222-8222-222222222222",
    page_id: "page-1",
    sender_id: "page-1",
    recipient_id: "customer-1",
    message_id: "m2",
    message_text: "Tin tự động",
    event_time: "2026-07-29T05:00:00.000Z",
    created_at: "2026-07-29T05:00:01.000Z",
    raw_payload: { message: { mid: "m2" } },
  }, Date.parse("2026-07-29T05:00:02.000Z"));

  assert.equal(event.actorType, "page_unknown");
  assert.equal(event.customerId, "customer-1");
  const next = reduceConversationState({ state: "RECEIVED", version: 1 }, event, detectContact(""), {
    now: "2026-07-29T05:00:02.000Z",
  });
  assert.equal(next.state, "RECEIVED");
});

test("repairs a 1970 event timestamp by using received time", () => {
  const event = normalizeV8MetaEvent({
    id: "33333333-3333-4333-8333-333333333333",
    page_id: "page-1",
    sender_id: "customer-1",
    recipient_id: "page-1",
    message_id: "referral:1",
    event_time: "1970-01-21T15:54:50.238Z",
    created_at: "2026-07-29T05:00:01.000Z",
    raw_payload: { referral: { source: "ADS" } },
  }, Date.parse("2026-07-29T05:00:02.000Z"));

  assert.equal(event.eventType, "referral");
  assert.equal(event.occurredAt, "2026-07-29T05:00:01.000Z");
});

test("detects and normalizes Vietnamese phone numbers", () => {
  assert.deepEqual(detectContact("Zalo mình 0965 499 803"), {
    phones: ["0965499803"],
    primaryPhone: "0965499803",
    mentionsZalo: true,
    hasPhone: true,
    contactCaptured: true,
    evidence: "phone_in_customer_text",
  });
  assert.equal(detectContact("Số +84 965-499-803").primaryPhone, "0965499803");
});

test("moves directly to CONTACT_CAPTURED and clears SLA deadline", () => {
  const event = { eventType: "customer_message", occurredAt: "2026-07-29T05:00:00.000Z" };
  const next = reduceConversationState(null, event, detectContact("0965499803"), {
    now: "2026-07-29T05:00:01.000Z",
    slaSeconds: 90,
  });
  assert.equal(next.state, "CONTACT_CAPTURED");
  assert.equal(next.contactStatus, "captured");
  assert.equal(next.phone, "0965499803");
  assert.equal(next.responseDeadlineAt, null);
});

test("creates a 90 second response deadline for a new customer turn", () => {
  const event = { eventType: "customer_message", occurredAt: "2026-07-29T05:00:00.000Z" };
  const next = reduceConversationState(null, event, detectContact("Cho mình xem mẫu"), {
    now: "2026-07-29T05:00:01.000Z",
    slaSeconds: 90,
  });
  assert.equal(next.state, "RECEIVED");
  assert.equal(next.responseDeadlineAt, "2026-07-29T05:01:31.000Z");
});
