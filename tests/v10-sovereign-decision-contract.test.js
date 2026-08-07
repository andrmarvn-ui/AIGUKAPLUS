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

test("validator does not auto-insert contact request or change business decision", () => {
  const input = base();
  const output = validateDecision(input);
  assert.equal(output.should_request_contact, false);
  assert.equal(output.final_reply, input.final_reply);
  assert.equal(output.action, "reply_text");
});

test("contact mismatch is rejected instead of silently repaired", () => {
  assert.throws(() => validateDecision(base({
    contact_state: "known",
    should_request_contact: true,
    final_reply: "Anh/chị cho em xin SĐT nhé.",
  })), /V10_DECISION_CONTACT_STATE_MISMATCH|V10_DECISION_CONTACT_REQUEST_NOT_ALLOWED/);
});

test("slide action mismatch is rejected instead of rewritten", () => {
  assert.throws(() => validateDecision(base({
    action: "reply_text",
    needs_slides: true,
    selected_catalog_keys: ["bon_cau"],
  })), /V10_DECISION_SLIDE_ACTION_MISMATCH/);
});
