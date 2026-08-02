import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
const patch = fs.readFileSync(new URL("../v9-live-release-patch.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../v9-live-outbound-worker.js", import.meta.url), "utf8");

test("live transport starts only after the isolated Core router", () => {
  assert.match(start, /v9-core-fetch-router\.js/);
  assert.match(start, /startDetached\("\.\/v9-live-outbound-worker\.js"\)/);
  assert.ok(start.indexOf('v9-core-fetch-router.js') < start.indexOf('v9-live-outbound-worker.js'));
});

test("Direct Core accepts ACTIVE but keeps unsupported modes fail-closed", () => {
  assert.match(patch, /\["SHADOW", "ACTIVE"\]\.includes\(mode\)/);
  assert.match(patch, /V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE/);
});

test("Railway cannot report healthy while silently running stale V9 workers", () => {
  assert.match(patch, /AIGUKA_V9_LIVE_RELEASE_V7_MULTI_PRODUCT/);
  assert.match(patch, /refusing to start Railway with stale workers/);
  assert.match(patch, /process\.exit\(1\)/);
  assert.match(patch, /V9_RELEASE_STAGE_FAILED/);
  assert.match(patch, /RAILWAY_GIT_COMMIT_SHA/);
  assert.match(patch, /V9_SUPPORT_FAST_VISION/);
  assert.match(patch, /V9_SUPPORT_SAMPLE_AI/);
  assert.match(patch, /V9_SUPPORT_REFERRAL_CARRY/);
  assert.match(patch, /V9_OUTBOUND_MEDIA_AUTHORITY/);
  assert.match(patch, /V9_OUTBOUND_SUPPORT_LARGE_SLIDE/);
  assert.match(patch, /V9_MEDIA_LIMIT_30/);
  assert.match(patch, /V9_AI_ROOT_CONVERSATION_ARCH/);
  assert.match(patch, /V9_DIRECT_ROOT_CONVERSATION_ARCH/);
  assert.match(patch, /V9_AI_NO_DROP/);
  assert.match(patch, /V9_DIRECT_NO_DROP/);
  assert.match(patch, /V9_OUTBOUND_NO_DROP/);
  assert.match(patch, /V9_AI_MULTI_PRODUCT_PLAN/);
  assert.match(patch, /V9_DIRECT_MULTI_PRODUCT_PLAN/);
  assert.match(patch, /\$\{label\}_NOT_INSTALLED/);

  const largeSlide = patch.indexOf('["large-slide", "./v9-support-large-slide-release-patch.js"]');
  const root = patch.indexOf('["root-conversation", "./v9-root-conversation-architecture-release-patch.js"]');
  const noDrop = patch.indexOf('["no-drop", "./v9-no-drop-release-patch.js"]');
  const multi = patch.indexOf('["multi-product-plan", "./v9-semantic-product-lock-release-patch.js"]');
  const dashboard = patch.indexOf('applyStage("dashboard-best-effort"');
  assert.ok(largeSlide >= 0 && largeSlide < root, "root architecture must run after SUPPORT/media patches");
  assert.ok(root < noDrop, "no-drop must run after root architecture");
  assert.ok(noDrop < multi, "multi-product plan must be the final customer decision policy");
  assert.ok(multi < dashboard, "customer workers must be complete before dashboard hotfix");
});

test("live outbound requires AIGUKA primary and an explicit activation cutover", () => {
  assert.match(worker, /AICAKE_DISABLED/);
  assert.match(worker, /AIGUKA_PRIMARY/);
  assert.match(worker, /active_cutover_at/);
  assert.match(worker, /PRE_CUTOVER_DECISION/);
  assert.match(worker, /DECISION_TOO_OLD/);
});

test("base final gate blocks human takeover, verified Page replies and low confidence", () => {
  assert.match(worker, /HUMAN_TAKEOVER/);
  assert.match(worker, /PAGE_ALREADY_REPLIED/);
  assert.match(worker, /CONFIDENCE_TOO_LOW/);
});

test("delivery is idempotent and recorded in Core", () => {
  assert.match(worker, /v9_delivery_bundles\?on_conflict=idempotency_key/);
  assert.match(worker, /v9_delivery_attempts\?on_conflict=bundle_id,attempt_no/);
  assert.match(worker, /v9-decision:\$\{decision\.id\}/);
  assert.match(worker, /live_delivered/);
});

test("worker sends only Meta RESPONSE messages and has no broadcast path", () => {
  assert.match(worker, /messaging_type: "RESPONSE"/);
  assert.doesNotMatch(worker, /messaging_type:\s*["'](?:MESSAGE_TAG|UPDATE|NON_PROMOTIONAL_SUBSCRIPTION)["']/i);
  assert.doesNotMatch(worker, /tag:\s*["'](?:POST_PURCHASE_UPDATE|CONFIRMED_EVENT_UPDATE|ACCOUNT_UPDATE)["']/i);
  assert.doesNotMatch(worker, /marketing_notifications|notification_messages_token/i);
  assert.doesNotMatch(worker, /v8_claim_outbound_batch|v8_authorize_outbound_send/);
});
