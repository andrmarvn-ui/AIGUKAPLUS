import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildSupportOperationalFallback,
  supportFallbackCustomerAt,
} from "../v10/core/support-operational-fallback.js";

function snapshot(messages, options = {}) {
  return {
    architecture: "v10_ai_sovereign_advisory",
    customer: options.customer || {},
    state: options.state || {},
    conversation: {
      messages: messages.map((message, index) => ({
        id: String(index + 1),
        role: "customer",
        occurred_at: `2026-08-11T00:0${index}:00Z`,
        semantic_status: "active",
        semantic_relation: "CONTINUE",
        ...message,
      })),
      advisors: {
        product_candidates: options.products || [],
        intent_candidates: options.intents || [],
      },
    },
  };
}

test("overdue explicit multi-product requests become provider-independent media decisions", () => {
  const input = snapshot([
    { text: "Tư vấn nhà tắm/nhà bếp và gửi mẫu cho tôi" },
  ], {
    products: [
      { key: "combo_phong_tam", label: "combo phòng tắm" },
      { key: "phong_bep", label: "thiết bị nhà bếp" },
    ],
  });
  const plan = buildSupportOperationalFallback(input, new Set([
    "combo_phong_tam",
    "bep_tu_hut_mui",
    "chau_voi_rua_bat",
  ]));
  assert.equal(plan.kind, "media");
  assert.equal(plan.action, "reply_with_slides");
  assert.equal(plan.needs_slides, true);
  assert.deepEqual(plan.selected_catalog_keys, ["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat"]);
});

test("an unanswered address question gets only the verified showroom address", () => {
  const plan = buildSupportOperationalFallback(snapshot([
    { text: "Cho em xin địa chỉ cửa hàng ạ" },
  ]), new Set());
  assert.equal(plan.kind, "text");
  assert.equal(plan.action, "reply_text");
  assert.match(plan.final_reply, /254 Phố Keo/);
  assert.match(plan.final_reply, /0973693677/);
  assert.equal(plan.should_request_contact, false);
});

test("captured contact is acknowledged without requesting the number again", () => {
  const input = snapshot([{ text: "0987553024" }], {
    state: { phone: "0987553024", contact_status: "captured" },
  });
  const plan = buildSupportOperationalFallback(input, new Set());
  assert.equal(plan.kind, "text");
  assert.equal(plan.reason, "contact_capture_acknowledgement_fallback");
  assert.equal(plan.should_request_contact, false);
});

test("trivial acknowledgements without unresolved media do not trigger bot chatter", () => {
  const plan = buildSupportOperationalFallback(snapshot([{ text: "ok" }]), new Set());
  assert.equal(plan.kind, "suppress");
  assert.equal(plan.reason, "trivial_acknowledgement_without_media_obligation");
});

test("unknown price or specification questions use a safe handoff and never invent facts", () => {
  const input = snapshot([{ text: "Quạt này cánh dài bao nhiêu?" }], {
    products: [{ key: "quat_10_canh", label: "quạt trần 10 cánh" }],
  });
  const plan = buildSupportOperationalFallback(input, new Set(["quat_10_canh_gold"]));
  assert.equal(plan.kind, "text");
  assert.match(plan.final_reply, /kiểm tra đúng mẫu, giá và thông số/);
  assert.doesNotMatch(plan.final_reply, /\b\d+(?:[,.]\d+)?\s*(?:cm|m|triệu)\b/i);
});

test("customer frontier time uses the newest customer event", () => {
  const input = snapshot([
    { text: "một" },
    { text: "hai", occurred_at: "2026-08-11T00:10:00Z" },
  ], { state: { last_customer_event_at: "2026-08-11T00:09:00Z" } });
  assert.equal(new Date(supportFallbackCustomerAt(input)).toISOString(), "2026-08-11T00:10:00.000Z");
});

test("support failover worker is conditional, audited and has no direct Meta transport", () => {
  const worker = fs.readFileSync(new URL("../v10-support-operational-fallback-worker.js", import.meta.url), "utf8");
  assert.match(worker, /support_operational_fallback_enabled/);
  assert.match(worker, /status=in\.\(shadow_context_ready,shadow_ai_error\)/);
  assert.match(worker, /status=eq\.live_suppressed&output->>live_suppression_reason=eq\.SUPPORT_MEDIA_ONLY/);
  assert.match(worker, /live_suppression_reason !== "SUPPORT_MEDIA_ONLY"/);
  assert.match(worker, /operational_support_fallback === true/);
  assert.match(worker, /&status=eq\.\$\{encodeURIComponent\(row\.status\)\}/);
  assert.match(worker, /provider_independent: true/);
  assert.match(worker, /support_fallback_recovery_clone/);
  assert.match(worker, /on_conflict=source_event_id/);
  assert.doesNotMatch(worker, /graph\.facebook\.com|me\/messages|messaging_type/);
});
