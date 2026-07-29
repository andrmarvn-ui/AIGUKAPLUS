import test from "node:test";
import assert from "node:assert/strict";
import { decisionSchema, validateDecision, buildDecisionInstructions } from "../v9/core/decision-contract.js";

const base = {
  action: "reply_text",
  final_reply: "Dạ anh/chị gửi em SĐT hoặc Zalo, em gửi đúng mẫu và báo giá ạ.",
  should_request_contact: true,
  contact_benefit: "Gửi đúng mẫu và báo giá",
  products: ["bon_cau"],
  intents: ["price"],
  needs_slides: false,
  confidence: 0.9,
  reason: "Khách hỏi giá và chưa có liên hệ",
  risk_flags: [],
};

test("decision schema is strict and requires core fields", () => {
  const schema = decisionSchema();
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("should_request_contact"));
  assert.ok(schema.required.includes("risk_flags"));
});

test("valid sales decision passes", () => {
  const result = validateDecision(base, { contactCaptured: false });
  assert.equal(result.action, "reply_text");
  assert.equal(result.should_request_contact, true);
});

test("Contact Lock forbids requesting contact again", () => {
  assert.throws(() => validateDecision(base, { contactCaptured: true }), /CONTACT_LOCK/);
});

test("cannot claim images were sent without slides", () => {
  assert.throws(() => validateDecision({ ...base, final_reply: "Dạ em đã gửi mẫu rồi ạ" }, { contactCaptured: false }), /MEDIA_TRUTH/);
});

test("contact captured action needs evidence", () => {
  assert.throws(() => validateDecision({ ...base, action: "contact_captured", final_reply: "", should_request_contact: false }, { contactCaptured: false }), /NOT_EVIDENCED/);
});

test("instructions prioritize current customer intent and verified actors", () => {
  const instructions = buildDecisionInstructions();
  assert.match(instructions, /AIcake/);
  assert.match(instructions, /lời khách hiện tại/i);
  assert.match(instructions, /SĐT\/Zalo/);
});
