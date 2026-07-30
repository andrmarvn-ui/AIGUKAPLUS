import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { patchDashboardUi } from "../dashboard-ui-patch.js";

const patchServer = fs.readFileSync(new URL("../patch-server.js", import.meta.url), "utf8");

test("production V7.5 daily report receives four VAT/contact cards", () => {
  const source = `<!doctype html><body>
  <aside></aside>
  <section id="leadCards" class="cards"></section>
  <div id="notice"></div>
  <script>
  const currentView='daily';
  const dailyCols=[['report_date','Ngày'],['page_name','Page'],['ad_account_name','Tài khoản QC'],['spend_with_tax','Chi tiêu'],['conversations','Hội thoại'],['contacts','SĐT/Zalo'],['contact_rate','Tỷ lệ'],['hot_leads','Khách nóng']];
  function format(key,v,row){if(['spend_with_tax','cost_per_contact','cost_per_conversation'].includes(key))return v}
  function updateCards(rows){const contacts=rows.length;return contacts}
  </script></body>`;
  const result = patchDashboardUi(source);
  assert.match(result, /Tổng chi tiêu chưa VAT/);
  assert.match(result, /VAT 5%/);
  assert.match(result, /Tổng chi tiêu có VAT/);
  assert.match(result, /Tỷ lệ ra SĐT\/Zalo/);
  assert.match(result, /action','summary/);
  assert.match(result, /\['spend','Chi tiêu chưa VAT'\]/);
  assert.match(result, /\['tax_amount','VAT 5%'\]/);
  assert.match(result, /\['spend_with_tax','Chi tiêu có VAT'\]/);
  assert.match(result, /\['spend','tax_amount','spend_with_tax'/);
  assert.match(result, /function updateCards\(rows\)\{if\(currentView==='daily'\)return;/);
  assert.match(result, /id="matchedCount"/);
  assert.match(result, /id="contactCount"/);
  assert.match(result, /id="accountCount"/);
});

test("runtime health check restores the active report API instead of protected V9 admin", () => {
  assert.match(patchServer, /aiguka-v8-report-api\?action=filters/);
  assert.match(patchServer, /false red disconnected badge/);
  assert.doesNotMatch(
    patchServer,
    /replace\('const url = `\$\{SUPABASE_URL\}\/functions\/v1\/aiguka-v8-report-api\?action=filters`;',[\s\S]*api\/v9\/admin\/overview/,
  );
});

test("dashboard patch remains outbound-free and read-only", () => {
  const source = fs.readFileSync(new URL("../dashboard-ui-patch.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sendMessage|graph\.facebook\.com|method:\s*['\"]POST['\"]/i);
  assert.match(source, /cache:'no-store'/);
});
