import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __private__ } from "../v10-customer-profile-worker.js";

const source = fs.readFileSync("v10-customer-profile-worker.js", "utf8");
const start = fs.readFileSync("start.js", "utf8");

test("profile worker derives useful customer names and gender", () => {
  assert.equal(__private__.displayName({ first_name: "Nguyễn", last_name: "An" }), "Nguyễn An");
  assert.equal(__private__.displayName({ name: "Trần Bình" }), "Trần Bình");
  assert.equal(__private__.normalizeGender("male"), "male");
  assert.equal(__private__.normalizeGender("female"), "female");
});

test("Meta profile name unavailability is an expected skip, not a transport failure", () => {
  assert.equal(__private__.isProfileUnavailable(new Error("META_PROFILE_NAME_UNAVAILABLE")), true);
  assert.equal(__private__.isProfileUnavailable(new Error("META_190:token expired")), false);
  assert.match(source, /profile_sync_status: "unavailable"/);
  assert.match(source, /UNAVAILABLE_RETRY_MS/);
  assert.match(source, /details\.unavailable \+= 1/);
  assert.match(source, /details\.failed \? "degraded" : "healthy"/);
  assert.match(source, /v10_customer_profile_v3/);
});

test("profile worker is Core-only and has no outbound Messenger path", () => {
  assert.match(source, /v9_customers/);
  assert.match(source, /display_name/);
  assert.match(source, /profile_sync_status/);
  assert.doesNotMatch(source, /me\/messages|messaging_type|recipient\s*:/);
  assert.doesNotMatch(source, /method:\s*["']POST["'][\s\S]{0,200}graph\.facebook\.com/);
});

test("profile worker starts with V10 Core workers and not the V8 rollback gate", () => {
  const workerIndex = start.indexOf('startDetached("./v10-customer-profile-worker.js")');
  const coreGateIndex = start.indexOf("if (v9CoreReady)");
  const v8GateIndex = start.indexOf("if (v8BackgroundEnabled)");
  assert.ok(workerIndex > coreGateIndex);
  assert.ok(workerIndex > v8GateIndex);
  assert.match(source, /profile_only: true/);
  assert.match(source, /outbound: false/);
});
