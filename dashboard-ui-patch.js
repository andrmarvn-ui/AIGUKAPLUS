export function patchDashboardUi(html){
  const mappingLink='<a class="nav" data-aiguka-direct-mapping="1" href="/drive-slides">🖼 Mapping</a>';
  let output=html;
  if(!/href=["']\/drive-slides(?:[?"'])/i.test(output)){
    output=/<\/aside>/i.test(output)?output.replace(/<\/aside>/i,mappingLink+'</aside>'):mappingLink+output;
  }

  // The restored V7.5 page is still the production UI. Make its daily table explicit
  // about before-tax spend, VAT and paid spend instead of showing one ambiguous column.
  output=output.replace(
    /const dailyCols=\[\['report_date','Ngày'\][\s\S]*?\];/,
    "const dailyCols=[['report_date','Ngày'],['page_name','Page'],['ad_account_name','Tài khoản QC'],['spend','Chi tiêu chưa VAT'],['tax_amount','VAT 5%'],['spend_with_tax','Chi tiêu có VAT'],['conversations','Hội thoại'],['contacts','SĐT/Zalo'],['contact_rate','Tỷ lệ'],['hot_leads','Khách nóng']];",
  );
  output=output.replace(
    "if(['spend_with_tax','cost_per_contact','cost_per_conversation'].includes(key))",
    "if(['spend','tax_amount','spend_with_tax','cost_per_contact','cost_per_conversation'].includes(key))",
  );
  // The legacy renderer still calls updateCards after every table render. Daily cards are
  // owned by the summary request below, so bypass the Lead-only counter logic for daily.
  output=output.replace(
    "function updateCards(rows){const contacts=",
    "function updateCards(rows){if(currentView==='daily')return;const contacts=",
  );

  const extra=`<style>
.aiguka_lead_tag{display:inline-block;margin:2px;padding:3px 7px;border-radius:999px;background:#ede9fe;color:#5b21b6;font-size:12px;font-weight:700}
.cards.aiguka_daily_cards{grid-template-columns:repeat(4,minmax(170px,1fr))}
.cards.aiguka_daily_cards .card:nth-child(1){border-top-color:#155eef}
.cards.aiguka_daily_cards .card:nth-child(2){border-top-color:#b54708}
.cards.aiguka_daily_cards .card:nth-child(3){border-top-color:#067647}
.cards.aiguka_daily_cards .card:nth-child(4){border-top-color:#6941c6}
.aiguka_legacy_counter{display:none!important}
@media(max-width:1000px){.cards.aiguka_daily_cards{grid-template-columns:repeat(2,minmax(180px,1fr))}}
@media(max-width:700px){.cards.aiguka_daily_cards{grid-template-columns:repeat(4,160px);min-width:680px}}
</style><script>(function(){
function tagNames(v){return (Array.isArray(v)?v:[]).map(x=>x&&typeof x==='object'?(x.text||x.name||''):String(x||'')).filter(Boolean)}
function installLeadTags(){if(typeof window.renderLeads!=='function'||window.renderLeads.__tags)return;const original=window.renderLeads;function enhanced(rows,count){original(rows,count);const body=document.getElementById('leadRows');if(!body)return;const table=body.closest('table'),head=table?.querySelector('thead tr');if(head&&!head.querySelector('[data-aiguka-tags]')){const th=document.createElement('th');th.dataset.aigukaTags='1';th.textContent='Tag Pancake';head.insertBefore(th,head.children[8]||null)}const trs=[...body.querySelectorAll('tr')];(rows||[]).forEach((row,i)=>{const tr=trs[i];if(!tr||tr.children.length<8)return;const td=document.createElement('td');td.dataset.aigukaTags='1';const tags=tagNames(row.pancake_tags);td.innerHTML=tags.length?tags.map(t=>'<span class="aiguka_lead_tag">'+t+'</span>').join(''):'-';tr.insertBefore(td,tr.children[8]||null)});const empty=body.querySelector('tr .empty');if(empty)empty.colSpan=Number(empty.colSpan||11)+1}enhanced.__tags=true;window.renderLeads=enhanced;if(typeof window.loadLeads==='function')window.loadLeads().catch(()=>{})}
let leadTries=0;const leadTimer=setInterval(()=>{installLeadTags();if(++leadTries>30)clearInterval(leadTimer)},300);installLeadTags();

const view=new URLSearchParams(location.search).get('view')||'leads';
if(view!=='daily')return;
const cards=document.getElementById('leadCards');
if(!cards)return;
cards.classList.add('aiguka_daily_cards');
cards.innerHTML='<span id="matchedCount" class="aiguka_legacy_counter"></span><span id="contactCount" class="aiguka_legacy_counter"></span><span id="accountCount" class="aiguka_legacy_counter"></span>'
 +'<div class="card"><div class="cardLabel">Tổng chi tiêu chưa VAT</div><div id="aigukaSpendBeforeVat" class="cardNum">…</div><div class="cardHint">Ngân sách quảng cáo trước thuế</div></div>'
 +'<div class="card"><div class="cardLabel">VAT 5%</div><div id="aigukaVatAmount" class="cardNum">…</div><div class="cardHint">Thuế Meta theo cấu hình 5%</div></div>'
 +'<div class="card"><div class="cardLabel">Tổng chi tiêu có VAT</div><div id="aigukaSpendWithVat" class="cardNum">…</div><div class="cardHint">Tổng tiền thanh toán</div></div>'
 +'<div class="card"><div class="cardLabel">Tỷ lệ ra SĐT/Zalo</div><div id="aigukaContactRate" class="cardNum">…</div><div id="aigukaContactHint" class="cardHint">Liên hệ / hội thoại</div></div>';
const notice=document.getElementById('notice');
if(notice)notice.textContent='Nguồn chi tiêu: Meta Business · VAT áp dụng 5% · Pancake chỉ bổ sung nhân viên và hội thoại.';
function money(v){return new Intl.NumberFormat('vi-VN',{maximumFractionDigits:0}).format(Number(v||0))+' đ'}
function value(id,text){const el=document.getElementById(id);if(el)el.textContent=text}
function summaryParams(){const p=new URLSearchParams();p.set('action','summary');for(const [id,key] of [['from','from'],['to','to'],['page','page_id'],['account','ad_account_id'],['campaign','campaign_id'],['adset','adset_id'],['ad','ad_id'],['search','search']]){const el=document.getElementById(id),v=el&&String(el.value||'').trim();if(v)p.set(key,v)}return p}
let summaryBusy=false;
async function loadDailySummary(){
  if(summaryBusy)return;summaryBusy=true;
  try{
    const secret=sessionStorage.getItem('aiguka_admin_secret')||'AIGUKA_RAILWAY_TEST_MODE';
    const response=await fetch('/functions/v1/aiguka-v8-report-api?'+summaryParams().toString(),{headers:{'x-aiguka-admin-secret':secret},cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.ok===false)throw new Error(data.error||('HTTP '+response.status));
    const s=data.data||{};
    const before=Number(s.spend||0);
    const vat=Number(s.tax_amount||Math.round(before*0.05*100)/100);
    const withVat=Number(s.spend_with_tax||before+vat);
    const conversations=Number(s.conversations||0),contacts=Number(s.contacts||0);
    const rate=Number.isFinite(Number(s.contact_rate))?Number(s.contact_rate):(conversations?Math.round(contacts*10000/conversations)/100:0);
    value('aigukaSpendBeforeVat',money(before));
    value('aigukaVatAmount',money(vat));
    value('aigukaSpendWithVat',money(withVat));
    value('aigukaContactRate',new Intl.NumberFormat('vi-VN',{maximumFractionDigits:2}).format(rate)+'%');
    value('aigukaContactHint',new Intl.NumberFormat('vi-VN').format(contacts)+' / '+new Intl.NumberFormat('vi-VN').format(conversations)+' hội thoại');
  }catch(error){
    value('aigukaSpendBeforeVat','Chưa tải');value('aigukaVatAmount','Chưa tải');value('aigukaSpendWithVat','Chưa tải');value('aigukaContactRate','Chưa tải');
    const hint=document.getElementById('aigukaContactHint');if(hint)hint.textContent=error&&error.message?error.message:String(error);
  }finally{summaryBusy=false}
}
function wrap(name){const fn=window[name];if(typeof fn!=='function'||fn.__aigukaVat)return false;const wrapped=async function(){const result=await fn.apply(this,arguments);await loadDailySummary();return result};wrapped.__aigukaVat=true;window[name]=wrapped;return true}
let hookTries=0;const hookTimer=setInterval(()=>{wrap('applyFilters');wrap('reloadData');if(++hookTries>30)clearInterval(hookTimer)},250);
setTimeout(loadDailySummary,700);
setInterval(loadDailySummary,60000);
})();</script>`;
  return /<\/body>/i.test(output)?output.replace(/<\/body>/i,extra+'</body>'):output+extra;
}
