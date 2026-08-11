import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MEDIA_DEDUPE_WINDOW_MS,
  mediaClaimDisposition,
  mediaRequestedAfterDelivery,
  mediaScopeIdempotencyKey,
  mediaScopeMatchesAssetRefs,
} from "../v10/core/media-dedupe.js";

const fanGroup = {
  bundle_key: "media:quat_tran",
  group_key: "quat_tran",
  catalog_keys: ["quat_10_canh"],
  assets: [
    { asset_id: "fan-gold-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_gold" },
    { asset_id: "fan-wood-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_wood" },
  ],
};

test("Nguyễn Quốc Lý contact-only follow-up matches the already delivered fan scope", () => {
  const priorBundleAssets = [
    { asset_id: "fan-gold-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_gold" },
    { asset_id: "fan-wood-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_wood" },
  ];
  assert.equal(mediaScopeMatchesAssetRefs(fanGroup, priorBundleAssets), true);

  const nowMs = Date.parse("2026-08-08T22:51:19Z");
  const disposition = mediaClaimDisposition({
    decision_id: "c4df4330-6096-42e7-8390-dc7aaf48bfe1",
    status: "sent",
    updated_at: "2026-08-08T22:49:26Z",
  }, {
    decisionId: "95de57a9-70fa-422c-964d-71d969869805",
    nowMs,
  });
  assert.equal(disposition.allowed, false);
  assert.equal(disposition.reason, "DUPLICATE_MEDIA_SCOPE_24H");
});

test("a combined earlier delivery suppresses the same catalog without blocking a different catalog", () => {
  const combined = [
    { asset_id: "fan-1", catalog_key: "quat_10_canh" },
    { asset_id: "lamp-1", catalog_key: "den_trum" },
  ];
  assert.equal(mediaScopeMatchesAssetRefs(fanGroup, combined), true);
  assert.equal(mediaScopeMatchesAssetRefs({ ...fanGroup, catalog_keys: ["quat_8_canh"] }, combined), false);
});

test("the 24h claim is recoverable after expiry and same-decision retries remain allowed", () => {
  const existing = {
    decision_id: "decision-1",
    status: "sent",
    updated_at: "2026-08-08T00:00:00Z",
  };
  assert.equal(mediaClaimDisposition(existing, {
    decisionId: "decision-1",
    nowMs: Date.parse("2026-08-08T00:01:00Z"),
  }).reason, "SAME_DECISION_RETRY");

  const expired = mediaClaimDisposition(existing, {
    decisionId: "decision-2",
    nowMs: Date.parse("2026-08-08T00:00:00Z") + MEDIA_DEDUPE_WINDOW_MS + 1,
  });
  assert.equal(expired.allowed, true);
  assert.equal(expired.takeover, true);
});

test("explicit resend requests get a decision-scoped key while automatic sends share one scope key", () => {
  const base = { pageId: "104810069068200", senderId: "27657326283949828", group: fanGroup };
  const automaticA = mediaScopeIdempotencyKey({ ...base, decisionId: "decision-a" });
  const automaticB = mediaScopeIdempotencyKey({ ...base, decisionId: "decision-b" });
  const repeat = mediaScopeIdempotencyKey({ ...base, decisionId: "decision-b", repeatRequested: true });
  assert.equal(automaticA, automaticB);
  assert.notEqual(repeat, automaticA);
  assert.match(repeat, /decision-b$/);
});

test("a sample request after the previous delivery is a customer re-ask, not an automatic duplicate", () => {
  const messages = [
    { role: "customer", event_type: "customer_message", text: "Gửi mẫu anh chọn", occurred_at: "2026-08-11T08:41:46Z" },
    { role: "customer", event_type: "customer_message", text: "Gửi riêng từng cái để xem kích thước", occurred_at: "2026-08-11T08:49:36Z" },
  ];
  assert.equal(mediaRequestedAfterDelivery(messages, "2026-08-11T08:43:00Z", { decisionAction: "reply_with_slides" }), true);
});

test("a new product-consult postback after delivery explicitly reopens media", () => {
  const messages = [{
    role: "customer",
    event_type: "customer_postback",
    text: "Tư vấn nội thất nhà mới",
    occurred_at: "2026-08-11T10:12:44Z",
  }];
  assert.equal(mediaRequestedAfterDelivery(messages, "2026-08-11T09:00:00Z", { decisionAction: "reply_with_slides" }), true);
});

test("a price-only follow-up does not reopen already delivered media", () => {
  const messages = [{ role: "customer", event_type: "customer_message", text: "Xin giá", occurred_at: "2026-08-11T10:12:44Z" }];
  assert.equal(mediaRequestedAfterDelivery(messages, "2026-08-11T09:00:00Z", { decisionAction: "reply_with_slides" }), false);
});

test("committed outbound claims each grouped media scope before transport", () => {
  const worker = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  assert.match(worker, /resolution=ignore-duplicates,return=representation/);
  assert.match(worker, /DUPLICATE_MEDIA_SCOPE_24H/);
  assert.match(worker, /media_dedupe_fail_closed/);
  assert.match(worker, /sovereignOutboundRepeatRequested/);
  assert.match(worker, /mediaRequestedAfterDelivery/);
  assert.match(worker, /CUSTOMER_MEDIA_REASK_AFTER_DELIVERY/);
  assert.match(worker, /meta_messenger_carousel/);
  assert.match(worker, /mediaDedupe\.by_bundle_key/);
});

test("Railway starts the committed deduping worker without a runtime patch chain", () => {
  const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
  const worker = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  const aiWorker = fs.readFileSync(new URL("../v10-ai-worker-final.js", import.meta.url), "utf8");
  assert.match(worker, /v10_outbound_single_gateway_v15_customer_media_reask/);
  assert.match(worker, /DUPLICATE_MEDIA_SCOPE_24H/);
  assert.match(worker, /mediaDedupe\.by_bundle_key/);
  assert.match(worker, /SUPPORT_PRIMARY_REPLIED_BEFORE_FALLBACK/);
  assert.match(worker, /SUPPORT_FALLBACK_PANCAKE_CHECK_RETRY/);
  assert.match(worker, /supportTextFallbackEligible/);
  assert.match(worker, /support_operational_fallback_delivered/);
  assert.match(aiWorker, /AIGUKA_V10_MEDIA_OBLIGATION_INTEGRITY_V1/);
  assert.match(aiWorker, /AIGUKA_V10_ACTIVE_INTENT_FOCUS_V1/);
  assert.match(aiWorker, /explicit_media_backlog_first/);
  assert.doesNotMatch(start, /safeImport\("\.\/patch-v10-/);
});

test("all natural more-sample phrases bypass the 24h scope lock", () => {
  const sovereign = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  for (const phrase of ["xem them", "xem tiep", "xem nua", "gui tiep", "mau khac", "anh khac", "them mau", "can them mau", "mau nua", "con loai"]) {
    assert.match(sovereign, new RegExp(phrase));
  }
});
