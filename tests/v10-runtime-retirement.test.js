import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const start = fs.readFileSync("start.js", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const migrationPath = "supabase/migrations/20260806193000_v10_direct_customer_report_metrics.sql";
const migration = fs.readFileSync(migrationPath, "utf8");

test("package and startup identify the V10 runtime", () => {
  assert.equal(packageJson.name, "aiguka-v10-runtime");
  assert.equal(packageJson.version, "10.0.0");
  assert.match(packageJson.description, /V10/);
  assert.match(start, /V8 decision, AI, profile and outbound workers are permanently retired/);
});

test("retired V7 Pancake runtime is removed rather than silently patched", () => {
  for (const path of [
    "v7-pancake-service.cjs",
    "patch-v7-pancake-classifier.js",
    "patch-v7-pancake-history.js",
    "patch-v7-pancake-tag-parser.js",
    "patch-v7-pancake-tag-final.js",
  ]) assert.equal(fs.existsSync(path), false, `${path} should be retired`);
  assert.doesNotMatch(start, /patch-v7-pancake/);
});

test("V8 customer workers cannot be revived by the historical environment flag", () => {
  for (const path of [
    "./webhook-inbox-worker.js",
    "./ai-dispatch-worker.js",
    "./outbound-worker.js",
    "./meta-profile-sync-worker.js",
  ]) assert.doesNotMatch(start, new RegExp(`startDetached\\(\"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\"\\)`));
  assert.match(start, /AIGUKA_V8_BACKGROUND_WORKERS is ignored/);
});

test("Core report metrics exclude Page actors and preserve first ad evidence", () => {
  assert.match(migration, /customer_id <> e\.page_id/);
  assert.match(migration, /distinct on \(page_id, customer_id\)/);
  assert.match(migration, /referral->>'ad_id'/);
  assert.match(migration, /count\(\*\) filter \(where has_contact\)/);
  assert.match(migration, /v10_core_live_customer_metrics/);
  assert.match(migration, /grant execute on function public\.v10_report_customer_metrics/);
});
