import fs from "node:fs";

const file = "dashboard-ui-patch.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_REPORT_FILTER_METRICS_HOTFIX_V2";

if (source.includes(marker)) {
  console.log("[AIGUKA] Report filter runtime V2 already installed");
} else {
  const viewAnchor = "const view=new URLSearchParams(location.search).get('view')||'dashboard';";
  const viewReplacement = `// ${marker}\nfunction normalizeReportView(value){\n  const raw=String(value||'').trim().toLowerCase();\n  if(['leads','lead','customers','customer'].includes(raw))return 'leads';\n  if(['daily','report','reports','daily-report'].includes(raw))return 'daily';\n  if(['dashboard','ads','ad-performance','performance','hieu-qua-quang-cao'].includes(raw))return 'dashboard';\n  const heading=String(document.querySelector('h1')?.textContent||'').trim().toLowerCase();\n  if(heading.includes('khách hàng')||heading.includes('lead'))return 'leads';\n  if(heading.includes('hiệu quả quảng cáo')||heading.includes('dashboard'))return 'dashboard';\n  if(heading.includes('báo cáo ngày'))return 'daily';\n  return 'dashboard';\n}\nconst view=normalizeReportView(new URLSearchParams(location.search).get('view'));`;
  if (!source.includes(viewAnchor)) throw new Error("REPORT_VIEW_ANCHOR_NOT_FOUND");
  source = source.replace(viewAnchor, viewReplacement);

  const styleAnchor = '<style id="aiguka-report-integrity-style">';
  if (!source.includes(styleAnchor)) throw new Error("REPORT_STYLE_ANCHOR_NOT_FOUND");
  const filterCss = String.raw`
/* AIGUKA_REPORT_FILTER_METRICS_HOTFIX_V2 */
.aiguka-col-filter-btn{margin-left:6px;border:1px solid #aebbd0!important;background:#fff!important;color:#334155!important;padding:0 6px!important;border-radius:5px!important;font-size:11px!important;line-height:18px!important;vertical-align:middle;cursor:pointer}
.aiguka-col-filter-btn.active{background:#1458e6!important;color:#fff!important;border-color:#1458e6!important}
.aiguka-filter-menu{position:fixed;z-index:2147483000;width:min(310px,calc(100vw - 20px));max-height:min(440px,calc(100vh - 20px));overflow:hidden;background:#fff;border:1px solid #b8c4d6;border-radius:10px;box-shadow:0 12px 34px rgba(15,23,42,.25);padding:10px;color:#0f172a}
.aiguka-filter-menu input[type=search]{box-sizing:border-box;width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:7px;margin:7px 0;background:#fff;color:#0f172a}
.aiguka-filter-menu .excel-filter-values{max-height:260px;overflow:auto;border:1px solid #e2e8f0;border-radius:7px;padding:5px}
.aiguka-filter-menu .excel-filter-values label{display:flex;gap:7px;align-items:flex-start;padding:5px;border-radius:5px;font-weight:400;cursor:pointer}
.aiguka-filter-menu .excel-filter-values label:hover{background:#f1f5f9}
.aiguka-filter-menu .excel-filter-actions{display:flex;justify-content:space-between;gap:7px;margin-top:9px}
.aiguka-filter-menu .excel-filter-actions button{padding:7px 9px!important;white-space:nowrap}
.aiguka-filter-menu .excel-filter-title{font-weight:700}
.aiguka-filter-menu .excel-filter-count{font-size:11px;color:#64748b;margin-top:5px}
`;
  source = source.replace(styleAnchor, styleAnchor + filterCss);

  const filterAnchor = "function emptyRow(body,colspan){body.innerHTML='<tr><td class=\\\"empty\\\" colspan=\\\"'+colspan+'\\\">Không có dữ liệu phù hợp bộ lọc.</td></tr>'}";
  if (!source.includes(filterAnchor)) throw new Error("REPORT_FILTER_ANCHOR_NOT_FOUND");
  const filterRuntime = String.raw`
const aigukaFilterState=new WeakMap();
const aigukaFilterTables=new Set();
const aigukaFilterObservers=new WeakMap();
let aigukaOpenFilterMenu=null;
let aigukaFilterScanTimer=null;
function aigukaClean(value){const text=String(value==null?'':value).replace(/\s+/g,' ').trim();return text||'(Trống)'}
function aigukaHeaderLabel(th){
  if(th?.dataset?.aigukaLabel)return th.dataset.aigukaLabel;
  if(!th)return '(Trống)';
  const clone=th.cloneNode(true);clone.querySelectorAll('button').forEach(function(button){button.remove()});
  return aigukaClean(clone.textContent);
}
function aigukaFilterValue(label,value){
  const text=aigukaClean(value);
  if(view==='leads'&&label==='SĐT/Zalo')return text==='-'||text==='(Trống)'||/^không có$/i.test(text)?'Không có':'Có SĐT/Zalo';
  return text;
}
function aigukaState(table){let state=aigukaFilterState.get(table);if(!state){state=new Map();aigukaFilterState.set(table,state)}return state}
function closeAigukaFilterMenu(){if(aigukaOpenFilterMenu){aigukaOpenFilterMenu.remove();aigukaOpenFilterMenu=null}}
function aigukaHeaderColumns(table){
  const row=table.tHead&&table.tHead.rows.length?table.tHead.rows[table.tHead.rows.length-1]:null;if(!row)return[];
  let logicalCol=0;
  return [...row.cells].map(function(th){
    const col=logicalCol;logicalCol+=Math.max(1,Number(th.colSpan)||1);
    const label=aigukaHeaderLabel(th),key=label+'::'+col;
    th.dataset.aigukaLabel=label;th.dataset.aigukaFilterKey=key;th.dataset.aigukaFilterCol=String(col);
    return{th:th,col:col,label:label,key:key};
  });
}
function aigukaBuildBodyGrid(table){
  const body=table.tBodies&&table.tBodies[0];if(!body)return[];
  const active=[];const result=[];
  [...body.rows].forEach(function(row){
    const logical=[];
    for(let col=0;col<active.length;col++){
      const span=active[col];if(!span||span.left<=0)continue;
      logical[col]=span.cell;span.left-=1;if(span.left<=0)active[col]=null;
    }
    let cursor=0;
    [...row.cells].forEach(function(cell){
      while(logical[cursor])cursor+=1;
      const colspan=Math.max(1,Number(cell.colSpan)||1),rowspan=Math.max(1,Number(cell.rowSpan)||1);
      for(let offset=0;offset<colspan;offset++){
        logical[cursor+offset]=cell;
        if(rowspan>1)active[cursor+offset]={cell:cell,left:rowspan-1};
      }
      cursor+=colspan;
    });
    result.push({row:row,cells:logical});
  });
  return result;
}
function aigukaNumberFromCell(value){
  let normalized=String(value||'').replace(/\s+/g,'').replace(/[^0-9,.-]/g,'');
  if(!normalized)return 0;
  if(/,\d{1,2}$/.test(normalized)){normalized=normalized.replace(/\./g,'').replace(',','.')}else{normalized=normalized.replace(/[.,](?=\d{3}(?:[.,]|$))/g,'').replace(',','.')}
  const numberValue=Number(normalized);return Number.isFinite(numberValue)?numberValue:0;
}
function aigukaVisibleRows(table){return aigukaBuildBodyGrid(table).filter(function(item){return item.row.style.display!=='none'&&!item.row.querySelector('.empty')})}
function aigukaFindColumn(columns,names){for(const name of names){const found=columns.find(function(item){return item.label===name});if(found)return found.col}return-1}
function aigukaCellText(item,col){return col<0?'':String(item.cells[col]?.innerText||item.cells[col]?.textContent||'')}
function updateAigukaVisibleCards(table){
  if(table.tBodies?.[0]?.id!=='leadRows')return;
  const columns=aigukaHeaderColumns(table),rows=aigukaVisibleRows(table),cards=[...document.querySelectorAll('#leadCards .cardNum')];
  if(view==='leads'){
    const contactIndex=aigukaFindColumn(columns,['SĐT/Zalo']),accountIndex=aigukaFindColumn(columns,['Tài khoản QC']);
    const contacts=contactIndex<0?0:rows.filter(function(item){return aigukaFilterValue('SĐT/Zalo',aigukaCellText(item,contactIndex))==='Có SĐT/Zalo'}).length;
    const accounts=accountIndex<0?0:new Set(rows.map(function(item){return aigukaClean(aigukaCellText(item,accountIndex))}).filter(function(value){return value!=='(Trống)'&&value!=='-'})).size;
    if(cards[0])cards[0].textContent=number(rows.length);if(cards[1])cards[1].textContent=number(contacts);if(cards[2])cards[2].textContent=number(accounts);return;
  }
  if(view==='dashboard'){
    const spendIndex=aigukaFindColumn(columns,['Chi tiêu có VAT']),conversationIndex=aigukaFindColumn(columns,['Hội thoại thực','Hội thoại']),contactIndex=aigukaFindColumn(columns,['SĐT/Zalo']);
    const spend=spendIndex<0?0:rows.reduce(function(total,item){return total+aigukaNumberFromCell(aigukaCellText(item,spendIndex))},0);
    const conversations=conversationIndex<0?0:rows.reduce(function(total,item){return total+aigukaNumberFromCell(aigukaCellText(item,conversationIndex))},0);
    const contacts=contactIndex<0?0:rows.reduce(function(total,item){return total+aigukaNumberFromCell(aigukaCellText(item,contactIndex))},0);
    if(cards[0])cards[0].textContent=money(spend);if(cards[1])cards[1].textContent=number(conversations);if(cards[2])cards[2].textContent=number(contacts);if(cards[3])cards[3].textContent=contacts?money(spend/contacts):'-';return;
  }
  if(view==='daily'){
    const beforeIndex=aigukaFindColumn(columns,['Chi tiêu chưa VAT']),vatIndex=aigukaFindColumn(columns,['VAT 5%','VAT']),withVatIndex=aigukaFindColumn(columns,['Chi tiêu có VAT']),conversationIndex=aigukaFindColumn(columns,['Hội thoại','Hội thoại thực']),contactIndex=aigukaFindColumn(columns,['SĐT/Zalo']);
    const sum=function(col){return col<0?0:rows.reduce(function(total,item){return total+aigukaNumberFromCell(aigukaCellText(item,col))},0)};
    const before=sum(beforeIndex),vat=vatIndex<0?before*0.05:sum(vatIndex),withVat=withVatIndex<0?before+vat:sum(withVatIndex),conversations=sum(conversationIndex),contacts=sum(contactIndex),rate=conversations?contacts*100/conversations:0;
    const write=function(id,text){const el=document.getElementById(id);if(el)el.textContent=text};
    write('aigukaSpendBeforeVat',money(before));write('aigukaVatAmount',money(vat));write('aigukaSpendWithVat',money(withVat));write('aigukaContactRate',percent(rate));write('aigukaContactHint',number(contacts)+' / '+number(conversations)+' hội thoại');
  }
}
function aigukaRefreshActiveFlag(){
  let active=false;aigukaFilterTables.forEach(function(table){if(aigukaState(table).size)active=true});
  window.__aigukaColumnFiltersActive=active;
  if(!active&&view==='daily'&&typeof loadDailySummary==='function')setTimeout(function(){loadDailySummary().catch(function(){})},0);
}
function applyAigukaTableFilters(table){
  const state=aigukaState(table),columns=aigukaHeaderColumns(table),byKey=new Map(columns.map(function(item){return[item.key,item]}));
  for(const key of [...state.keys()])if(!byKey.has(key))state.delete(key);
  aigukaBuildBodyGrid(table).forEach(function(item){
    if(item.row.querySelector('.empty')){item.row.style.display='';return}
    let show=true;
    for(const [key,selected] of state.entries()){
      const column=byKey.get(key);if(!column||!selected.size){show=false;break}
      const actual=aigukaFilterValue(column.label,aigukaCellText(item,column.col));if(!selected.has(actual)){show=false;break}
    }
    item.row.style.display=show?'':'none';
  });
  columns.forEach(function(column){const button=column.th.querySelector('.aiguka-col-filter-btn');if(button)button.classList.toggle('active',state.has(column.key))});
  updateAigukaVisibleCards(table);aigukaRefreshActiveFlag();
}
function openAigukaFilter(table,column,button){
  closeAigukaFilterMenu();
  const rows=aigukaBuildBodyGrid(table).filter(function(item){return !item.row.querySelector('.empty')});
  const values=[...new Set(rows.map(function(item){return aigukaFilterValue(column.label,aigukaCellText(item,column.col))}))].sort(function(a,b){return a.localeCompare(b,'vi',{numeric:true})});
  const state=aigukaState(table),current=state.get(column.key);
  const menu=document.createElement('div');menu.className='excel-filter-menu aiguka-filter-menu';aigukaOpenFilterMenu=menu;
  const title=document.createElement('div');title.className='excel-filter-title';title.textContent='Lọc: '+column.label;menu.appendChild(title);
  const search=document.createElement('input');search.type='search';search.placeholder='Tìm trong cột...';if(view==='leads'&&column.label==='SĐT/Zalo')search.style.display='none';menu.appendChild(search);
  const list=document.createElement('div');list.className='excel-filter-values';menu.appendChild(list);const boxes=[];
  values.forEach(function(value){const label=document.createElement('label'),box=document.createElement('input'),text=document.createElement('span');box.type='checkbox';box.checked=!current||current.has(value);box.dataset.value=value;text.textContent=value;label.append(box,text);list.appendChild(label);boxes.push({box:box,label:label,value:value})});
  const count=document.createElement('div');count.className='excel-filter-count';count.textContent=values.length+' giá trị';menu.appendChild(count);
  const actions=document.createElement('div');actions.className='excel-filter-actions';
  const all=document.createElement('button');all.type='button';all.textContent='Chọn tất cả';
  const clear=document.createElement('button');clear.type='button';clear.textContent='Bỏ lọc';
  const apply=document.createElement('button');apply.type='button';apply.className='primary';apply.textContent='Áp dụng';actions.append(all,clear,apply);menu.appendChild(actions);document.body.appendChild(menu);
  const place=function(){const rect=button.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight,maxLeft=Math.max(10,window.innerWidth-width-10),maxTop=Math.max(10,window.innerHeight-height-10);menu.style.left=Math.max(10,Math.min(rect.left,maxLeft))+'px';menu.style.top=Math.max(10,Math.min(rect.bottom+5,maxTop))+'px'};place();
  search.addEventListener('input',function(){const q=String(search.value||'').trim().toLowerCase();let shown=0;boxes.forEach(function(item){const visible=!q||item.value.toLowerCase().includes(q);item.label.style.display=visible?'':'none';if(visible)shown+=1});count.textContent=shown+'/'+values.length+' giá trị'});
  all.onclick=function(){boxes.forEach(function(item){if(item.label.style.display!=='none')item.box.checked=true})};
  clear.onclick=function(){state.delete(column.key);applyAigukaTableFilters(table);closeAigukaFilterMenu()};
  apply.onclick=function(){const chosen=new Set(boxes.filter(function(item){return item.box.checked}).map(function(item){return item.value}));if(chosen.size===values.length)state.delete(column.key);else state.set(column.key,chosen);applyAigukaTableFilters(table);closeAigukaFilterMenu()};
  menu.addEventListener('click',function(event){event.stopPropagation()});if(search.style.display!=='none')search.focus();
}
function aigukaInstallOnTable(table){
  if(!table||!table.tHead||!table.tBodies?.length)return;
  aigukaFilterTables.add(table);
  const columns=aigukaHeaderColumns(table);
  columns.forEach(function(column){
    column.th.querySelectorAll('.col-filter-btn:not(.aiguka-col-filter-btn)').forEach(function(button){button.remove()});
    let button=column.th.querySelector('.aiguka-col-filter-btn');
    if(!button){button=document.createElement('button');button.type='button';button.className='col-filter-btn aiguka-col-filter-btn';button.title='Lọc cột';button.textContent='▾';column.th.appendChild(button)}
    button.onclick=function(event){event.preventDefault();event.stopPropagation();openAigukaFilter(table,column,button)};
  });
  if(!aigukaFilterObservers.has(table)){
    const observer=new MutationObserver(function(){aigukaScheduleFilterScan()});observer.observe(table,{childList:true,subtree:true});aigukaFilterObservers.set(table,observer);
  }
  applyAigukaTableFilters(table);
}
function installAigukaColumnFilters(){document.querySelectorAll('table').forEach(function(table){aigukaInstallOnTable(table)})}
function aigukaScheduleFilterScan(){if(aigukaFilterScanTimer)return;aigukaFilterScanTimer=setTimeout(function(){aigukaFilterScanTimer=null;installAigukaColumnFilters()},25)}
function aigukaBootColumnFilters(){
  installAigukaColumnFilters();
  if(document.body){const observer=new MutationObserver(aigukaScheduleFilterScan);observer.observe(document.body,{childList:true,subtree:true})}
  let attempts=0;const timer=setInterval(function(){installAigukaColumnFilters();if(++attempts>=40)clearInterval(timer)},250);
}
document.addEventListener('click',function(event){if(event.target.closest('.aiguka-filter-menu,.aiguka-col-filter-btn'))return;closeAigukaFilterMenu()});
window.addEventListener('resize',closeAigukaFilterMenu);window.addEventListener('scroll',closeAigukaFilterMenu,true);
setTimeout(aigukaBootColumnFilters,0);
`;
  source = source.replace(filterAnchor, filterAnchor + filterRuntime);

  const leadNotice = "  setNotice('Nguồn hợp nhất: V9 Messenger + Meta Business; Pancake bổ sung tên, tag, nhân viên và nội dung khi có.');\n}";
  if (!source.includes(leadNotice)) throw new Error("REPORT_LEAD_NOTICE_ANCHOR_NOT_FOUND");
  source = source.replace(leadNotice, "  setNotice('Nguồn hợp nhất: V9 Messenger + Meta Business; Pancake bổ sung tên, tag, nhân viên và nội dung khi có.');\n  installAigukaColumnFilters();\n}");

  const dashboardNotice = "  setNotice('Nguồn hiệu quả quảng cáo: Meta Business; khách và liên hệ được đối chiếu từ V9 Messenger, Pancake chỉ bổ sung dữ liệu chăm sóc.');\n}";
  if (!source.includes(dashboardNotice)) throw new Error("REPORT_DASHBOARD_NOTICE_ANCHOR_NOT_FOUND");
  source = source.replace(dashboardNotice, "  setNotice('Nguồn hiệu quả quảng cáo: Meta Business; khách và liên hệ được đối chiếu từ V9 Messenger, Pancake chỉ bổ sung dữ liệu chăm sóc.');\n  installAigukaColumnFilters();\n}");

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

  const summaryAnchor = "async function loadDailySummary(){\n  if(summaryBusy)return;summaryBusy=true;";
  if (source.includes(summaryAnchor)) {
    source = source.replace(summaryAnchor, "async function loadDailySummary(){\n  if(window.__aigukaColumnFiltersActive)return;\n  if(summaryBusy)return;summaryBusy=true;");
  }

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Report filter runtime V2 installed for daily, leads and ad performance tables");
}
