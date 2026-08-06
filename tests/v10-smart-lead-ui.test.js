import test from "node:test";
import assert from "node:assert/strict";
import { enhanceSmartLeadUi, __private__ as smartPrivate } from "../dashboard-smart-lead-ui.js";
import { enhanceV10DashboardHtml } from "../dashboard-v10-admin-shell.js";
import { patchV10ReportTablesUi } from "../dashboard-report-v10-patch.js";
import { __private__ as reportDashboard } from "../dashboard-v10-stable.js";

test("smart Lead UI keeps one contact column and two filter states", () => {
  const html = enhanceSmartLeadUi("<body></body>");
  assert.match(html, new RegExp(smartPrivate.SMART_LEAD_UI_MARKER));
  assert.match(html, /SĐT\/Zalo/);
  assert.match(html, /Có SĐT\/Zalo/);
  assert.match(html, /Không có SĐT\/Zalo/);
  assert.match(html, /aiguka-merged-zalo-column/);
  assert.doesNotMatch(html, /Tìm trong cột/);
});

test("header counters follow visible customer and contact rows", () => {
  const html = enhanceSmartLeadUi("<body></body>");
  assert.match(html, /\.aiguka-head-count\.customer/);
  assert.match(html, /\.aiguka-head-count\.contact/);
  assert.match(html, /setBadge\(customerTh,'customer',visible\.length\)/);
  assert.match(html, /setBadge\(contactTh,'contact',contacts\)/);
});

test("smart UI is idempotent and wired to both dashboard routes", () => {
  const once = enhanceSmartLeadUi("<body></body>");
  assert.equal(enhanceSmartLeadUi(once), once);
  assert.match(enhanceV10DashboardHtml(reportDashboard.dashboardHtml()), /aiguka-smart-lead-ui-v2-script/);
  assert.match(patchV10ReportTablesUi("<html><body></body></html>"), /aiguka-smart-lead-ui-v2-script/);
});
