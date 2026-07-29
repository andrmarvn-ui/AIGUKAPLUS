import test from "node:test";
import assert from "node:assert/strict";
import { resolveMessageActor, normalizeV8RawMessage } from "../v9/core/actor-resolver.js";
import { buildConversationTurn, extractSalesSignals } from "../v9/core/turn-builder.js";
import { detectContact } from "../v9/core/contact-detector.js";
import { reduceConversationState } from "../v9/core/state-machine.js";

test("classifies AIGUKA outbound as bot", () => {
  const actor = resolveMessageActor({
    direction: "outbound",
    actor_type: "bot",
    actor_name: "AIGUKA",
    source_system: "aiguka_v8",
    is_automatic: true,
    source_detail: { classification: "aiguka_sent_outbound" },
  });
  assert.equal(actor.actorType, "bot");
  assert.equal(actor.provider, "aiguka");
  assert.equal(actor.humanVerified, false);
});

test("classifies AIcake as automation and never human", () => {
  const actor = resolveMessageActor({
    direction: "outbound",
    actor_type: "page_or_system",
    actor_name: "AIcake",
    source_system: "aicake_meta_ads",
    is_automatic: true,
    source_detail: {},
  });
  assert.equal(actor.actorType, "automation");
  assert.equal(actor.provider, "aicake");
  assert.equal(actor.humanVerified, false);
});

test("requires explicit verified human evidence", () => {
  const unverified = resolveMessageActor({
    direction: "outbound",
    actor_type: "human_admin",
    is_automatic: false,
    source_detail: {},
  });
  assert.equal(unverified.actorType, "page_unknown");

  const verified = resolveMessageActor({
    direction: "outbound",
    actor_type: "human_admin",
    is_automatic: false,
    source_system: "meta_human_admin_history",
    source_detail: { human_verified: true, human_evidence: "two_non_template_page_history_messages" },
  });
  assert.equal(verified.actorType, "admin");
  assert.equal(verified.humanVerified, true);
});

test("normalizes raw outbound with customer PSID", () => {
  const event = normalizeV8RawMessage({
    id: "11111111-1111-4111-8111-111111111111",
    page_id: "page-1",
    sender_id: "customer-1",
    message_id: "m-out",
    direction: "outbound",
    actor_type: "page_automation",
    source_system: "meta_page_automation",
    is_automatic: true,
    sent_at: "2026-07-29T05:00:01.000Z",
    created_at: "2026-07-29T05:00:02.000Z",
    source_detail: { classification: "automation_template" },
  });
  assert.equal(event.customerId, "customer-1");
  assert.equal(event.senderId, "page-1");
  assert.equal(event.recipientId, "customer-1");
  assert.equal(event.eventType, "automation_message");
});

test("debounces multiple customer messages into one turn", () => {
  const turn = buildConversationTurn([
    { source_event_id: "1", event_type: "customer_message", message_text: "Cho xin địa chỉ", occurred_at: "2026-07-29T05:00:00Z" },
    { source_event_id: "2", event_type: "customer_message", message_text: "và mẫu phòng tắm", occurred_at: "2026-07-29T05:00:08Z" },
  ]);
  assert.equal(turn.valid, true);
  assert.equal(turn.customerMessages.length, 2);
  assert.equal(turn.combinedText, "Cho xin địa chỉ\nvà mẫu phòng tắm");
  assert.deepEqual(turn.salesSignals.intents.sort(), ["address", "samples"]);
  assert.equal(turn.shouldRequestContact, true);
});

test("suppresses V9 when AIcake already replied", () => {
  const turn = buildConversationTurn([
    { source_event_id: "1", event_type: "customer_message", message_text: "Cho xin giá", occurred_at: "2026-07-29T05:00:00Z" },
    { source_event_id: "2", event_type: "automation_message", message_text: "AIcake reply", occurred_at: "2026-07-29T05:00:10Z", actor_evidence: { provider: "aicake" } },
  ], { coexistenceMode: "AICAKE_ACTIVE" });
  assert.equal(turn.action, "external_bot_replied");
  assert.equal(turn.shouldRequestContact, false);
});

test("verified human response wins over automation", () => {
  const turn = buildConversationTurn([
    { source_event_id: "1", event_type: "customer_message", message_text: "Cho xin giá", occurred_at: "2026-07-29T05:00:00Z" },
    { source_event_id: "2", event_type: "automation_message", occurred_at: "2026-07-29T05:00:05Z", actor_evidence: { provider: "aicake" } },
    { source_event_id: "3", event_type: "human_message", occurred_at: "2026-07-29T05:00:08Z", actor_evidence: { human_verified: true } },
  ]);
  assert.equal(turn.action, "human_takeover_active");
});

test("contact capture has highest priority", () => {
  const turn = buildConversationTurn([
    { source_event_id: "1", event_type: "customer_message", message_text: "Zalo 0965 499 803", occurred_at: "2026-07-29T05:00:00Z" },
    { source_event_id: "2", event_type: "automation_message", occurred_at: "2026-07-29T05:00:05Z", actor_evidence: { provider: "aicake" } },
  ]);
  assert.equal(turn.action, "contact_captured");
  assert.equal(turn.contact.primaryPhone, "0965499803");
});

test("sales signals preserve multi-product intent", () => {
  const signals = extractSalesSignals("Cho xem hết mẫu bồn cầu, bếp từ và quạt trần, báo giá giúp tôi");
  assert.equal(signals.multiProduct, true);
  assert.ok(signals.products.includes("bon_cau"));
  assert.ok(signals.products.includes("bep_tu_hut_mui"));
  assert.ok(signals.products.includes("quat_tran"));
  assert.ok(signals.intents.includes("price"));
  assert.ok(signals.intents.includes("all_products"));
});

test("human takeover state expires instead of blocking forever", () => {
  const event = { eventType: "customer_message", occurredAt: "2026-07-29T05:20:00Z" };
  const expired = reduceConversationState({
    state: "ANSWERED_BY_HUMAN",
    version: 2,
    humanTakeover: true,
    humanTakeoverUntil: "2026-07-29T05:10:00Z",
  }, event, detectContact("xin giá"), { now: "2026-07-29T05:20:01Z" });
  assert.equal(expired.state, "RECEIVED");
  assert.equal(expired.humanTakeover, false);
});
