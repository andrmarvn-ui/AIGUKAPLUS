import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProviderModelInputSafe,
  compileProviderModelInput,
  providerModelInputBudgetChars,
} from "../v10/core/model-input-compiler.js";

function oversizedValidationInput() {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 3 === 0 ? "bot" : "customer",
    event_type: index === 59 ? "customer_comment" : "customer_message",
    text: `${index === 59 ? "Yêu cầu cuối cùng KS8600" : "Khách hỏi bồn cầu"} https://example.com/${index} 0901234567 `.repeat(8),
    occurred_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    payload: { raw_payload: { body: "x".repeat(2_000) } },
    referral: { source_url: "https://facebook.example/post" },
    attachments: [{ type: "image", source_url: "https://images.example/item.jpg" }],
  }));
  const documents = Array.from({ length: 8 }, (_, index) => ({
    document_key: `document-${index}`,
    title: `Tài liệu ${index}`,
    content: `Nội dung có phạm vi sản phẩm ${index}. `.repeat(500),
    relevance_score: 20 - index,
  }));
  const catalog = Array.from({ length: 20 }, (_, index) => ({
    catalog_key: `catalog-${index}`,
    display_name: `Catalog ${index}`,
    aliases: ["bí danh 1", "bí danh 2", "bí danh 3", "bí danh 4"],
    asset_count: 5,
    assets: [{ source_url: `https://storage.example/${index}.jpg` }],
  }));
  return {
    architecture: "v10_ai_hard_commerce_integrity",
    conversation: {
      messages,
      referral: { source_url: "https://facebook.example/root" },
      advisors: {
        product_candidates: [{ key: "bon_cau", label: "Bồn cầu", confidence: 0.95, evidence: [{ text: "x".repeat(2_000) }] }],
        intent_candidates: [{ key: "price" }],
        request_threads: [{ product_key: "bon_cau", mentions: [{ text: "x".repeat(1_000) }] }],
      },
      safety: {},
    },
    customer: { display_name: "Khách hàng", phone: "0901234567", zalo: "0901234567" },
    state: { phone: "0901234567", zalo: "0901234567", contact_status: "captured" },
    unresolved_needs: [{ topic: "báo giá", catalog_keys: ["catalog-1"], status: "pending_answer" }],
    product_threads: [{
      group_key: "bon_cau",
      label: "Bồn cầu",
      state: "pending_answer",
      catalog_keys: ["catalog-1"],
      source_topics: ["báo giá"],
    }],
    knowledge_advisors: {
      product_candidates: [{ key: "bon_cau", label: "Bồn cầu", confidence: 0.95, evidence: [{ text: "x".repeat(2_000) }] }],
      documents,
      catalog,
      slide_catalog: catalog,
      ad_mappings: [{
        ad_id: "ad-1",
        post_ids: ["post-1"],
        catalog_keys: ["catalog-1"],
        fallback_catalog_keys: ["catalog-2"],
        confidence: 0.9,
      }],
    },
  };
}

test("model input compiler removes raw payloads, referrals, URLs and duplicated advisor structures", () => {
  const compiled = compileProviderModelInput(oversizedValidationInput());
  const serialized = JSON.stringify(compiled.input);

  assert.ok(compiled.profile.source_chars > 100_000);
  assert.ok(compiled.profile.compiled_chars <= providerModelInputBudgetChars);
  assert.ok(compiled.profile.reduction_ratio > 0.9);
  assert.equal(assertProviderModelInputSafe(compiled.input), true);
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(serialized, /raw_payload|source_url|"payload"|"referral"|"attachments"|"assets"/u);
  assert.equal("knowledge_advisors" in compiled.input, false);
  assert.equal("unresolved_needs" in compiled.input, false);
  assert.equal("product_threads" in compiled.input, false);
  assert.equal("advisors" in compiled.input.conversation, false);
  assert.ok(compiled.input.conversation.messages.some((message) => message.text?.includes("Yêu cầu cuối cùng KS8600")));
  assert.equal(compiled.input.customer.contact_known, true);
  assert.equal("phone" in compiled.input.customer, false);
  assert.equal("zalo" in compiled.input.customer, false);
});

test("model input compiler merges product candidates, needs and threads into one request plan", () => {
  const compiled = compileProviderModelInput(oversizedValidationInput());
  assert.deepEqual(compiled.input.request_plan.intent_keys, ["price"]);
  assert.equal(compiled.input.request_plan.threads.length, 1);
  assert.equal(compiled.input.request_plan.threads[0].group_key, "bon_cau");
  assert.deepEqual(compiled.input.request_plan.threads[0].catalog_keys, ["catalog-1"]);
  assert.deepEqual(compiled.input.request_plan.threads[0].topics, ["báo giá"]);
  assert.deepEqual(compiled.input.request_plan.global_needs, []);
  assert.ok(compiled.input.grounding.catalog.every((node) => !("assets" in node)));
  assert.ok(compiled.input.grounding.mappings.every((mapping) => !("ad_id" in mapping) && !("post_ids" in mapping)));
});
