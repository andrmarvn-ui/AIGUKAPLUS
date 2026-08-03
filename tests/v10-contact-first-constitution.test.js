import test from "node:test";
import assert from "node:assert/strict";
import { buildDecisionInstructions, decisionSchema, validateDecision } from "../v10/core/decision-contract.js";

function baseDecision(overrides = {}) {
  return {
    action: "reply_text",
    final_reply: "Dạ bên em có nhiều mẫu phù hợp ạ.",
    selected_products: ["bon_cau"],
    selected_catalog_keys: [],
    intents: ["price"],
    needs_slides: false,
    contact_state: "missing",
    should_request_contact: false,
    contact_benefit: "Gửi báo giá và ưu đãi đúng mẫu",
    confidence: 0.9,
    decision_reason: "Customer asks about a product and price.",
    follow_up_plan: [{ topic: "bồn cầu", status: "answer_now" }],
    ...overrides,
  };
}

test("V10 constitution makes contact capture the primary business goal", () => {
  const instructions = buildDecisionInstructions();
  assert.match(instructions, /nhiệm vụ số 1 là tạo lead có SĐT hoặc Zalo/i);
  assert.match(instructions, /không phải chatbot tư vấn sâu kéo dài/i);
  assert.match(instructions, /tối đa 2-3 câu ngắn/i);
  assert.match(instructions, /khi đúng nhịp mới xin SĐT\/Zalo/i);
  assert.match(instructions, /trả lời trực tiếp trước/i);
  const schema = decisionSchema();
  assert.equal(schema.properties.final_reply.maxLength, 650);
  assert.ok(schema.required.includes("contact_state"));
  assert.ok(schema.required.includes("contact_benefit"));
});

test("missing contact plus a sales need forces a concrete contact request", () => {
  const decision = validateDecision(baseDecision());
  assert.equal(decision.should_request_contact, true);
  assert.match(decision.final_reply, /SĐT hoặc Zalo/i);
  assert.match(decision.final_reply, /báo giá và ưu đãi đúng mẫu/i);
});

test("known contact is never requested again", () => {
  const decision = validateDecision(baseDecision({
    contact_state: "known",
    should_request_contact: true,
    final_reply: "Dạ em gửi thêm mẫu cho anh/chị. Anh/chị cho em xin SĐT hoặc Zalo nhé.",
  }));
  assert.equal(decision.should_request_contact, false);
});

test("Messenger-only refusal is respected", () => {
  const decision = validateDecision(baseDecision({
    contact_state: "refused_messenger_only",
    should_request_contact: true,
    final_reply: "Dạ em tiếp tục gửi thông tin tại Messenger cho anh/chị ạ.",
  }));
  assert.equal(decision.should_request_contact, false);
  assert.doesNotMatch(decision.final_reply, /xin SĐT|xin.*Zalo/i);
});

test("rambling provider replies are compacted before delivery", () => {
  const longReply = `Dạ ${"bên em có rất nhiều thông tin và nhiều lựa chọn khác nhau cần phân tích chi tiết ".repeat(20)}`;
  const decision = validateDecision(baseDecision({
    final_reply: longReply,
    contact_state: "known",
    selected_products: [],
    intents: [],
  }));
  assert.ok(decision.final_reply.length <= 650);
});
