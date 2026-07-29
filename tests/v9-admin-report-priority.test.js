import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { aggregatePerformance, parseReportRange, pageMode, runtimeMode } from "../v9/core/admin-report-utils.js";

const ui = fs.readFileSync(new URL("../v9-admin-ui.js", import.meta.url), "utf8");
const patch = fs.readFileSync(new URL("../patch-server.js", import.meta.url), "utf8");

test("report range defaults to seven days and rejects oversized scans", () => {
  const range = parseReportRange({}, new Date("2026-07-29T12:00:00Z"));
  assert.deepEqual(range, { from: "2026-07-23", to: "2026-07-29", days: 7 });
  assert.throws(
    () => parseReportRange({ from: "2025-01-01", to: "2026-07-29" }, new Date("2026-07-29T12:00:00Z")),
    /REPORT_RANGE_INVALID/,
  );
});

test("performance aggregation calculates totals and unit costs", () => {
  const result = aggregatePerformance([
    { spend: 300000, conversations: 10, contacts: 4, customers: 8, deliveries: 3 },
    { spend: 200000, conversations: 5, contacts: 1, customers: 4, deliveries: 2 },
  ]);
  assert.equal(result.spend, 500000);
  assert.equal(result.conversations, 15);
  assert.equal(result.contacts, 5);
  assert.equal(result.contact_rate, 33.33);
  assert.equal(result.cost_per_conversation, 33333.33);
  assert.equal(result.cost_per_contact, 100000);
});

test("migration safety prevents ACTIVE and SUPPORT at runtime", () => {
  assert.equal(runtimeMode("shadow"), "SHADOW");
  assert.equal(runtimeMode("canary"), "CANARY");
  assert.throws(() => runtimeMode("support"), /RUNTIME_MODE_NOT_ALLOWED/);
  assert.throws(() => runtimeMode("active"), /RUNTIME_MODE_NOT_ALLOWED/);
});

test("page mode keeps support but prevents premature ACTIVE", () => {
  assert.equal(pageMode("support"), "SUPPORT");
  assert.equal(pageMode("canary"), "CANARY");
  assert.throws(() => pageMode("active"), /PAGE_MODE_NOT_ALLOWED/);
});

test("V9 UI is static, lazy-loaded and never calls V8 reporting RPCs", () => {
  assert.match(ui, /installV9AdminUi/);
  assert.match(ui, /\/api\/v9\/admin\/overview/);
  assert.match(ui, /\/api\/v9\/report\/summary/);
  assert.match(ui, /\/api\/v9\/report\/daily/);
  assert.match(ui, /\/api\/v9\/report\/leads/);
  assert.match(ui, /\/api\/v9\/report\/ads/);
  assert.doesNotMatch(ui, /v8_report_v21|v8_report_daily_test|v8_report_ads_test|v8_report_leads_test/);
});

test("Railway installs V9 admin before legacy routes and preserves V8 fallback", () => {
  assert.match(patch, /installV9AdminReportApiV2\(app\);\ninstallV9AdminUi\(app\);\ninstallReportRoutes/);
  assert.match(patch, /V8 dashboard retained as fallback/);
  assert.match(patch, /\/api\/v9\/admin\/overview/);
});
