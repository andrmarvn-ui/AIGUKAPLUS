export function patchDashboardUi(html){
  const mappingLink='<a class="nav" data-aiguka-direct-mapping="1" href="/drive-slides">🖼 Mapping</a>';
  let output=html;
  if(!/href=["']\/drive-slides(?:[?"'])/i.test(output)){
    output=/<\/aside>/i.test(output)?output.replace(/<\/aside>/i,mappingLink+'</aside>'):mappingLink+output;
  }

  output=output.replace(
    /const dailyCols=\[\['report_date','Ngày'\][\s\S]*?\];/,
    "const dailyCols=[['report_date','Ngày'],['page_name','Page'],['ad_account_name','Tài khoản QC'],['spend','Chi tiêu chưa VAT'],['tax_amount','VAT 5%'],['spend_with_tax','Chi tiêu có VAT'],['conversations','Hội thoại'],['contacts','SĐT/Zalo'],['contact_rate','Tỷ lệ'],['hot_leads','Khách nóng']];",
  );
  output=output.replace(
    "if(['spend_with_tax','cost_per_contact','cost_per_conversation'].includes(key))",
    "if(['spend','tax_amount','spend_with_tax','cost_per_contact','cost_per_conversation'].includes(key))",
  );
  output=output.replace(
    "function updateCards(rows){const contacts=",
    "function updateCards(rows){if(currentView==='daily')return;const contacts=",
  );

  const extra=`<style id="aiguka-report-integrity-style">
.aiguka_report_scroll{overflow:auto!important;max-width:100%}
.aiguka_report_table{min-width:1900px!important;width:100%!important}
.aiguka_report_table th,.aiguka_report_table td{vertical-align:top!important;padding:9px 10px!important}
.aiguka_report_table th{white-space:nowrap!important;position:sticky;top:0;background:#e9eff7;z-index:2}
.aiguka_report_table .aiguka_num{text-align:right;white-space:nowrap}
.aiguka_report_table .aiguka_wrap{min-width:150px;max-width:260px;white-space:normal;word-break:break-word}
.aiguka_report_table .aiguka_last{min-width:260px;max-width:360px;white-space:normal;word-break:break-word}
.aiguka_report_table .aiguka_sub{display:block;margin-top:3px;color:#667085;font-size:11px;font-weight:400}
.aiguka_status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.aiguka_status:before{content:'';width:8px;height:8px;border-radius:50%;background:#98a2b3;display:inline-block}
.aiguka_status.on:before{background:#12b76a}.aiguka_status.off:before{background:#98a2b3}.aiguka_status.warn:before{background:#f79009}
.aiguka_lead_tag{display:inline-block;margin:2px;padding:3px 7px;border-radius:999px;background:#ede9fe;color:#5b21b6;font-size:12px;font-weight:700}
.aiguka_source_badge{display:inline-block;padding:3px 7px;border-radius:999px;background:#eff8ff;color:#175cd3;font-size:11px;font-weight:700}
.cards.aiguka_daily_cards{grid-template-columns:repeat(4,minmax(170px,1fr))}
.cards.aiguka_daily_cards .card:nth-child(1){border-top-color:#155eef}
.cards.aiguka_daily_cards .card:nth-child(2){border-top-color:#b54708}
.cards.aiguka_daily_cards .card:nth-child(3){border-top-color:#067647}
.cards.aiguka_daily_cards .card:nth-child(4){border-top-color:#6941c6}
.aiguka_legacy_counter{display:none!important}
@media(max-width:1000px){.cards.aiguka_daily_cards{grid-template-columns:repeat(2,minmax(180px,1fr))}}
@media(max-width:700px){.cards.aiguka_daily_cards{grid-template-columns:repeat(4,160px);min-width:680px}}
</style><script id="aiguka-report-integrity-script">(function(){
const view=new URLSearchParams(location.search).get('view')||'dashboard';
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function number(value){return new Intl.NumberFormat('vi-VN',{maximumFractionDigits:0}).format(Number(value||0))}
function money(value){return number(value)+' đ'}
function percent(value){return new Intl.NumberFormat('vi-VN',{maximumFractionDigits:2}).format(Number(value||0))+'%'}
function dateTime(value){if(!value)return '-';const d=new Date(value);if(Number.isNaN(d.getTime()))return esc(value);return new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',year:'numeric'}).format(d)}
function tagNames(value){return (Array.isArray(value)?value:[]).map(function(item){return item&&typeof item==='object'?(item.text||item.name||''):String(item||'')}).filter(Boolean)}
function statusClass(value){const text=String(value||'').toUpperCase();if(['ACTIVE','ENABLED','RUNNING'].includes(text))return 'on';if(['PAUSED','DISABLED','ARCHIVED','DELETED','INACTIVE'].includes(text))return 'off';return 'warn'}
function status(value){const label=value||'Không rõ';return '<span class="aiguka_status '+statusClass(value)+'">'+esc(label)+'</span>'}
function sub(main,small){return '<div class="aiguka_wrap">'+esc(main||'-')+(small?'<span class="aiguka_sub">'+esc(small)+'</span>':'')+'</div>'}
function setHead(labels){const body=document.getElementById('leadRows');const table=body&&body.closest('table');if(!table)return null;const wrap=table.parentElement;if(wrap)wrap.classList.add('aiguka_report_scroll');table.classList.add('aiguka_report_table');const head=table.querySelector('thead tr');if(head)head.innerHTML=labels.map(function(label){return '<th>'+esc(label)+'</th>'}).join('');return body}
function setNotice(text){const notice=document.getElementById('notice');if(notice)notice.textContent=text}
function setCards(items){const cards=document.getElementById('leadCards');if(!cards)return;cards.classList.remove('aiguka_daily_cards');cards.innerHTML=items.map(function(item){return '<div class="card"><div class="cardLabel">'+esc(item.label)+'</div><div class="cardNum">'+esc(item.value)+'</div><div class="cardHint">'+esc(item.hint||'')+'</div></div>'}).join('')}
function emptyRow(body,colspan){body.innerHTML='<tr><td class="empty" colspan="'+colspan+'">Không có dữ liệu phù hợp bộ lọc.</td></tr>'}
function renderLeadRows(rows,count){
  const labels=['#','Khách hàng','SĐT/Zalo','Trang Facebook','Tài khoản QC','Campaign','Ad set','Quảng cáo','Trạng thái QC','Sản phẩm','Nguồn khách','Tag Pancake','Nhân viên','Tin cuối','Số tin','Thời gian'];
  const body=setHead(labels);if(!body)return;
  const list=Array.isArray(rows)?rows:[];
  if(!list.length)emptyRow(body,labels.length);else body.innerHTML=list.map(function(row,index){
    const customerId=row.customer_id||row.sender_id||'';
    const contact=row.phone||row.zalo||(row.has_contact?'Đã thu thập':'-');
    const tags=tagNames(row.pancake_tags);
    const source=row.ad_id?'Quảng cáo Meta':(row.source_channel||row.identity_source||'Tự nhiên');
    const product=row.product_label||row.product_group||'-';
    return '<tr>'+
      '<td class="aiguka_num">'+(index+1)+'</td>'+
      '<td>'+sub(row.customer_name||'Khách hàng',customerId)+'</td>'+
      '<td>'+esc(contact)+'</td>'+
      '<td>'+sub(row.page_name,row.page_id)+'</td>'+
      '<td>'+sub(row.ad_account_name,row.ad_account_id)+'</td>'+
      '<td>'+sub(row.campaign_name,row.campaign_id)+'</td>'+
      '<td>'+sub(row.adset_name,row.adset_id)+'</td>'+
      '<td>'+sub(row.ad_name,row.ad_id)+'</td>'+
      '<td>'+status(row.ad_status||row.effective_status)+'</td>'+
      '<td class="aiguka_wrap">'+esc(product)+'</td>'+
      '<td><span class="aiguka_source_badge">'+esc(source)+'</span></td>'+
      '<td class="aiguka_wrap">'+(tags.length?tags.map(function(tag){return '<span class="aiguka_lead_tag">'+esc(tag)+'</span>'}).join(''):'-')+'</td>'+
      '<td>'+esc(row.pancake_employee||'-')+'</td>'+
      '<td class="aiguka_last">'+esc(row.last_snippet||'-')+'</td>'+
      '<td class="aiguka_num">'+number(row.message_count)+'</td>'+
      '<td>'+dateTime(row.last_customer_at||row.conversation_started_at||row.report_date)+'</td>'+
    '</tr>';
  }).join('');
  const contacts=new Set(list.filter(function(row){return row.has_contact||row.phone||row.zalo}).map(function(row){return (row.page_id||'')+':'+(row.customer_id||row.sender_id||'')})).size;
  const accounts=new Set(list.map(function(row){return row.ad_account_id}).filter(Boolean)).size;
  setCards([
    {label:'Khách đã đối chiếu',value:number(count||list.length),hint:'Khách duy nhất trong khoảng lọc'},
    {label:'Có SĐT/Zalo',value:number(contacts),hint:'Liên hệ đã thu thập'},
    {label:'Tài khoản có khách',value:number(accounts),hint:'Tài khoản QC phát sinh khách'}
  ]);
  setNotice('Nguồn hợp nhất: V9 Messenger + Meta Business; Pancake bổ sung tên, tag, nhân viên và nội dung khi có.');
}
function renderDashboardRows(rows){
  const labels=['#','Tài khoản QC','Campaign','Ad set','Quảng cáo','Trạng thái','Chi tiêu chưa VAT','VAT','Chi tiêu có VAT','Hiển thị','Tiếp cận','Click','Hội thoại Meta','Hội thoại thực','SĐT/Zalo','Tỷ lệ','Giá/Hội thoại','Giá/SĐT','Khách nóng'];
  const body=setHead(labels);if(!body)return;
  const list=Array.isArray(rows)?rows:[];
  if(!list.length)emptyRow(body,labels.length);else body.innerHTML=list.map(function(row,index){return '<tr>'+
    '<td class="aiguka_num">'+(index+1)+'</td>'+
    '<td>'+sub(row.ad_account_name,row.ad_account_id)+'</td>'+
    '<td>'+sub(row.campaign_name,row.campaign_id)+'</td>'+
    '<td>'+sub(row.adset_name,row.adset_id)+'</td>'+
    '<td>'+sub(row.ad_name,row.ad_id)+'</td>'+
    '<td>'+status(row.effective_status||row.ad_status)+'</td>'+
    '<td class="aiguka_num">'+money(row.spend)+'</td>'+
    '<td class="aiguka_num">'+money(row.tax_amount)+'</td>'+
    '<td class="aiguka_num">'+money(row.spend_with_tax)+'</td>'+
    '<td class="aiguka_num">'+number(row.impressions)+'</td>'+
    '<td class="aiguka_num">'+number(row.reach)+'</td>'+
    '<td class="aiguka_num">'+number(row.clicks)+'</td>'+
    '<td class="aiguka_num">'+number(row.meta_conversations)+'</td>'+
    '<td class="aiguka_num">'+number(row.conversations)+'</td>'+
    '<td class="aiguka_num">'+number(row.contacts)+'</td>'+
    '<td class="aiguka_num">'+percent(row.contact_rate)+'</td>'+
    '<td class="aiguka_num">'+money(row.cost_per_conversation)+'</td>'+
    '<td class="aiguka_num">'+money(row.cost_per_contact)+'</td>'+
    '<td class="aiguka_num">'+number(row.hot_leads)+'</td>'+
  '</tr>'}).join('');
  const total=list.reduce(function(sum,row){sum.spend+=Number(row.spend_with_tax||0);sum.conversations+=Number(row.conversations||0);sum.contacts+=Number(row.contacts||0);sum.hot+=Number(row.hot_leads||0);return sum},{spend:0,conversations:0,contacts:0,hot:0});
  setCards([
    {label:'Tổng chi tiêu có VAT',value:money(total.spend),hint:'Theo bộ lọc hiện tại'},
    {label:'Hội thoại thực',value:number(total.conversations),hint:'Khách đã đối chiếu'},
    {label:'Có SĐT/Zalo',value:number(total.contacts),hint:'Liên hệ đã thu thập'},
    {label:'Giá/SĐT',value:total.contacts?money(total.spend/total.contacts):'-',hint:'Chi tiêu có VAT / liên hệ'}
  ]);
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
let tries=0;const timer=setInterval(function(){if(installRenderer()||++tries>40)clearInterval(timer)},250);installRenderer();

if(view!=='daily')return;
const cards=document.getElementById('leadCards');
if(!cards)return;
cards.classList.add('aiguka_daily_cards');
cards.innerHTML='<span id="matchedCount" class="aiguka_legacy_counter"></span><span id="contactCount" class="aiguka_legacy_counter"></span><span id="accountCount" class="aiguka_legacy_counter"></span>'
 +'<div class="card"><div class="cardLabel">Tổng chi tiêu chưa VAT</div><div id="aigukaSpendBeforeVat" class="cardNum">…</div><div class="cardHint">Ngân sách quảng cáo trước thuế</div></div>'
 +'<div class="card"><div class="cardLabel">VAT 5%</div><div id="aigukaVatAmount" class="cardNum">…</div><div class="cardHint">Thuế Meta theo cấu hình 5%</div></div>'
 +'<div class="card"><div class="cardLabel">Tổng chi tiêu có VAT</div><div id="aigukaSpendWithVat" class="cardNum">…</div><div class="cardHint">Tổng tiền thanh toán</div></div>'
 +'<div class="card"><div class="cardLabel">Tỷ lệ ra SĐT/Zalo</div><div id="aigukaContactRate" class="cardNum">…</div><div id="aigukaContactHint" class="cardHint">Liên hệ / hội thoại</div></div>';
setNotice('Nguồn chi tiêu: Meta Business · VAT áp dụng 5% · Pancake chỉ bổ sung nhân viên và hội thoại.');
function value(id,text){const el=document.getElementById(id);if(el)el.textContent=text}
function summaryParams(){const p=new URLSearchParams();p.set('action','summary');[['from','from'],['to','to'],['page','page_id'],['account','ad_account_id'],['campaign','campaign_id'],['adset','adset_id'],['ad','ad_id'],['search','search']].forEach(function(pair){const el=document.getElementById(pair[0]),v=el&&String(el.value||'').trim();if(v)p.set(pair[1],v)});return p}
let summaryBusy=false;
async function loadDailySummary(){
  if(summaryBusy)return;summaryBusy=true;
  try{
    const secret=sessionStorage.getItem('aiguka_admin_secret')||'AIGUKA_RAILWAY_TEST_MODE';
    const response=await fetch('/functions/v1/aiguka-v8-report-api?'+summaryParams().toString(),{headers:{'x-aiguka-admin-secret':secret},cache:'no-store'});
    const data=await response.json().catch(function(){return {}});
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
    value('aigukaContactRate',percent(rate));
    value('aigukaContactHint',number(contacts)+' / '+number(conversations)+' hội thoại');
  }catch(error){
    value('aigukaSpendBeforeVat','Chưa tải');value('aigukaVatAmount','Chưa tải');value('aigukaSpendWithVat','Chưa tải');value('aigukaContactRate','Chưa tải');
    const hint=document.getElementById('aigukaContactHint');if(hint)hint.textContent=error&&error.message?error.message:String(error);
  }finally{summaryBusy=false}
}
function wrap(name){const fn=window[name];if(typeof fn!=='function'||fn.__aigukaVat)return false;const wrapped=async function(){const result=await fn.apply(this,arguments);await loadDailySummary();return result};wrapped.__aigukaVat=true;window[name]=wrapped;return true}
let hookTries=0;const hookTimer=setInterval(function(){wrap('applyFilters');wrap('reloadData');if(++hookTries>30)clearInterval(hookTimer)},250);
setTimeout(loadDailySummary,700);setInterval(loadDailySummary,60000);
})();</script>`;
  return /<\/body>/i.test(output)?output.replace(/<\/body>/i,extra+'</body>'):output+extra;
}
