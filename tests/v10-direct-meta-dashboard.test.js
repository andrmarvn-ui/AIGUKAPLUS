import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { __private__ as metaPrivate } from "../meta-direct-reporting.js";
import { __private__ as dashboardPrivate } from "../dashboard-v10-stable.js";

const reportHandler = fs.readFileSync("report-handler.js", "utf8");
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

test("report route uses Meta for budget and Supabase for customer history", () => {
  assert.match(reportHandler, /createMetaDirectReporting/);
  assert.match(reportHandler, /meta_live_plus_customer_facts/);
  assert.match(reportHandler, /supabase_customer_history/);
  assert.match(reportHandler, /funding_source_display/);
  assert.match(reportHandler, /stored\("leads"/);
});

test("server materialization installs stable dashboard after legacy patch", () => {
  assert.ok(
    start.indexOf('safeImport("./patch-direct-meta-dashboard.js"') >
    start.indexOf('safeImport("./patch-server.js"'),
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-direct-dashboard-"));
  for (const file of ["server-fixed.js", "patch-server.js", "patch-direct-meta-dashboard.js"]) {
    fs.copyFileSync(file, path.join(tmp, file));
  }
  let run = spawnSync(process.execPath, ["patch-server.js"], { cwd: tmp, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  run = spawnSync(process.execPath, ["patch-direct-meta-dashboard.js"], { cwd: tmp, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const server = fs.readFileSync(path.join(tmp, "server-fixed.js"), "utf8");
  assert.match(server, /installStableReportDashboard/);
  assert.match(server, /127\.0\.0\.1:\$\{PORT\}\/functions\/v1\/aiguka-v8-report-api\?action=filters/);
  assert.match(server, /2\.1\.0-v10-direct-meta-dashboard/);
});
