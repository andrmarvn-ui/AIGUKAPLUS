import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { patchDashboardUi } from "../dashboard-ui-patch.js";
import { patchV10ReportTablesUi } from "../dashboard-report-v10-patch.js";

function inlineScripts(html) {
  const out = [];
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (/\bsrc\s*=/.test(match[1] || "")) continue;
    out.push(match[2] || "");
  }
  return out;
}

test("dashboard report patches emit syntactically valid inline scripts", () => {
  const base = `<!doctype html><html><body><div id="leadCards"></div><div id="notice"></div><table><thead><tr></tr></thead><tbody id="leadRows"></tbody></table><script>
  const dailyCols=[['report_date','Ngày'],['page_name','Page']];
  function format(key,v,row){if(['spend_with_tax','cost_per_contact','cost_per_conversation'].includes(key))return v;return v}
  function updateCards(rows){const contacts=rows.length;return contacts}
  window.renderLeads=function(){};window.loadLeads=async function(){};
  </script></body></html>`;
  const html = patchV10ReportTablesUi(patchDashboardUi(base));
  const scripts = inlineScripts(html);
  assert.ok(scripts.length >= 3);
  scripts.forEach((source, index) => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: `dashboard-inline-${index + 1}.js` }), `inline script ${index + 1} must parse`);
  });
});
