import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildConversationContext } from "../v10/core/conversation-assembler.js";

function event(id, role, text, occurredAt) {
  const actor = role === "customer" ? "customer" : role;
  return {
    source_event_id: id,
    actor_type: actor,
    event_type: role === "customer" ? "customer_message" : `${role}_message`,
    message_text: text,
    occurred_at: occurredAt,
  };
}

test("page reply before a new customer message at the same timestamp does not suppress the new turn", () => {
  const at = "2026-08-06T07:00:00.000Z";
  const context = buildConversationContext([
    event("customer-1", "customer", "Cho xem mẫu quạt", "2026-08-06T06:59:50.000Z"),
    event("page-1", "page", "Dạ em gửi mẫu ạ", at),
    event("customer-2", "customer", "Màu vàng nhé", at),
  ]);
  assert.equal(context.safety.verified_page_reply_after_latest_customer, false);
  assert.equal(context.requires_ai, true);
});

test("page reply after the latest customer message still suppresses duplicate delivery", () => {
  const at = "2026-08-06T07:00:00.000Z";
  const context = buildConversationContext([
    event("customer-1", "customer", "Màu vàng nhé", at),
    event("page-1", "page", "Dạ em gửi mẫu ạ", at),
  ]);
  assert.equal(context.safety.verified_page_reply_after_latest_customer, true);
  assert.equal(context.hard_stop_reason, "PAGE_ALREADY_REPLIED");
});

test("final V10 worker contains current-turn media and verified-address guards", () => {
  const source = fs.readFileSync("v10-ai-worker-final.js", "utf8");
  assert.match(source, /AIGUKA_V10_DECISION_INTEGRITY_V10/);
  assert.match(source, /currentCustomerClusterText/);
  assert.match(source, /enforceCurrentTurnMediaScope/);
  assert.match(source, /verifiedAddressSentence/);
  assert.doesNotMatch(source, /cosi\|ldo\|showoom\|ben em\|pho keo/);
  assert.match(source, /v10_ai_quality_guard_v13/);
});

test("outbound worker uses ordered reply evidence instead of timestamp-only suppression", () => {
  const source = fs.readFileSync("v10-outbound-worker.js", "utf8");
  assert.match(source, /AIGUKA_V10_OUTBOUND_REPLY_ORDER_V1/);
  assert.match(source, /pageReplyAfterLatestCustomerInOrder/);
  assert.match(source, /pageAt > customerAt \+ 1000/);
  assert.doesNotMatch(source, /conversation\?\.safety\?\.verified_page_reply_after_latest_customer\) return/);
});
