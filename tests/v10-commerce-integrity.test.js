import assert from "node:assert/strict";
import test from "node:test";
import { validateDecision } from "../v10/core/decision-contract.js";
import {
  commerceDecisionViolations,
  commerceRequestContext,
  commerceRequiresDeterministicResolution,
  enforceCommerceIntegrity,
  vietnameseLanguageIssue,
} from "../v10/core/commerce-integrity.js";

const policyDocument = [
  "Quạt 5/6 cánh: 1.5-6 triệu.",
  "Quạt 8 cánh: 2-8 triệu.",
  "Quạt 10 cánh: 3-8 triệu.",
  "Combo phòng tắm: 3-30 triệu.",
  "Combo bếp: 5-20 triệu.",
  "Bồn cầu/bệt: 1.2-25 triệu.",
  "Showroom ÁNH DƯƠNG: 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội.",
].join("\n");

function modelInput(text, options = {}) {
  const latest = {
    id: "event-current",
    role: "customer",
    event_type: options.comment ? "customer_comment" : "customer_message",
    text,
    occurred_at: "2026-08-15T08:00:00Z",
    ...(options.comment ? {
      payload: {
        kind: "feed_change",
        change: { value: { item: "comment", verb: "add", comment_id: "comment-1", from: { id: "customer-1" }, message: text } },
      },
    } : {}),
  };
  return {
    conversation: { messages: [...(options.before || []), latest] },
    customer: options.customer || {},
    state: options.state || {},
    knowledge_advisors: {
      documents: [{ document_key: "sales_policy", content: policyDocument }],
      catalog: [],
      product_candidates: [],
      ad_mappings: [],
    },
  };
}

function proposal(overrides = {}) {
  return {
    action: "reply_text",
    final_reply: "Dạ em đã nhận nội dung ạ.",
    selected_products: [],
    selected_catalog_keys: [],
    intents: ["price"],
    needs_slides: false,
    contact_state: "unclear",
    should_request_contact: false,
    contact_benefit: "gửi đúng mẫu",
    confidence: 0.9,
    decision_reason: "provider proposal",
    follow_up_plan: [],
    ...overrides,
  };
}

test("general group price uses only the configured range from that product line", () => {
  const toiletInput = modelInput("Bồn cầu giá bao nhiêu?");
  const toilet = enforceCommerceIntegrity(proposal({ final_reply: "Giá khoảng 3 triệu" }), toiletInput);
  assert.match(toilet.final_reply, /1,2–25 triệu/);
  assert.doesNotMatch(toilet.final_reply, /1,5–6|3–8 triệu/);
  assert.equal(toilet.should_request_contact, false);
  assert.deepEqual(commerceDecisionViolations(toilet, toiletInput), []);

  const fanInput = modelInput("Quạt 10 cánh giá bao nhiêu?");
  const fan = enforceCommerceIntegrity(proposal({ final_reply: "Quạt giá 1,5–6 triệu" }), fanInput);
  assert.deepEqual(commerceRequestContext(fanInput).groups, ["quat_10_canh"]);
  assert.match(fan.final_reply, /3–8 triệu/);
  assert.doesNotMatch(fan.final_reply, /1,5–6 triệu/);
  assert.deepEqual(commerceDecisionViolations(fan, fanInput), []);
});

test("specific or ambiguous requests are converted to phone/Zalo handoff without details", () => {
  for (const [text, unsafe] of [
    ["Mẫu bồn cầu này kích thước bao nhiêu?", "Mẫu này dài 80 cm, giá 5 triệu."],
    ["Chậu 2 hố và 3 hố kích thước thế nào?", "Chậu 2 hố rộng 80 cm."],
    ["Hai mẫu này giá sao?", "Hai mẫu quạt này giá 3 triệu."],
  ]) {
    const input = modelInput(text);
    const repaired = enforceCommerceIntegrity(proposal({ final_reply: unsafe }), input);
    assert.equal(commerceRequestContext(input).specific, true);
    assert.equal(repaired.action, "reply_text");
    assert.equal(repaired.needs_slides, false);
    assert.deepEqual(repaired.selected_catalog_keys, []);
    assert.equal(repaired.should_request_contact, true);
    assert.match(repaired.final_reply, /SĐT hoặc Zalo/);
    assert.doesNotMatch(repaired.final_reply, /80\s*cm|3 triệu|5 triệu/i);
    if (text.startsWith("Hai")) assert.doesNotMatch(repaired.final_reply, /quạt/i);
    assert.deepEqual(commerceDecisionViolations(repaired, input), []);
  }
});

test("fabricated commercial policies and cross-product numbers are never delivered", () => {
  const input = modelInput("Bồn cầu này vận chuyển thế nào?");
  for (const unsafe of [
    "Bồn cầu được miễn phí vận chuyển 80km.",
    "Nếu không lấy quà sẽ được trừ 5%.",
    "Bồn cầu này kích thước 80 cm và còn hàng.",
    "Bồn cầu này kích thước 80 và bảo hành 5 năm.",
  ]) {
    const repaired = enforceCommerceIntegrity(proposal({ final_reply: unsafe, intents: ["delivery"] }), input);
    assert.doesNotMatch(repaired.final_reply, /80(?:\s*(?:km|cm))?|5(?:%|\s*năm)|miễn phí vận chuyển|còn hàng/i);
    assert.match(repaired.final_reply, /SĐT hoặc Zalo/);
    assert.deepEqual(commerceDecisionViolations(repaired, input), []);
  }
});

test("known Nemotron language corruptions are detected and replaced with Vietnamese", () => {
  for (const corrupted of ["katalog", "deSale", "tr různých", "trưng bình"]) {
    assert.ok(vietnameseLanguageIssue(corrupted), corrupted);
    const input = modelInput("Cho tôi xin địa chỉ showroom");
    const repaired = enforceCommerceIntegrity(proposal({ final_reply: corrupted, intents: ["address"] }), input);
    assert.equal(vietnameseLanguageIssue(repaired.final_reply), null);
    assert.match(repaired.final_reply, /254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội/);
  }
  assert.equal(vietnameseLanguageIssue("Dạ bên em hỗ trợ anh/chị ạ."), null);
});

test("address questions are rewritten from verified Knowledge instead of provider prose", () => {
  const input = modelInput("Cửa hàng nhà mình ở đâu vậy?");
  const repaired = enforceCommerceIntegrity(proposal({
    final_reply: "Showroom ở địa chỉ khác 80 km ạ.",
    intents: ["address"],
  }), input);
  assert.match(repaired.final_reply, /254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội/);
  assert.doesNotMatch(repaired.final_reply, /địa chỉ khác|80 km/i);
  assert.equal(repaired.commerce_integrity.repair_mode, "deterministic_verified_address");
});

test("provider contact_benefit cannot inject mixed-language text into the final reply", () => {
  const output = validateDecision(proposal({
    final_reply: "Dạ mẫu này cần kiểm tra đúng phiên bản ạ.",
    selected_products: ["bồn cầu"],
    contact_state: "missing",
    contact_benefit: "deSale katalog tr různých",
  }));
  assert.match(output.final_reply, /chuyên viên lọc đúng mẫu, gửi hình, tư vấn và báo giá/);
  assert.doesNotMatch(output.final_reply, /deSale|katalog|různých/i);
});

test("comment proposal stays text-only and is intended for private Messenger", () => {
  const input = modelInput("Mẫu bồn cầu này giá bao nhiêu?", { comment: true });
  const repaired = enforceCommerceIntegrity(proposal({
    action: "reply_with_slides",
    needs_slides: true,
    selected_catalog_keys: ["quat_tran"],
    final_reply: "Quạt này giá 3 triệu, em gửi mẫu nhé.",
  }), input);
  assert.equal(repaired.action, "reply_text");
  assert.equal(repaired.needs_slides, false);
  assert.deepEqual(repaired.selected_catalog_keys, []);
  assert.equal(repaired.commerce_integrity.comment_private_reply, true);
  assert.match(repaired.final_reply, /SĐT hoặc Zalo/);
});

test("phone posted in a comment receives a private acknowledgement without asking again", () => {
  const input = modelInput("SĐT của tôi 0912345678", { comment: true, state: { phone: "0912345678", contact_status: "captured" } });
  const repaired = enforceCommerceIntegrity(proposal({ final_reply: "Cảm ơn anh/chị." }), input);
  assert.equal(repaired.contact_state, "known");
  assert.equal(repaired.should_request_contact, false);
  assert.match(repaired.final_reply, /đã nhận SĐT và chuyển chuyên viên liên hệ/);
  assert.doesNotMatch(repaired.final_reply, /cho .* xin SĐT/i);
});

test("contact cooldown prevents repeated phone requests while preserving handoff", () => {
  const input = modelInput("Mẫu bồn cầu này kích thước bao nhiêu?", {
    before: [{
      id: "bot-1",
      role: "bot",
      event_type: "bot_message",
      text: "Anh/chị cho em xin SĐT hoặc Zalo để báo giá nhé.",
      occurred_at: "2026-08-15T07:59:00Z",
    }],
  });
  const repaired = enforceCommerceIntegrity(proposal({ final_reply: "Mẫu dài 80 cm." }), input);
  assert.equal(repaired.contact_state, "missing_recently_requested");
  assert.equal(repaired.should_request_contact, false);
  assert.doesNotMatch(repaired.final_reply, /SĐT hoặc Zalo/);
  assert.deepEqual(commerceDecisionViolations(repaired, input), []);
});

test("comments and fully defined commerce rules bypass providers", () => {
  assert.equal(commerceRequiresDeterministicResolution(modelInput("Ib", { comment: true })), true);
  assert.equal(commerceRequiresDeterministicResolution(modelInput("KS8600 bao nhiêu tiền một cái?")), true);
  assert.equal(commerceRequiresDeterministicResolution(modelInput("Cửa hàng ở đâu?")), true);
  assert.equal(commerceRequiresDeterministicResolution(modelInput("Bồn cầu giá bao nhiêu?")), true);
  assert.equal(commerceRequiresDeterministicResolution(modelInput("Chào shop")), false);
});
