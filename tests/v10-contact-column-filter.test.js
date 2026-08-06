import test from "node:test";
import assert from "node:assert/strict";
import { patchV10ReportTablesUi, __private__ } from "../dashboard-report-v10-patch.js";

const genericFilterFixture = `<!doctype html><html><body><script>
(function(){
const states=new WeakMap();let openMenu=null;
const clean=v=>(String(v||'').trim()||'(Trống)');
function stateOf(table){if(!states.has(table))states.set(table,{filters:new Map()});return states.get(table)}
function closeMenu(){if(openMenu){openMenu.remove();openMenu=null}}
function applyFilters(table){return table}
function openFilter(table,th,col,button){closeMenu();const state=stateOf(table);const rows=[...(table.tBodies[0]?.rows||[])].filter(r=>r.cells.length>col);const values=[...new Set(rows.map(r=>clean(r.cells[col].innerText)))];return {state,values,button}}
document.querySelectorAll('table').forEach(table=>{table.querySelectorAll('thead th').forEach(()=>{})});
})();
</script></body></html>`;

test("contact filter is converted from unique phone values to two business states", () => {
  const output = __private__.patchBinaryContactFilter(genericFilterFixture);
  assert.match(output, /function aigukaContactCategoryV10/);
  assert.match(output, /\['Có SĐT\/Zalo','Trống'\]/);
  assert.match(output, /contactMode\?'2 trạng thái'/);
  assert.match(output, /chosen\.has\(aigukaContactCategoryV10\(value\)\)/);
  assert.doesNotMatch(output, /function openFilter[\s\S]*?const values=\[\.\.\.new Set\(rows\.map/);
});

test("contact header recognition covers combined and split contact columns", () => {
  const output = __private__.patchBinaryContactFilter(genericFilterFixture);
  assert.match(output, /value==='sđt'/);
  assert.match(output, /value==='zalo'/);
  assert.match(output, /value\.includes\('sđt\/zalo'\)/);
  assert.match(output, /value\.includes\('sốđiệnthoại'\)/);
});

test("blank contact cells include dash and explicit blank labels", () => {
  const output = __private__.patchBinaryContactFilter(genericFilterFixture);
  assert.match(output, /text==='-'/);
  assert.match(output, /normalized==='\(trống\)'/);
  assert.match(output, /normalized==='không có'/);
  assert.match(output, /normalized==='chưa có'/);
});

test("dashboard report patch remains idempotent", () => {
  const once = patchV10ReportTablesUi(genericFilterFixture);
  const twice = patchV10ReportTablesUi(once);
  assert.equal((twice.match(/function aigukaContactCategoryV10/g) || []).length, 1);
  assert.equal((twice.match(/aiguka-v10-report-table-script/g) || []).length, 1);
});
