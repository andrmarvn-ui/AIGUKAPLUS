import fs from "node:fs";

const file = "dashboard-ui-patch.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_REPORT_FILTER_METRICS_HOTFIX_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Report filters and dashboard metrics hotfix already installed");
} else {
  const viewAnchor = "const view=new URLSearchParams(location.search).get('view')||'dashboard';";
  const viewReplacement = `// ${marker}\nfunction normalizeReportView(value){\n  const raw=String(value||'').trim().toLowerCase();\n  if(['leads','lead','customers','customer'].includes(raw))return 'leads';\n  if(['daily','report','reports','daily-report'].includes(raw))return 'daily';\n  if(['dashboard','ads','ad-performance','performance','hieu-qua-quang-cao'].includes(raw))return 'dashboard';\n  const heading=String(document.querySelector('h1')?.textContent||'').trim().toLowerCase();\n  if(heading.includes('khách hàng')||heading.includes('lead'))return 'leads';\n  if(heading.includes('hiệu quả quảng cáo')||heading.includes('dashboard'))return 'dashboard';\n  if(heading.includes('báo cáo ngày'))return 'daily';\n  return 'dashboard';\n}\nconst view=normalizeReportView(new URLSearchParams(location.search).get('view'));`;
  if (!source.includes(viewAnchor)) throw new Error("REPORT_VIEW_ANCHOR_NOT_FOUND");
  source = source.replace(viewAnchor, viewReplacement);

  const filterAnchor = "function emptyRow(body,colspan){body.innerHTML='<tr><td class=\\\"empty\\\" colspan=\\\"'+colspan+'\\\">Không có dữ liệu phù hợp bộ lọc.</td></tr>'}";
  if (!source.includes(filterAnchor)) throw new Error("REPORT_FILTER_ANCHOR_NOT_FOUND");
  const filterRuntime = String.raw`
const aigukaFilterState=new WeakMap();
let aigukaOpenFilterMenu=null;
function aigukaClean(value){const text=String(value==null?'':value).replace(/\s+/g,' ').trim();return text||'(Trống)'}
function aigukaFilterLabel(th){return aigukaClean(th?.dataset?.aigukaLabel||th?.childNodes?.[0]?.textContent||th?.textContent)}
function aigukaFilterValue(label,value){const text=aigukaClean(value);if(label==='SĐT/Zalo')return text==='-'||text==='(Trống)'||/^không có$/i.test(text)?'Không có':'Có SĐT/Zalo';return text}
function aigukaState(table){let state=aigukaFilterState.get(table);if(!state){state=new Map();aigukaFilterState.set(table,state)}return state}
function closeAigukaFilterMenu(){if(aigukaOpenFilterMenu){aigukaOpenFilterMenu.remove();aigukaOpenFilterMenu=null}}
document.addEventListener('click',closeAigukaFilterMenu);
function aigukaNumberFromCell(value){const normalized=String(value||'').replace(/[^0-9,.-]/g,'').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.');return Number(normalized)||0}
function updateAigukaVisibleCards(table){
  const labels=[...table.querySelectorAll('thead th')].map(aigukaFilterLabel),rows=[...(table.tBodies[0]?.rows||[])].filter(function(row){return row.style.display!=='none'&&!row.querySelector('.empty')});
  const cards=[...document.querySelectorAll('#leadCards .cardNum')];if(!cards.length)return;
  if(view==='leads'){
    const contactIndex=labels.indexOf('SĐT/Zalo'),accountIndex=labels.indexOf('Tài khoản QC');
    const contacts=contactIndex<0?0:rows.filter(function(row){return aigukaFilterValue('SĐT/Zalo',row.cells[contactIndex]?.innerText)==='Có SĐT/Zalo'}).length;
    const accounts=accountIndex<0?0:new Set(rows.map(function(row){return aigukaClean(row.cells[accountIndex]?.innerText)}).filter(function(value){return value!=='(Trống)'&&value!=='-'})).size;
    if(cards[0])cards[0].textContent=number(rows.length);if(cards[1])cards[1].textContent=number(contacts);if(cards[2])cards[2].textContent=number(accounts);return;
  }
  if(view==='dashboard'){
    const spendIndex=labels.indexOf('Chi tiêu có VAT'),conversationIndex=labels.indexOf('Hội thoại thực'),contactIndex=labels.indexOf('SĐT/Zalo');
    const spend=spendIndex<0?0:rows.reduce(function(total,row){return total+aigukaNumberFromCell(row.cells[spendIndex]?.innerText)},0);
    const conversations=conversationIndex<0?0:rows.reduce(function(total,row){return total+aigukaNumberFromCell(row.cells[conversationIndex]?.innerText)},0);
    const contacts=contactIndex<0?0:rows.reduce(function(total,row){return total+aigukaNumberFromCell(row.cells[contactIndex]?.innerText)},0);
    if(cards[0])cards[0].textContent=money(spend);if(cards[1])cards[1].textContent=number(conversations);if(cards[2])cards[2].textContent=number(contacts);if(cards[3])cards[3].textContent=contacts?money(spend/contacts):'-';
  }
}
function applyAigukaTableFilters(table){
  const state=aigukaState(table);
  const headers=[...table.querySelectorAll('thead th')];
  const labels=headers.map(aigukaFilterLabel);
  [...(table.tBodies[0]?.rows||[])].forEach(function(row){
    if(row.querySelector('.empty')){row.style.display='';return}
    let show=true;
    for(const [label,selected] of state.entries()){
      const col=labels.indexOf(label);
      if(col<0||!selected.size){show=false;break}
      const actual=aigukaFilterValue(label,row.cells[col]?.innerText);
      if(!selected.has(actual)){show=false;break}
    }
    row.style.display=show?'':'none';
  });
  headers.forEach(function(th){
    const label=aigukaFilterLabel(th),button=th.querySelector('.aiguka-col-filter-btn');
    if(button)button.classList.toggle('active',state.has(label));
  });
  updateAigukaVisibleCards(table);
}
function openAigukaFilter(table,th,col,button,label){
  closeAigukaFilterMenu();
  const rows=[...(table.tBodies[0]?.rows||[])].filter(function(row){return !row.querySelector('.empty')&&row.cells.length>col});
  const values=[...new Set(rows.map(function(row){return aigukaFilterValue(label,row.cells[col]?.innerText)}))].sort(function(a,b){return a.localeCompare(b,'vi',{numeric:true})});
  const state=aigukaState(table),current=state.get(label);
  const menu=document.createElement('div');menu.className='excel-filter-menu aiguka-filter-menu';aigukaOpenFilterMenu=menu;
  const title=document.createElement('div');title.className='excel-filter-title';title.textContent='Lọc: '+label;menu.appendChild(title);
  const search=document.createElement('input');search.type='search';search.placeholder='Tìm trong cột...';if(label==='SĐT/Zalo')search.style.display='none';menu.appendChild(search);
  const list=document.createElement('div');list.className='excel-filter-values';menu.appendChild(list);
  const boxes=[];
  values.forEach(function(value){const item=document.createElement('label'),box=document.createElement('input'),text=document.createElement('span');box.type='checkbox';box.checked=!current||current.has(value);box.dataset.value=value;text.textContent=value;item.append(box,text);list.appendChild(item);boxes.push({box:box,label:item,value:value})});
  const count=document.createElement('div');count.className='excel-filter-count';count.textContent=values.length+' giá trị';menu.appendChild(count);
  const actions=document.createElement('div');actions.className='excel-filter-actions';
  const all=document.createElement('button');all.type='button';all.textContent='Chọn tất cả';
  const clear=document.createElement('button');clear.type='button';clear.textContent='Bỏ lọc';
  const apply=document.createElement('button');apply.type='button';apply.className='primary';apply.textContent='Áp dụng';actions.append(all,clear,apply);menu.appendChild(actions);
  document.body.appendChild(menu);
  const rect=button.getBoundingClientRect(),maxLeft=window.innerWidth-menu.offsetWidth-10;menu.style.left=Math.max(10,Math.min(rect.left,maxLeft))+'px';menu.style.top=Math.min(rect.bottom+5,window.innerHeight-menu.offsetHeight-10)+'px';
  search.addEventListener('input',function(){const q=aigukaClean(search.value).toLowerCase();boxes.forEach(function(item){item.label.style.display=item.value.toLowerCase().includes(q)?'':'none'})});
  all.onclick=function(){boxes.forEach(function(item){if(item.label.style.display!=='none')item.box.checked=true})};
  clear.onclick=function(){state.delete(label);applyAigukaTableFilters(table);closeAigukaFilterMenu()};
  apply.onclick=function(){const chosen=new Set(boxes.filter(function(item){return item.box.checked}).map(function(item){return item.value}));if(chosen.size===values.length)state.delete(label);else state.set(label,chosen);applyAigukaTableFilters(table);closeAigukaFilterMenu()};
  menu.addEventListener('click',function(event){event.stopPropagation()});
  if(label!=='SĐT/Zalo')search.focus();
}
function installAigukaColumnFilters(mode){
  const body=document.getElementById('leadRows'),table=body&&body.closest('table');if(!table)return;
  const allowed=mode==='leads'
    ?new Set(['SĐT/Zalo','Trang Facebook','Tài khoản QC','Campaign','Ad set','Quảng cáo','Trạng thái QC','Sản phẩm','Nguồn khách','Tag Pancake','Nhân viên'])
    :new Set(['Tài khoản QC','Campaign','Ad set','Quảng cáo','Trạng thái']);
  table.querySelectorAll('.col-filter-btn,.aiguka-col-filter-btn').forEach(function(button){button.remove()});
  [...table.querySelectorAll('thead th')].forEach(function(th,col){
    const label=aigukaClean(th.textContent);th.dataset.aigukaLabel=label;if(!allowed.has(label))return;
    const button=document.createElement('button');button.type='button';button.className='col-filter-btn aiguka-col-filter-btn';button.title='Lọc cột';button.textContent='▾';button.onclick=function(event){event.stopPropagation();openAigukaFilter(table,th,col,button,label)};th.appendChild(button);
  });
  applyAigukaTableFilters(table);
}
`;
  source = source.replace(filterAnchor, filterAnchor + filterRuntime);

  const leadNotice = "  setNotice('Nguồn hợp nhất: V9 Messenger + Meta Business; Pancake bổ sung tên, tag, nhân viên và nội dung khi có.');\n}";
  if (!source.includes(leadNotice)) throw new Error("REPORT_LEAD_NOTICE_ANCHOR_NOT_FOUND");
  source = source.replace(leadNotice, "  setNotice('Nguồn hợp nhất: V9 Messenger + Meta Business; Pancake bổ sung tên, tag, nhân viên và nội dung khi có.');\n  installAigukaColumnFilters('leads');\n}");

  const dashboardNotice = "  setNotice('Nguồn hiệu quả quảng cáo: Meta Business; khách và liên hệ được đối chiếu từ V9 Messenger, Pancake chỉ bổ sung dữ liệu chăm sóc.');\n}";
  if (!source.includes(dashboardNotice)) throw new Error("REPORT_DASHBOARD_NOTICE_ANCHOR_NOT_FOUND");
  source = source.replace(dashboardNotice, "  setNotice('Nguồn hiệu quả quảng cáo: Meta Business; khách và liên hệ được đối chiếu từ V9 Messenger, Pancake chỉ bổ sung dữ liệu chăm sóc.');\n  installAigukaColumnFilters('dashboard');\n}");

  const rendererPattern = /function installRenderer\(\)\{[\s\S]*?return true;\n\}/;
  if (!rendererPattern.test(source)) throw new Error("REPORT_RENDERER_ANCHOR_NOT_FOUND");
  source = source.replace(rendererPattern, String.raw`function installRenderer(){
  let installed=false;
  ['renderLeads','renderAds','renderDashboard','renderAdPerformance'].forEach(function(name){
    const original=window[name];if(typeof original!=='function'||original.__aigukaIntegrity)return;
    const enhanced=function(rows,count){if(view==='leads')renderLeadRows(rows,count);else if(view==='dashboard')renderDashboardRows(rows);else return original.apply(this,arguments)};
    enhanced.__aigukaIntegrity=true;window[name]=enhanced;installed=true;
  });
  if(installed){
    const loader=view==='dashboard'?(window.loadAds||window.loadLeads||window.reloadData):(window.loadLeads||window.reloadData);
    if(typeof loader==='function')Promise.resolve(loader()).catch(function(){});
  }
  return installed;
}`);

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Report filters and dashboard metric renderer installed");
}
