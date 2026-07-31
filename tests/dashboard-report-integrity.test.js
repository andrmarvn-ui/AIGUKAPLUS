import test from "node:test";
import assert from "node:assert/strict";
import { patchDashboardUi } from "../dashboard-ui-patch.js";

const baseHtml = `<!doctype html><html><body>
<aside></aside>
<div id="leadCards"></div><div id="notice"></div>
<table><thead><tr><th>#</th></tr></thead><tbody id="leadRows"></tbody></table>
<script>
const dailyCols=[['report_date','Ngày']];
function updateCards(rows){const contacts=0;return contacts}
function moneyCell(key){if(['spend_with_tax','cost_per_contact','cost_per_conversation'].includes(key))return key}
</script>
</body></html>`;

test("dashboard patch installs separate complete Lead and ad-performance schemas", () => {
  const output = patchDashboardUi(baseHtml);
  assert.match(output, /renderLeadRows/);
  assert.match(output, /renderDashboardRows/);
  assert.match(output, /Trang Facebook/);
  assert.match(output, /Tag Pancake/);
  assert.match(output, /Chi tiêu chưa VAT/);
  assert.match(output, /Hội thoại Meta/);
  assert.match(output, /Giá\/SĐT/);
  assert.match(output, /aiguka_report_scroll/);
});

test("daily patch retains before-tax, VAT and paid-spend columns", () => {
  const output = patchDashboardUi(baseHtml);
  assert.match(output, /\['spend','Chi tiêu chưa VAT'\]/);
  assert.match(output, /\['tax_amount','VAT 5%'\]/);
  assert.match(output, /\['spend_with_tax','Chi tiêu có VAT'\]/);
});
