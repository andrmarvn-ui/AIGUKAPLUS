import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAdvisoryBundle, detectIntentCandidates, detectProductCandidates } from "../v10/core/advisory-engine.js";
import { buildConversationContext } from "../v10/core/conversation-assembler.js";
import { validateDecision } from "../v10/core/decision-contract.js";

function event(id, text, occurredAt, extra = {}) {
  return {
    source_event_id: id,
    actor_type: "customer",
    event_type: "customer_message",
    message_text: text,
    occurred_at: occurredAt,
    ...extra,
  };
}

test("latest message does not erase earlier multi-product needs", () => {
  const context = buildConversationContext([
    event("1", "Cần combo cho 2 phòng vệ sinh và 1 bếp, gửi hình ảnh và giá toàn bộ", "2026-08-03T01:00:00Z"),
    event("2", "Shop có ship về tận công trình không?", "2026-08-03T01:01:00Z"),
    event("3", "Ở Vũ Thư tỉnh Thái Bình cũ", "2026-08-03T01:02:00Z"),
  ]);
  const keys = context.advisors.product_candidates.map((item) => item.key);
  assert.ok(keys.includes("combo_phong_tam"));
  assert.ok(keys.includes("phong_bep"));
  assert.ok(context.advisors.intent_candidates.some((item) => item.key === "delivery"));
  assert.equal(context.policy.latest_message_is_not_authoritative, true);
});

test("rules expose advice without product lock authority", () => {
  const bundle = buildAdvisoryBundle({
    messages: [{ id: "1", role: "customer", text: "Mua chậu rửa bát và sen tắm cây", occurred_at: "2026-08-03T01:00:00Z" }],
  });
  assert.equal(bundle.advisory_only, true);
  assert.deepEqual(bundle.request_threads.map((item) => item.product_key), ["chau_voi_rua_bat", "sen_tam"]);
  assert.equal("productLock" in bundle, false);
  assert.equal("allowedProducts" in bundle, false);
  assert.equal("primaryProduct" in bundle, false);
});

test("typos and real customer phrasing become advice", () => {
  assert.ok(detectIntentCandidates("₫ia chỉ này ở đâu em ơi").some((item) => item.key === "address"));
  assert.ok(detectProductCandidates("Bệt vilacela loại thường").some((item) => item.key === "bon_cau"));
  assert.ok(detectIntentCandidates("Gửi luôn vào đây cho chị xem cũng được").some((item) => item.key === "samples"));
});

test("tile locations are not forced into bathroom and kitchen equipment", () => {
  const candidates = detectProductCandidates("Tôi ốp 4 WC và phòng bếp khoảng 100m2");
  const products = candidates.filter((item) => item.type === "product").map((item) => item.key);
  assert.deepEqual(products, ["gach_da_op_lat"]);
  assert.ok(candidates.some((item) => item.type === "location_reference" && item.key === "combo_phong_tam"));
  assert.ok(candidates.some((item) => item.type === "location_reference" && item.key === "phong_bep"));
});

test("contact is advisory and does not close conversation", () => {
  const context = buildConversationContext([
    event("1", "Zalo 0912345678", "2026-08-03T01:00:00Z"),
    event("2", "Cho anh xem mẫu chậu một hố", "2026-08-03T01:01:00Z"),
  ], { state: { phone: "0912345678", contact_status: "captured" }, customer: { phone: "0912345678" } });
  assert.equal(context.requires_ai, true);
  assert.equal(context.advisors.contact_advice.do_not_ask_again, true);
  assert.ok(context.advisors.product_candidates.some((item) => item.key === "chau_voi_rua_bat"));
});

test("opt-out is a hard safety stop before AI", () => {
  const context = buildConversationContext([event("1", "Unsubscribe", "2026-08-03T01:00:00Z")]);
  assert.equal(context.requires_ai, false);
  assert.equal(context.hard_stop_reason, "OPT_OUT");
});

test("AI decision is structurally validated but not rewritten by advisors", () => {
  const decision = validateDecision({
    action: "reply_with_slides",
    final_reply: "Dạ em gửi mẫu theo các nhóm anh/chị đang quan tâm ạ.",
    selected_products: ["chau_voi_rua_bat", "sen_tam"],
    selected_catalog_keys: ["chau_voi_rua_bat", "sen_voi_cao_cap"],
    intents: ["samples"],
    needs_slides: true,
    should_request_contact: false,
    confidence: 0.92,
    decision_reason: "Read full conversation and preserved both needs.",
    follow_up_plan: [
      { topic: "chậu rửa bát", status: "send_media" },
      { topic: "sen tắm", status: "send_media" },
    ],
  });
  assert.deepEqual(decision.selected_products, ["chau_voi_rua_bat", "sen_tam"]);
});

test("worker source contains processing lease recovery and one-at-a-time Gemini flow", () => {
  const source = fs.readFileSync(new URL("../v10-ai-worker.js", import.meta.url), "utf8");
  assert.match(source, /recoverStaleProcessing/);
  assert.match(source, /status=eq\.shadow_ai_processing/);
  assert.match(source, /const result = await processOne\(ready\[0\]/);
  assert.match(source, /GEMINI_MIN_INTERVAL_MS/);
});

test("outbound has safety gates but no contact conversation lock", () => {
  const source = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CONTACT_ALREADY_CAPTURED/);
  assert.match(source, /stripRepeatedContactRequest/);
  assert.match(source, /OPT_OUT/);
  assert.match(source, /HUMAN_TAKEOVER/);
});
