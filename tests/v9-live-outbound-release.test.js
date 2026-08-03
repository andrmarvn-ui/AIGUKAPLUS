import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
const release = fs.readFileSync(new URL("../v10-live-release.js", import.meta.url), "utf8");
const direct = fs.readFileSync(new URL("../v10-direct-core-worker.js", import.meta.url), "utf8");
const ai = fs.readFileSync(new URL("../v10-ai-worker.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");

test("live transport starts only after the isolated Core router and queue cleanup", () => {
  assert.match(start, /v9-core-fetch-router\.js/);
  assert.match(start, /await safeImport\("\.\/v10-decision-queue-janitor\.js", true\)/);
  assert.match(start, /startDetached\("\.\/v10-outbound-worker\.js"\)/);
  assert.ok(start.indexOf("v9-core-fetch-router.js") < start.indexOf("v10-decision-queue-janitor.js"));
  assert.ok(start.indexOf("v10-decision-queue-janitor.js") < start.indexOf("v10-outbound-worker.js"));
});

test("Direct Core accepts ACTIVE but keeps unsupported modes fail-closed", () => {
  assert.match(direct, /\["SHADOW", "ACTIVE"\]\.includes\(mode\)/);
  assert.match(direct, /V10_MODE_NOT_ALLOWED/);
});

test("Railway verifies clean V10 workers instead of generating patched workers", () => {
  assert.match(release, /AIGUKA_V10_AI_SOVEREIGN_ADVISORY_V1/);
  assert.match(release, /v10_queue_hygiene_v2/);
  assert.match(release, /V10_REHYDRATE_LEGACY_PENDING/);
  assert.match(release, /v10_direct_ai_sovereign_v1/);
  assert.match(release, /v10_ai_sovereign_lease_v1/);
  assert.match(release, /v10_outbound_safety_only_v1/);
  assert.match(release, /spawnSync\(process\.execPath, \["--check", file\]/);
  assert.doesNotMatch(start, /v9-live-release-patch\.js/);
  assert.doesNotMatch(release, /replaceOnce|replaceBetween|applyStage/);
  assert.match(ai, /recoverStaleProcessing/);
  assert.match(ai, /ai_decision_authority: "sole"/);
});

test("live outbound requires AIGUKA primary and an explicit activation cutover", () => {
  assert.match(worker, /AICAKE_DISABLED/);
  assert.match(worker, /AIGUKA_PRIMARY/);
  assert.match(worker, /active_cutover_at/);
  assert.match(worker, /PRE_CUTOVER_DECISION/);
  assert.match(worker, /DECISION_TOO_OLD/);
});

test("final gate blocks hard safety conditions and does not make business decisions", () => {
  assert.match(worker, /OPT_OUT/);
  assert.match(worker, /HUMAN_TAKEOVER/);
  assert.match(worker, /PAGE_ALREADY_REPLIED/);
  assert.match(worker, /CONFIDENCE_TOO_LOW/);
  assert.match(worker, /business_rules_authority: "none"/);
  assert.doesNotMatch(worker, /CONTACT_ALREADY_CAPTURED/);
});

test("delivery is idempotent and recorded in Core", () => {
  assert.match(worker, /v9_delivery_bundles\?on_conflict=idempotency_key/);
  assert.match(worker, /v9_delivery_attempts\?on_conflict=bundle_id,attempt_no/);
  assert.match(worker, /v10-decision:\$\{decision\.id\}/);
  assert.match(worker, /live_delivered/);
});

test("worker sends only Meta RESPONSE messages and has no broadcast path", () => {
  assert.match(worker, /messaging_type: "RESPONSE"/);
  assert.doesNotMatch(worker, /messaging_type:\s*["'](?:MESSAGE_TAG|UPDATE|NON_PROMOTIONAL_SUBSCRIPTION)["']/i);
  assert.doesNotMatch(worker, /tag:\s*["'](?:POST_PURCHASE_UPDATE|CONFIRMED_EVENT_UPDATE|ACCOUNT_UPDATE)["']/i);
  assert.doesNotMatch(worker, /marketing_notifications|notification_messages_token/i);
  assert.doesNotMatch(worker, /v8_claim_outbound_batch|v8_authorize_outbound_send/);
});