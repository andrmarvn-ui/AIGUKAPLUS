import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

test("AI proposal is structurally validated before mandatory commerce enforcement", () => {
  const decision = validateDecision({
    action: "reply_with_slides",
    final_reply: "Dạ em gửi mẫu theo các nhóm anh/chị đang quan tâm ạ.",
    selected_products: ["chau_voi_rua_bat", "sen_tam"],
    selected_catalog_keys: ["chau_voi_rua_bat", "sen_voi_cao_cap"],
    intents: ["samples"],
    needs_slides: true,
    contact_state: "unclear",
    should_request_contact: false,
    contact_benefit: "gửi đúng mẫu và báo giá",
    confidence: 0.92,
    decision_reason: "Read full conversation and preserved both needs.",
    follow_up_plan: [
      { topic: "chậu rửa bát", status: "send_media" },
      { topic: "sen tắm", status: "send_media" },
    ],
  });
  assert.deepEqual(decision.selected_products, ["chau_voi_rua_bat", "sen_tam"]);
});

test("final AI worker contains lease recovery and provider-aware scheduling before claim", () => {
  const entry = fs.readFileSync(new URL("../v10-ai-worker.js", import.meta.url), "utf8");
  const source = fs.readFileSync(new URL("../v10-ai-worker-final.js", import.meta.url), "utf8");
  assert.match(entry, /v10-ai-worker-final\.js/);
  assert.doesNotMatch(entry, /patch-v10-/);
  assert.match(source, /const VERSION = "v10_ai_prompt_compiler_v25_deliverable_unanswered_priority"/);
  assert.match(source, /PROVIDER_BYPASSED_FOR_DETERMINISTIC_COMMERCE/);
  assert.match(source, /compileProviderModelInput/);
  assert.match(source, /sticky_model_family_then_next_family_on_limit/);
  assert.match(source, /specialistContactHandoff/);
  assert.match(source, /enforceCommerceIntegrity/);
  assert.match(source, /mandatory_deterministic_enforcement/);
  assert.match(source, /recoverStaleProcessing/);
  assert.match(source, /recoverLatestAiErrors/);
  assert.match(source, /decisionRetryReady/);
  assert.match(source, /deliverable_current_unanswered_oldest_first/);
  assert.match(source, /META_DELIVERY_WINDOW_MS/);
  assert.doesNotMatch(source, /explicit_media_backlog_first/);
  const availability = source.indexOf("const availability = providerAvailability(providerRows, Date.now())");
  const wait = source.indexOf("scheduleWithoutClaim(row, availability.nextAvailableAt", availability);
  const process = source.indexOf("processOne(row, availability.available, snapshot)", availability);
  assert.ok(availability >= 0 && wait > availability && process > wait);
  assert.match(source, /operational_fallback_enabled: false/);
  assert.match(source, /GEMINI_MIN_INTERVAL_MS/);
  assert.match(source, /AIGUKA_V10_DECISION_INTEGRITY_V10/);
});

test("final AI worker checksum matches committed artifact", () => {
  const bytes = fs.readFileSync(new URL("../v10-ai-worker-final.js", import.meta.url));
  const expected = fs.readFileSync(new URL("../v10-ai-worker-final.sha256", import.meta.url), "utf8").trim();
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, expected);
});

test("outbound has safety gates but no contact conversation lock", () => {
  const source = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CONTACT_ALREADY_CAPTURED/);
  assert.match(source, /stripRepeatedContactRequest/);
  assert.match(source, /OPT_OUT/);
  assert.match(source, /HUMAN_TAKEOVER/);
});

test("queue janitor rehydrates legacy work and dedupes exact customer frontiers", () => {
  const source = fs.readFileSync(new URL("../v10-decision-queue-janitor.js", import.meta.url), "utf8");
  assert.match(source, /V10_REHYDRATE_LEGACY_PENDING/);
  assert.match(source, /legacy_rehydrating/);
  assert.match(source, /v10_ai_hard_commerce_integrity/);
  assert.match(source, /v10_queue_hygiene_v4_hard_commerce_aware/);
  assert.match(source, /created_at: now/);
  assert.match(source, /duplicate_customer_cluster/);
  assert.match(source, /conversation_merge_authority: "core_ingest_debounce"/);
  assert.match(source, /business_decision_authority: "none"/);
});

test("Direct Core settles orphaned jobs when their decision is already terminal", () => {
  const source = fs.readFileSync(new URL("../v10-direct-core-worker.js", import.meta.url), "utf8");
  assert.match(source, /v10_direct_hard_commerce_v5_terminal_job_settlement/);
  assert.match(source, /settleTerminalDecisionJobs/);
  assert.match(source, /live_delivered,live_suppressed/);
  assert.match(source, /terminal_decision_already_final/);
});


