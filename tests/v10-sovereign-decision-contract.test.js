import test from "node:test";
import assert from "node:assert/strict";
import { validateDecision } from "../v10/core/decision-contract.js";

function base(overrides = {}) {
  return {
    action: "reply_text",
    final_reply: "Dạ, em đã ghi nhận nhu cầu của anh/chị ạ.",
    selected_products: ["Bồn cầu"],
    selected_catalog_keys: [],
    intents: ["product"],
    needs_slides: false,
    contact_state: "missing",
    should_request_contact: false,
    contact_benefit: "gửi đúng mẫu và báo giá chính xác",
    confidence: 0.9,
    decision_reason: "Trả lời nhu cầu hiện tại.",
    follow_up_plan: [{ topic: "bồn cầu", status: "answer_now" }],
    ...overrides,
  };
}

test("contact cadence is normalized without changing product or action", () => {
  const input = base();
  const output = validateDecision(input);
  assert.equal(output.should_request_contact, true);
  assert.match(output.final_reply, /^Dạ, em đã ghi nhận nhu cầu/);
  assert.match(output.final_reply, /SĐT hoặc Zalo.*$/);
  assert.equal(output.action, "reply_text");
  assert.deepEqual(output.selected_products, input.selected_products);
});

test("known contact is sanitized instead of requested again", () => {
  const output = validateDecision(base({
    contact_state: "known",
    should_request_contact: true,
    final_reply: "Dạ em đã ghi nhận mẫu bồn cầu. Anh/chị cho em xin SĐT nhé.",
  }));
  assert.equal(output.should_request_contact, false);
  assert.doesNotMatch(output.final_reply, /xin SĐT|xin.*Zalo/i);
});

test("slide action mismatch is rejected instead of rewritten", () => {
  assert.throws(() => validateDecision(base({
    action: "reply_text",
    needs_slides: true,
    selected_catalog_keys: ["bon_cau"],
  })), /V10_DECISION_SLIDE_ACTION_MISMATCH/);
});
