import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionInstructions, validateDecision } from "../v9/core/decision-contract.js";

function baseDecision(overrides = {}) {
  return {
    action: "reply_with_slides",
    final_reply: "Em gửi anh/chị vài mẫu tham khảo ạ.",
    should_request_contact: true,
    contact_benefit: "Gửi đúng mẫu và báo giá.",
    products: ["quat_10_canh_gold"],
    intents: ["samples"],
    needs_slides: true,
    confidence: 0.95,
    reason: "Khách cần mẫu quạt.",
    risk_flags: [],
    ...overrides,
  };
}

test("slide decisions require at least one final product catalog", () => {
  assert.throws(
    () => validateDecision(baseDecision({ products: [] })),
    /V9_MEDIA_PRODUCT_REQUIRED/,
  );
});

test("reply_with_slides requires needs_slides=true", () => {
  assert.throws(
    () => validateDecision(baseDecision({ needs_slides: false })),
    /V9_SLIDE_ACTION_MEDIA_FLAG_REQUIRED/,
  );
});

test("decision products are trimmed and deduplicated", () => {
  const decision = validateDecision(baseDecision({
    products: [" quat_10_canh_gold ", "quat_10_canh_gold"],
  }));
  assert.deepEqual(decision.products, ["quat_10_canh_gold"]);
});

test("AI instructions define Mapping as context and exact catalog keys as final output", () => {
  const instructions = buildDecisionInstructions();
  assert.match(instructions, /Mapping và Knowledge là dữ liệu tham khảo/);
  assert.match(instructions, /quyền quyết định cuối cùng thuộc về bạn/);
  assert.match(instructions, /products bắt buộc chỉ chứa catalog_key chính xác/);
  assert.match(instructions, /không đưa các catalog chỉ xuất hiện trong Knowledge tham khảo/);
});
