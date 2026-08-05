import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { __private__ as metaPrivate } from "../meta-direct-reporting.js";
import { __private__ as inventoryPrivate } from "../meta-direct-inventory.js";
import { __private__ as dashboardPrivate } from "../dashboard-v10-stable.js";
import { enhanceV10DashboardHtml, __private__ as adminShellPrivate } from "../dashboard-v10-admin-shell.js";

const reportEntrypoint = fs.readFileSync("report-handler.js", "utf8");
const reportHandler = fs.readFileSync("report-handler-v10.js", "utf8");
const reportSources = fs.readFileSync("v10-report-sources.js", "utf8");
const start = fs.readFileSync("start.js", "utf8");

test("direct Meta normalizer keeps live spend and customer merge separate", () => {
  const rows = metaPrivate.aggregateAds([
    { ad_id: "a1", spend: 100, tax_amount: 5, spend_with_tax: 105, impressions: 10, reach: 9, clicks: 2, link_clicks: 1, meta_conversations: 1, meta_leads: 0 },
    { ad_id: "a1", spend: 200, tax_amount: 10, spend_with_tax: 210, impressions: 20, reach: 18, clicks: 3, link_clicks: 1, meta_conversations: 2, meta_leads: 1 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spend_with_tax, 315);
  const merged = metaPrivate.mergeCustomerMetrics(rows, [{ ad_id: "a1", conversations: 4, contacts: 2 }]);
  assert.equal(merged[0].conversations, 4);
  assert.equal(merged[0].contacts, 2);
  assert.equal(merged[0].cost_per_contact, 157.5);
});

test("direct inventory keeps mapped historical ads while live Meta status wins", () => {
  const rows = inventoryPrivate.mergeHistoricalMappings({
    ads: [
      { ad_id: "old", ad_name: "Old mapped ad", effective_status: "PAUSED" },
      { ad_id: "live", ad_name: "Mapped name", effective_status: "PAUSED" },
    ],
  }, [{ ad_id: "live", ad_name: "Meta live name", effective_status: "ACTIVE" }]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.ad_id === "live").effective_status, "ACTIVE");
  assert.equal(rows.find((row) => row.ad_id === "old").inventory_source, "static_mapping_history");
});

test("stable dashboard owns filters, pagination and connection state", () => {
  const html = dashboardPrivate.dashboardHtml();
  assert.match(html, /Hiệu quả quảng cáo · Meta trực tiếp/);
  assert.match(html, /openColumnMenu/);
  assert.match(html, /S\.columnFilters/);
  assert.match(html, /Áp dụng bộ lọc/);
  assert.match(html, /Trang '\+page\+' \/ '\+total/);
  assert.match(html, /Dữ liệu đã kết nối/);
  assert.match(html, /Supabase chỉ đối chiếu khách/);
});

test("V10 dashboard keeps all management modules directly reachable", () => {
  const html = enhanceV10DashboardHtml(dashboardPrivate.dashboardHtml());
  assert.match(html, /aiguka-admin-strip/);
  for (const item of adminShellPrivate.ADMIN_LINKS) {
    assert.match(html, new RegExp(`href=["']${item.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
  }
  assert.match(html, /Tổng quan quản trị/);
  assert.match(html, /Điều khiển BOT &amp; lịch|Điều khiển BOT & lịch/);
  assert.match(html, /Quản trị AI &amp; Prompt|Quản trị AI & Prompt/);
  assert.match(html, /AI Providers/);
  assert.match(html, /Mapping &amp; Test Slide|Mapping & Test Slide/);
});

test("report entrypoint has one V10 implementation with direct sources", () => {
  assert.match(reportEntrypoint, /report-handler-v10\.js/);
  assert.match(reportHandler, /createMetaDirectReporting/);
  assert.match(reportHandler, /createMetaDirectInventory/);
  assert.match(reportHandler, /createV10ReportSources/);
  assert.match(reportHandler, /meta_live_plus_core_customer_metrics/);
  assert.match(reportSources, /v10_report_customer_metrics/);
  assert.match(reportSources, /v10_report_filter_registry/);
  assert.match(reportHandler, /stored\("leads"/);
  assert.match(reportHandler, /snapshot_workers_required: false/);
});

test("final server is checksummed and matches the historical patch output", () => {
  assert.match(start, /safeImport\("\.\/v10-server-release\.js", true\)/);
  assert.doesNotMatch(start, /safeImport\("\.\/patch-server\.js"/);
  assert.doesNotMatch(start, /safeImport\("\.\/patch-direct-meta-dashboard\.js"/);
  assert.doesNotMatch(start, /safeImport\("\.\/server-fixed\.js"/);

  const finalBytes = fs.readFileSync("server-v10-final.js");
  const expected = fs.readFileSync("server-v10-final.sha256", "utf8").trim();
  const actual = crypto.createHash("sha256").update(finalBytes).digest("hex");
  assert.equal(actual, expected);

  const finalServer = finalBytes.toString("utf8");
  assert.match(finalServer, /installV10AdminDashboard/);
  assert.doesNotMatch(finalServer, /installStableReportDashboard/);
  assert.match(finalServer, /dashboard-v10-admin-shell\.js/);
  assert.match(finalServer, /127\.0\.0\.1:\$\{PORT\}\/functions\/v1\/aiguka-v8-report-api\?action=filters/);
  assert.match(finalServer, /2\.1\.1-v10-admin-navigation/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-final-server-"));
  for (const file of ["server-fixed.js", "patch-server.js", "patch-direct-meta-dashboard.js"]) {
    fs.copyFileSync(file, path.join(tmp, file));
  }
  let run = spawnSync(process.execPath, ["patch-server.js"], { cwd: tmp, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  run = spawnSync(process.execPath, ["patch-direct-meta-dashboard.js"], { cwd: tmp, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(fs.readFileSync(path.join(tmp, "server-fixed.js")), finalBytes);
});
