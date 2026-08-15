import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
const release = fs.readFileSync(new URL("../v10-live-release.js", import.meta.url), "utf8");
const direct = fs.readFileSync(new URL("../v10-direct-core-worker.js", import.meta.url), "utf8");
const aiEntry = fs.readFileSync(new URL("../v10-ai-worker.js", import.meta.url), "utf8");
const ai = fs.readFileSync(new URL("../v10-ai-worker-final.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
const constitution = fs.readFileSync(new URL("../v10/core/constitution.js", import.meta.url), "utf8");
const gateway = fs.readFileSync(new URL("../v10/core/message-gateway.js", import.meta.url), "utf8");

test("live transport starts only after the isolated Core router and queue cleanup", () => {
  assert.match(start, /v9-core-fetch-router\.js/);
  assert.match(start, /await safeImport\("\.\/v10-decision-queue-janitor\.js", true\)/);
  assert.match(start, /startDetached\("\.\/v10-outbound-worker\.js"\)/);
  assert.match(start, /startDetached\("\.\/v10-support-operational-fallback-worker\.js"\)/);
  assert.ok(start.indexOf("v9-core-fetch-router.js") < start.indexOf("v10-decision-queue-janitor.js"));
  assert.ok(start.indexOf("v10-decision-queue-janitor.js") < start.indexOf("v10-outbound-worker.js"));
  assert.ok(start.indexOf("v10-support-operational-fallback-worker.js") < start.indexOf("v10-outbound-worker.js"));
});

test("Direct Core accepts ACTIVE but keeps unsupported modes fail-closed", () => {
  assert.match(direct, /\["SHADOW", "ACTIVE"\]\.includes\(mode\)/);
  assert.match(direct, /V10_MODE_NOT_ALLOWED/);
});

test("Railway verifies a checksummed final AI worker instead of patching source", () => {
  assert.match(release, /AIGUKA_V10_HARD_COMMERCE_COMMENT_PRIVATE_V24/);
  assert.match(release, /v10_constitution_v1_single_authority/);
  assert.match(release, /v10_claim_message_dispatch/);
  assert.match(release, /v10_outbound_single_gateway_v17_comment_private_reply/);
  assert.match(release, /v10_followup_single_gateway_v5/);
  assert.match(release, /v10_ai_commerce_integrity_v21/);
  assert.match(release, /createHash\("sha256"\)/);
  assert.match(release, /V10_FINAL_AI_WORKER_CHECKSUM_MISMATCH/);
  assert.doesNotMatch(start, /v9-live-release-patch\.js/);
  assert.doesNotMatch(release, /replaceOnce|replaceBetween|applyStage/);
  assert.match(aiEntry, /v10-ai-worker-final\.js/);
  assert.doesNotMatch(aiEntry, /patch-v10-/);
  assert.match(ai, /recoverStaleProcessing/);
  assert.match(ai, /providerAvailability/);
  assert.match(ai, /ai_decision_authority: "proposal_with_hard_commerce_guard"/);
  assert.match(ai, /hard_commerce_policy_authority: "mandatory_deterministic_enforcement"/);
  assert.match(ai, /operational_fallback_enabled: false/);

  const expected = fs.readFileSync(new URL("../v10-ai-worker-final.sha256", import.meta.url), "utf8").trim();
  const actual = crypto.createHash("sha256").update(fs.readFileSync(new URL("../v10-ai-worker-final.js", import.meta.url))).digest("hex");
  assert.equal(actual, expected);
});

test("live outbound requires AIGUKA primary and an explicit activation cutover", () => {
  assert.match(constitution, /AICAKE_DISABLED/);
  assert.match(constitution, /AIGUKA_PRIMARY/);
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
  assert.match(gateway, /messaging_type: "RESPONSE"/);
  assert.doesNotMatch(gateway, /messaging_type:\s*["'](?:MESSAGE_TAG|UPDATE|NON_PROMOTIONAL_SUBSCRIPTION)["']/i);
  assert.doesNotMatch(gateway, /tag:\s*["'](?:POST_PURCHASE_UPDATE|CONFIRMED_EVENT_UPDATE|ACCOUNT_UPDATE)["']/i);
  assert.doesNotMatch(gateway, /marketing_notifications|notification_messages_token/i);
  assert.doesNotMatch(worker, /v8_claim_outbound_batch|v8_authorize_outbound_send/);
});
