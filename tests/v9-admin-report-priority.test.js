import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { aggregatePerformance, parseReportRange, pageMode, runtimeMode } from "../v9/core/admin-report-utils.js";
import { __private__ as authPrivate } from "../v9-admin-auth.js";
import { __private__ as uiV2Private } from "../v9-admin-ui-v2.js";

const ui = fs.readFileSync(new URL("../v9-admin-ui.js", import.meta.url), "utf8");
const patch = fs.readFileSync(new URL("../patch-server.js", import.meta.url), "utf8");
const auth = fs.readFileSync(new URL("../v9-admin-auth.js", import.meta.url), "utf8");
const benchmarkApi = fs.readFileSync(new URL("../v9-report-benchmark-api.js", import.meta.url), "utf8");

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

test("basic auth parser accepts valid credentials and rejects malformed values", () => {
  const header = `Basic ${Buffer.from("admin:secret-value").toString("base64")}`;
  assert.deepEqual(authPrivate.parseBasic(header), { username: "admin", password: "secret-value" });
  assert.equal(authPrivate.parseBasic("Bearer abc"), null);
  assert.equal(authPrivate.parseBasic("Basic !!!"), null);
  assert.equal(authPrivate.safeEqual("same", "same"), true);
  assert.equal(authPrivate.safeEqual("same", "other"), false);
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

test("UI v2 displays Page and ad account names returned by the live API", () => {
  const source = `<td class="mono">'+esc(r.page_id||'-')+'</td><td class="mono">'+esc(r.ad_account_id||'-')+'</td></body>`;
  const enhanced = uiV2Private.enhance(source);
  assert.match(enhanced, /r\.page_name\|\|r\.page_id/);
  assert.match(enhanced, /r\.ad_account_name\|\|r\.ad_account_id/);
});

test("UI v2 reports Reporting readiness independently from Core", () => {
  const script = uiV2Private.REPORTING_STATUS_SCRIPT.replace(/^<script[^>]*>|<\/script>$/g, "");
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /Báo cáo V9 sẵn sàng/);
  assert.match(script, /aiguka-v9-reporting-legacy-refresh/);
  assert.match(script, /Reporting host/);
  assert.match(script, /daily_rows/);
  assert.match(script, /r\.temporary_host/);
});

test("UI v2 exposes VAT 5 percent and the 12-conversation shadow benchmark", () => {
  const script = uiV2Private.VAT_BENCHMARK_SCRIPT.replace(/^<script[^>]*>|<\/script>$/g, "");
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /\/api\/v9\/report\/summary-vat/);
  assert.match(script, /Tổng chi tiêu có VAT/);
  assert.match(script, /Tỷ lệ ra SĐT\/Zalo/);
  assert.match(script, /\/api\/v9\/benchmark\/current/);
  assert.match(script, /Bắt đầu 14:16 · ban đầu 0/);
  assert.match(benchmarkApi, /vat_rate: 5/);
  assert.match(benchmarkApi, /v9_shadow_benchmark_conversations/);
});

test("V9 admin secret is required and middleware is installed first", () => {
  assert.match(auth, /AIGUKA_V9_ADMIN_SECRET/);
  assert.match(auth, /timingSafeEqual/);
  assert.match(auth, /V9_ADMIN_SECRET_NOT_CONFIGURED/);
  assert.match(auth, /www-authenticate/);
  assert.match(patch, /installV9AdminAuth\(app\);\ninstallV9AdminReportApiV2\(app\);\ninstallV9ReportBenchmarkApi\(app\);\ninstallV9AdminUiV2\(app\);\ninstallReportRoutes/);
});

test("Railway patches the visible V7.5 production dashboard without false disconnect status", () => {
  assert.match(patch, /aiguka-v8-report-api\?action=filters/);
  assert.match(patch, /false red disconnected badge/);
  assert.match(patch, /patchDashboardUi\(html\)/);
});
