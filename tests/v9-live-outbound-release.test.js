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

test("live outbound requires AIGUKA primary and an explicit activation cutover", () => {
  assert.match(worker, /AICAKE_DISABLED/);
  assert.match(worker, /AIGUKA_PRIMARY/);
  assert.match(worker, /active_cutover_at/);
  assert.match(worker, /PRE_CUTOVER_DECISION/);
  assert.match(worker, /DECISION_TOO_OLD/);
});

test("final gate blocks human takeover, captured contact and prior Page replies", () => {
  assert.match(worker, /HUMAN_TAKEOVER/);
  assert.match(worker, /CONTACT_ALREADY_CAPTURED/);
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
