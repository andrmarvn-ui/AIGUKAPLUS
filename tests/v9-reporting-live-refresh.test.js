import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __private__ as refreshPrivate } from "../v9-reporting-legacy-refresh-worker.js";

const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../v9-reporting-legacy-refresh-worker.js", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../v9-admin-report-api-v2.js", import.meta.url), "utf8");

test("contact hashes are deterministic and never expose the original value", () => {
  const first = refreshPrivate.hashContact("phone", "0965499803");
  const second = refreshPrivate.hashContact("phone", "0965499803");
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.doesNotMatch(first, /0965499803/);
});

test("catalog keys are normalized and deduplicated", () => {
  assert.deepEqual(refreshPrivate.catalogKeys({ product_item_key: "fan", product_group: "fan", product_type: "ceiling" }), ["fan", "ceiling"]);
});

test("startup uses an explicit Reporting project first and a temporary host only as fallback", () => {
  assert.match(start, /temporaryReportingHost/);
  assert.match(start, /!String\(process\.env\.AIGUKA_V9_REPORTING_URL/);
  assert.match(start, /process\.env\.AIGUKA_V9_REPORTING_URL = process\.env\.SUPABASE_URL/);
  assert.match(start, /startDetached\("\.\/v9-reporting-legacy-refresh-worker\.js"\)/);
});

test("refresh worker only materializes reporting data and never performs outbound transport", () => {
  assert.match(worker, /fact_daily_ad_performance/);
  assert.match(worker, /dim_customers/);
  assert.match(worker, /fact_contacts/);
  assert.match(worker, /contact_hash/);
  assert.doesNotMatch(worker, /graph\.facebook\.com|sendMessage|META_ACCESS_TOKEN|contact_value|normalized_value/);
});

test("V9 report API remains isolated from raw V8 message and report RPC paths", () => {
  assert.match(api, /fact_daily_ad_performance/);
  assert.match(api, /dim_customers/);
  assert.doesNotMatch(api, /v8_report_v21|v8_report_daily_test|v8_report_ads_test|v8_report_leads_test|v8_messages_raw|v8_meta_events/);
});
