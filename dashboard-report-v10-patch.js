import { enhanceSmartLeadUi } from "./dashboard-smart-lead-ui.js";

export function patchV10ReportTablesUi(html) {
  let output = String(html || "");
  const extra = `<style id="aiguka-v10-report-table-style">
.cards.aiguka_v10_lead_cards{grid-template-columns:repeat(5,minmax(155px,1fr))}
.aiguka_source_badge.comment{background:#fff4ed;color:#b93815}
.aiguka_source_badge.message{background:#eff8ff;color:#175cd3}
.aiguka_source_badge.organic{background:#f2f4f7;color:#344054}
.aiguka_organic_cell{font-weight:700;color:#475467}
@media(max-width:1100px){.cards.aiguka_v10_lead_cards{grid-template-columns:repeat(3,minmax(160px,1fr))}}
@media(max-width:760px){.cards.aiguka_v10_lead_cards{grid-template-columns:repeat(5,155px);min-width:815px}}
</style><script id="aiguka-v10-report-table-script">(function(){
const view=new URLSearchParams(location.search).get('view')||'dashboard';
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function number(value){return new Intl.NumberFormat('vi-VN',{maximumFractionDigits:0}).format(Number(value||0))}
function customerKey(row){return String(row.page_id||'')+':'+String(row.customer_id||row.sender_id||'')}
function uniqueCount(rows,predicate){return new Set(rows.filter(predicate).map(customerKey)).size}
function sourceInfo(row){if(row.customer_source_type==='comment')return {label:'Bình luận Facebook',kind:'comment'};if(row.ad_id)return {label:'Quảng cáo Meta',kind:'message'};return {label:'Messenger / tự nhiên',kind:'organic'}}
function rewriteLeadSources(rows){const body=document.getElementById('leadRows');if(!body)return;const table=body.closest('table');if(!table)return;const labels=Array.from(table.querySelectorAll('thead th')).map(function(th){return th.textContent.trim()});const sourceIndex=labels.indexOf('Nguồn khách');if(sourceIndex<0)return;Array.from(body.querySelectorAll('tr')).forEach(function(tr,index){const row=rows[index],cell=tr.children[sourceIndex];if(!row||!cell)return;const info=sourceInfo(row);cell.innerHTML='<span class="aiguka_source_badge '+info.kind+'">'+esc(info.label)+'</span>'})}
function rewriteLeadCards(rows,count){const cards=document.getElementById('leadCards');if(!cards)return;const list=Array.isArray(rows)?rows:[];const messages=uniqueCount(list,function(row){return row.customer_source_type!=='comment'}),comments=uniqueCount(list,function(row){return row.customer_source_type==='comment'}),contacts=uniqueCount(list,function(row){return row.has_contact||row.phone||row.zalo}),accounts=new Set(list.map(function(row){return row.ad_account_id}).filter(Boolean)).size;cards.classList.remove('aiguka_daily_cards');cards.classList.add('aiguka_v10_lead_cards');const items=[{label:'Tổng khách phát sinh',value:number(count||uniqueCount(list,function(){return true})),hint:'Nhắn tin và bình luận'},{label:'Khách nhắn tin',value:number(messages),hint:'Messenger / postback'},{label:'Khách comment',value:number(comments),hint:'Bình luận Facebook'},{label:'Có SĐT/Zalo',value:number(contacts),hint:'Liên hệ đã thu thập'},{label:'Tài khoản có khách',value:number(accounts),hint:'Tài khoản QC được gắn nguồn'}];cards.innerHTML=items.map(function(item){return '<div class="card"><div class="cardLabel">'+esc(item.label)+'</div><div class="cardNum">'+esc(item.value)+'</div><div class="cardHint">'+esc(item.hint)+'</div></div>'}).join('')}
function labelOrganicDailyRows(rows){const body=document.getElementById('leadRows');if(!body)return;const table=body.closest('table');if(!table)return;const labels=Array.from(table.querySelectorAll('thead th')).map(function(th){return th.textContent.trim()}),accountIndex=labels.indexOf('Tài khoản QC');if(accountIndex<0)return;Array.from(body.querySelectorAll('tr')).forEach(function(tr,index){const row=rows[index],cell=tr.children[accountIndex];if(row&&cell&&!row.ad_account_id&&!row.ad_account_name){cell.textContent='Tự nhiên / chưa xác định';cell.classList.add('aiguka_organic_cell')}})}
function install(){const current=window.renderLeads;if(typeof current!=='function'||current.__aigukaV10Facts)return false;const wrapped=function(rows,count){const result=current.apply(this,arguments),list=Array.isArray(rows)?rows:[];if(view==='leads'){rewriteLeadSources(list);rewriteLeadCards(list,count)}if(view==='daily')labelOrganicDailyRows(list);return result};wrapped.__aigukaIntegrity=current.__aigukaIntegrity===true;wrapped.__aigukaV10Facts=true;window.renderLeads=wrapped;if(typeof window.loadLeads==='function')window.loadLeads().catch(function(){});return true}
let tries=0;const timer=setInterval(function(){if(install()||++tries>60)clearInterval(timer)},200);install();
})();</script>`;
  if (!output.includes("aiguka-v10-report-table-script")) {
    output = /<\/body>/i.test(output)
      ? output.replace(/<\/body>/i, `${extra}</body>`)
      : `${output}${extra}`;
  }
  return enhanceSmartLeadUi(output);
}
