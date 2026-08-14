import test from "node:test";
import assert from "node:assert/strict";
import { buildDecisionInstructions, validateDecision } from "../v10/core/decision-contract.js";

function decision(overrides = {}) {
  return {
    action: "reply_text",
    final_reply: "Dạ mẫu này có nhiều phiên bản và mức giá theo cấu hình ạ.",
    selected_products: ["bon_cau"],
    selected_catalog_keys: [],
    intents: ["price"],
    needs_slides: false,
    contact_state: "missing",
    should_request_contact: false,
    contact_benefit: "tư vấn cho tiện, gửi đúng mẫu và báo giá chính xác",
    confidence: 0.9,
    decision_reason: "Khách hỏi giá sản phẩm.",
    follow_up_plan: [{ topic: "bồn cầu", status: "answer_now" }],
    ...overrides,
  };
}

test("constitution requires answering before asking for contact", () => {
  const prompt = buildDecisionInstructions();
  assert.match(prompt, /trả lời trực tiếp trước/i);
  assert.match(prompt, /không xin số dồn dập/i);
  assert.match(prompt, /dưới 2 tin nhắn/i);
  assert.match(prompt, /câu xin SĐT\/Zalo luôn là câu cuối/i);
});

test("recent contact request is not repeated on the next customer turn", () => {
  const result = validateDecision(decision({
    contact_state: "missing_recently_requested",
    should_request_contact: true,
    final_reply: "Dạ mẫu này có loại thường và loại thông minh ạ. Anh/chị cho em xin SĐT hoặc Zalo để bên em báo giá nhé.",
  }));
  assert.equal(result.should_request_contact, false);
  assert.equal(result.final_reply, "Dạ mẫu này có loại thường và loại thông minh ạ.");
  assert.doesNotMatch(result.final_reply, /xin SĐT|xin.*Zalo/i);
});

test("allowed request is appended after a useful answer", () => {
  const result = validateDecision(decision());
  assert.equal(result.should_request_contact, true);
  assert.match(result.final_reply, /^Dạ mẫu này có nhiều phiên bản/);
  assert.match(result.final_reply, /SĐT hoặc Zalo/);
  assert.ok(result.final_reply.indexOf("Dạ mẫu") < result.final_reply.indexOf("SĐT hoặc Zalo"));
  assert.match(result.final_reply, /chuyên viên lọc đúng mẫu, gửi hình, tư vấn và báo giá cho tiện/i);
  assert.doesNotMatch(result.final_reply, /tư vấn cho tiện, gửi đúng mẫu và báo giá chính xác/i);
});

test("provider contact request is moved behind the answer", () => {
  const result = validateDecision(decision({
    final_reply: "Anh/chị cho em xin SĐT hoặc Zalo để em báo giá nhé. Dạ mẫu này có hai kích thước phổ biến ạ.",
    should_request_contact: true,
  }));
  assert.match(result.final_reply, /^Dạ mẫu này có hai kích thước/);
  assert.match(result.final_reply, /SĐT hoặc Zalo.*$/);
});

test("contact-only sales reply is rejected", () => {
  assert.throws(() => validateDecision(decision({
    final_reply: "Anh/chị cho em xin SĐT hoặc Zalo để bên em tư vấn nhé.",
    should_request_contact: true,
  })), /V10_CONTACT_ONLY_REPLY_INVALID/);
});

test("contact-only request is removed when contact is already known", () => {
  const result = validateDecision(decision({
    contact_state: "known",
    should_request_contact: true,
    final_reply: "Anh/chị cho em xin SĐT hoặc Zalo để bên em tư vấn nhé.",
  }));
  assert.equal(result.should_request_contact, false);
  assert.doesNotMatch(result.final_reply, /SĐT|Zalo/i);
  assert.match(result.final_reply, /tiếp tục hỗ trợ/i);
});
