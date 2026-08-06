import test from "node:test";
import assert from "node:assert/strict";
import { patchV10ReportTablesUi } from "../dashboard-report-v10-patch.js";
import { enhanceSmartLeadUi } from "../dashboard-smart-lead-ui.js";

const fixture = `<!doctype html><html><body><table><thead><tr><th>Khách hàng</th><th>SĐT</th><th>Zalo</th></tr></thead><tbody><tr><td>A</td><td>0326270439</td><td>-</td></tr></tbody></table></body></html>`;

test("contact filter exposes two business states instead of phone values", () => {
  const output = enhanceSmartLeadUi(fixture);
  assert.match(output, /Có SĐT\/Zalo/);
  assert.match(output, /Không có SĐT\/Zalo/);
  assert.doesNotMatch(output, /Tìm trong cột/);
  assert.doesNotMatch(output, /value=\"0326270439\"/);
});

test("split SĐT and Zalo columns are rendered as one combined contact column", () => {
  const output = enhanceSmartLeadUi(fixture);
  assert.match(output, /isPhoneHeader/);
  assert.match(output, /isZaloHeader/);
  assert.match(output, /aiguka-merged-zalo-column/);
  assert.match(output, /SĐT\/Zalo/);
});

test("blank contact cells include dash and explicit blank labels", () => {
  const output = enhanceSmartLeadUi(fixture);
  assert.match(output, /text==='-'/);
  assert.match(output, /key==='\(trống\)'/);
  assert.match(output, /key==='không có'/);
  assert.match(output, /key==='chưa có'/);
});

test("dashboard report patch remains idempotent", () => {
  const once = patchV10ReportTablesUi(fixture);
  const twice = patchV10ReportTablesUi(once);
  assert.equal((twice.match(/aiguka-smart-lead-ui-v2-script/g) || []).length, 1);
  assert.equal((twice.match(/aiguka-v10-report-table-script/g) || []).length, 1);
});
