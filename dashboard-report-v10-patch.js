function patchBinaryContactFilter(html) {
  const source = String(html || "");
  if (source.includes("aigukaContactCategoryV10")) return source;

  const openStart = source.indexOf("function openFilter(table,th,col,button){");
  const setupStart = source.indexOf("document.querySelectorAll('table').forEach(table=>{", openStart);
  if (openStart < 0 || setupStart < 0) return source;

  const replacement = String.raw`function aigukaContactCategoryV10(value){
  const text=String(value==null?'':value).replace(/\s+/g,' ').trim();
  const normalized=text.toLowerCase();
  if(!text||text==='-'||normalized==='(trống)'||normalized==='trống'||normalized==='không có'||normalized==='chưa có')return 'Trống';
  const digits=text.replace(/\D/g,'');
  return digits.length>=8||/zalo|đã thu thập|có liên hệ/i.test(text)?'Có SĐT/Zalo':'Trống';
}
function aigukaIsContactHeaderV10(header){
  const value=String(header||'').toLowerCase().replace(/\s+/g,'');
  return value==='sđt'||value==='zalo'||value.includes('sđt/zalo')||value.includes('sốđiệnthoại');
}
function openFilter(table,th,col,button){
  closeMenu();
  const state=stateOf(table);
  const header=clean(th.childNodes[0]?.textContent||th.textContent);
  const contactMode=aigukaIsContactHeaderV10(header);
  const rows=[...(table.tBodies[0]?.rows||[])].filter(r=>r.classList.contains('daily-account-row')||r.cells.length>col);
  const rawValues=rows.map(r=>clean(r.cells[col]?.innerText));
  const values=contactMode
    ? ['Có SĐT/Zalo','Trống']
    : [...new Set(rawValues)].sort((a,b)=>a.localeCompare(b,'vi',{numeric:true}));
  const currentActual=state.filters.get(col);
  const current=contactMode&&currentActual
    ? new Set(values.filter(category=>rawValues.some(value=>aigukaContactCategoryV10(value)===category&&currentActual.has(value))))
    : currentActual;
  const menu=document.createElement('div');
  menu.className='excel-filter-menu';
  openMenu=menu;
  const title=document.createElement('div');
  title.className='excel-filter-title';
  title.textContent='Lọc: '+header;
  menu.appendChild(title);
  const search=document.createElement('input');
  search.type='search';
  search.placeholder='Tìm trong cột...';
  if(contactMode)search.style.display='none';
  menu.appendChild(search);
  const list=document.createElement('div');
  list.className='excel-filter-values';
  menu.appendChild(list);
  const boxes=[];
  values.forEach(value=>{
    const label=document.createElement('label');
    const box=document.createElement('input');
    box.type='checkbox';
    box.checked=!current||current.has(value);
    box.dataset.value=value;
    const text=document.createElement('span');
    text.textContent=value;
    label.append(box,text);
    list.appendChild(label);
    boxes.push({box,label,value});
  });
  const count=document.createElement('div');
  count.className='excel-filter-count';
  count.textContent=contactMode?'2 trạng thái':values.length+' giá trị';
  menu.appendChild(count);
  const actions=document.createElement('div');
  actions.className='excel-filter-actions';
  const all=document.createElement('button');
  all.type='button';
  all.textContent='Chọn tất cả';
  const clear=document.createElement('button');
  clear.type='button';
  clear.textContent='Bỏ lọc';
  const apply=document.createElement('button');
  apply.type='button';
  apply.className='primary';
  apply.textContent='Áp dụng';
  actions.append(all,clear,apply);
  menu.appendChild(actions);
  document.body.appendChild(menu);
  const rect=button.getBoundingClientRect();
  const maxLeft=window.innerWidth-menu.offsetWidth-10;
  menu.style.left=Math.max(10,Math.min(rect.left,maxLeft))+'px';
  menu.style.top=Math.min(rect.bottom+5,window.innerHeight-menu.offsetHeight-10)+'px';
  search.addEventListener('input',()=>{
    const q=String(search.value||'').toLowerCase();
    boxes.forEach(item=>item.label.style.display=item.value.toLowerCase().includes(q)?'':'none');
  });
  all.onclick=()=>boxes.forEach(item=>{if(item.label.style.display!=='none')item.box.checked=true});
  clear.onclick=()=>{state.filters.delete(col);applyFilters(table);closeMenu()};
  apply.onclick=()=>{
    const chosen=new Set(boxes.filter(item=>item.box.checked).map(item=>item.value));
    if(chosen.size===values.length){
      state.filters.delete(col);
    }else if(contactMode){
      state.filters.set(col,new Set(rawValues.filter(value=>chosen.has(aigukaContactCategoryV10(value)))));
    }else{
      state.filters.set(col,chosen);
    }
    applyFilters(table);
    closeMenu();
  };
  menu.addEventListener('click',e=>e.stopPropagation());
  if(!contactMode)search.focus();
}
`;

  return source.slice(0, openStart) + replacement + source.slice(setupStart);
}

export function patchV10ReportTablesUi(html) {
  let output = patchBinaryContactFilter(html);
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
function sourceInfo(row){
  if(row.customer_source_type==='comment')return {label:'Bình luận Facebook',kind:'comment'};
  if(row.ad_id)return {label:'Quảng cáo Meta',kind:'message'};
  if(row.source_channel==='legacy_webhook_inbox'||row.customer_source_type==='message')return {label:'Messenger / tự nhiên',kind:'organic'};
  return {label:row.source_channel||row.identity_source||'Tự nhiên',kind:'organic'};
}
function rewriteLeadSources(rows){
  const body=document.getElementById('leadRows');if(!body)return;
  const table=body.closest('table');if(!table)return;
  const labels=Array.from(table.querySelectorAll('thead th')).map(function(th){return th.textContent.trim()});
  const sourceIndex=labels.indexOf('Nguồn khách');if(sourceIndex<0)return;
  Array.from(body.querySelectorAll('tr')).forEach(function(tr,index){
    const row=rows[index];const cell=tr.children[sourceIndex];if(!row||!cell)return;
    const info=sourceInfo(row);
    cell.innerHTML='<span class="aiguka_source_badge '+info.kind+'">'+esc(info.label)+'</span>';
  });
}
function rewriteLeadCards(rows,count){
  const cards=document.getElementById('leadCards');if(!cards)return;
  const list=Array.isArray(rows)?rows:[];
  const messages=uniqueCount(list,function(row){return row.customer_source_type!=='comment'});
  const comments=uniqueCount(list,function(row){return row.customer_source_type==='comment'});
  const contacts=uniqueCount(list,function(row){return row.has_contact||row.phone||row.zalo});
  const accounts=new Set(list.map(function(row){return row.ad_account_id}).filter(Boolean)).size;
  cards.classList.remove('aiguka_daily_cards');cards.classList.add('aiguka_v10_lead_cards');
  const items=[
    {label:'Tổng khách phát sinh',value:number(count||uniqueCount(list,function(){return true})),hint:'Nhắn tin và bình luận'},
    {label:'Khách nhắn tin',value:number(messages),hint:'Messenger / postback'},
    {label:'Khách comment',value:number(comments),hint:'Bình luận Facebook'},
    {label:'Có SĐT/Zalo',value:number(contacts),hint:'Liên hệ đã thu thập'},
    {label:'Tài khoản có khách',value:number(accounts),hint:'Tài khoản QC được gắn nguồn'}
  ];
  cards.innerHTML=items.map(function(item){return '<div class="card"><div class="cardLabel">'+esc(item.label)+'</div><div class="cardNum">'+esc(item.value)+'</div><div class="cardHint">'+esc(item.hint)+'</div></div>'}).join('');
  const notice=document.getElementById('notice');
  if(notice)notice.textContent='Nguồn hợp nhất: Messenger, bình luận Facebook và Meta Ads; mỗi khách chỉ tính một lần theo Page và khoảng lọc.';
}
function labelOrganicDailyRows(rows){
  const body=document.getElementById('leadRows');if(!body)return;
  const table=body.closest('table');if(!table)return;
  const labels=Array.from(table.querySelectorAll('thead th')).map(function(th){return th.textContent.trim()});
  const accountIndex=labels.indexOf('Tài khoản QC');if(accountIndex<0)return;
  Array.from(body.querySelectorAll('tr')).forEach(function(tr,index){
    const row=rows[index];const cell=tr.children[accountIndex];if(!row||!cell)return;
    if(!row.ad_account_id&&!row.ad_account_name){cell.textContent='Tự nhiên / chưa xác định';cell.classList.add('aiguka_organic_cell')}
  });
}
function install(){
  const current=window.renderLeads;
  if(typeof current!=='function'||!current.__aigukaIntegrity||current.__aigukaV10Facts)return false;
  const wrapped=function(rows,count){
    const result=current.apply(this,arguments);
    const list=Array.isArray(rows)?rows:[];
    if(view==='leads'){rewriteLeadSources(list);rewriteLeadCards(list,count)}
    if(view==='daily')labelOrganicDailyRows(list);
    return result;
  };
  wrapped.__aigukaIntegrity=true;wrapped.__aigukaV10Facts=true;window.renderLeads=wrapped;
  if(typeof window.loadLeads==='function')window.loadLeads().catch(function(){});
  return true;
}
let tries=0;const timer=setInterval(function(){if(install()||++tries>60)clearInterval(timer)},200);install();
})();</script>`;
  if (output.includes('aiguka-v10-report-table-script')) return output;
  output = /<\/body>/i.test(output) ? output.replace(/<\/body>/i, `${extra}</body>`) : `${output}${extra}`;
  return output;
}

export const __private__ = { patchBinaryContactFilter };
