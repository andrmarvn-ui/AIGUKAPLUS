import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const patchFile = path.resolve("patch-dashboard-ui-filter-metrics.js");

function fixture() {
  return `export function patchDashboardUi(html){
  const extra=\`<script>
const view=new URLSearchParams(location.search).get('view')||'dashboard';
function emptyRow(body,colspan){body.innerHTML='<tr><td class=\\"empty\\" colspan=\\"'+colspan+'\\">Không có dữ liệu phù hợp bộ lọc.</td></tr>'}
function renderLeadRows(rows,count){
  setNotice('Nguồn hợp nhất: V9 Messenger + Meta Business; Pancake bổ sung tên, tag, nhân viên và nội dung khi có.');
}
function renderDashboardRows(rows){
  const labels=['#','Tài khoản QC','Campaign','Ad set','Quảng cáo','Trạng thái','Chi tiêu chưa VAT','VAT','Chi tiêu có VAT','Hiển thị','Tiếp cận','Click','Hội thoại Meta','Hội thoại thực','SĐT/Zalo','Tỷ lệ','Giá/Hội thoại','Giá/SĐT','Khách nóng'];
  setNotice('Nguồn hiệu quả quảng cáo: Meta Business; khách và liên hệ được đối chiếu từ V9 Messenger, Pancake chỉ bổ sung dữ liệu chăm sóc.');
}
function installRenderer(){
  if(typeof window.renderLeads!=='function'||window.renderLeads.__aigukaIntegrity)return false;
  const original=window.renderLeads;
  const enhanced=function(rows,count){
    if(view==='leads')renderLeadRows(rows,count);
    else if(view==='dashboard')renderDashboardRows(rows);
    else original(rows,count);
  };
  enhanced.__aigukaIntegrity=true;window.renderLeads=enhanced;
  if(typeof window.loadLeads==='function')window.loadLeads().catch(function(){});
  return true;
}
</script>\`;
  return html+extra;
}`;
}

test("runtime hotfix normalizes report view aliases and installs working column filters", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"aiguka-report-hotfix-"));
  const target=path.join(dir,"dashboard-ui-patch.js");
  fs.writeFileSync(target,fixture(),"utf8");
  const run=spawnSync(process.execPath,[patchFile],{cwd:dir,encoding:"utf8"});
  assert.equal(run.status,0,run.stderr||run.stdout);
  const output=fs.readFileSync(target,"utf8");
  assert.match(output,/AIGUKA_REPORT_FILTER_METRICS_HOTFIX_V1/);
  assert.match(output,/\['dashboard','ads','ad-performance','performance'/);
  assert.match(output,/installAigukaColumnFilters\('leads'\)/);
  assert.match(output,/installAigukaColumnFilters\('dashboard'\)/);
  assert.match(output,/applyAigukaTableFilters/);
  assert.match(output,/renderAds/);
  const syntax=spawnSync(process.execPath,["--check",target],{encoding:"utf8"});
  assert.equal(syntax.status,0,syntax.stderr||syntax.stdout);
});
