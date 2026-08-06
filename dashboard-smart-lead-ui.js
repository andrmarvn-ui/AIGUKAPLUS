const SMART_LEAD_UI_MARKER = "aiguka-smart-lead-ui-v2";

const SMART_LEAD_UI = String.raw`<style id="aiguka-smart-lead-ui-v2-style">
.aiguka-head-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:20px;margin-left:6px;padding:0 7px;border-radius:999px;color:#fff;font:800 11px Arial,sans-serif;vertical-align:middle;box-shadow:0 1px 2px #0002}
.aiguka-head-count.customer{background:#475467}.aiguka-head-count.contact{background:#067647}
.aiguka-smart-contact-menu{position:fixed;z-index:2147483645;width:260px;background:#fff;border:1px solid #b8c4d6;border-radius:10px;box-shadow:0 14px 34px #0003;padding:10px;color:#172033;font-family:Arial,sans-serif}
.aiguka-smart-contact-menu h4{margin:0 0 9px;font-size:14px}.aiguka-smart-contact-menu label{display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px}.aiguka-smart-contact-menu label:hover{background:#f2f4f7}.aiguka-smart-contact-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:9px}.aiguka-smart-contact-actions button{padding:7px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;font-weight:700}.aiguka-smart-contact-actions .primary{background:#155eef;color:#fff;border-color:#155eef}.aiguka-contact-hidden,.aiguka-merged-zalo-column{display:none!important}
.aiguka-contact-secondary{display:block;color:#667085;font-size:10px;margin-top:2px}
</style><script id="aiguka-smart-lead-ui-v2-script">(function(){
if(window.__AIGUKA_SMART_LEAD_UI_V2__)return;window.__AIGUKA_SMART_LEAD_UI_V2__=true;
let contactSelection=new Set(['Có SĐT/Zalo','Không có SĐT/Zalo']);let openMenu=null;let scheduled=false;
function clean(value){return String(value==null?'':value).replace(/\s+/g,' ').trim()}
function headerText(th){const clone=th.cloneNode(true);clone.querySelectorAll('button,.aiguka-head-count').forEach(function(node){node.remove()});return clean(clone.textContent)}
function normalized(value){return clean(value).toLowerCase().replace(/\s+/g,'')}
function isEmpty(value){const text=clean(value),key=text.toLowerCase();return !text||text==='-'||key==='(trống)'||key==='trống'||key==='không có'||key==='chưa có'}
function hasContact(value){const text=clean(value);if(isEmpty(text))return false;return text.replace(/\D/g,'').length>=8||/zalo|đã thu thập|có liên hệ/i.test(text)}
function isCustomerHeader(value){return /^(khách hàng|tên khách hàng)$/i.test(clean(value))}
function isPhoneHeader(value){const key=normalized(value);return key==='sđt'||key==='sốđiệnthoại'}
function isZaloHeader(value){return normalized(value)==='zalo'}
function isCombinedContactHeader(value){const key=normalized(value);return key==='sđt/zalo'||key==='sđt-zalo'||key==='sđt,zalo'}
function rowsOf(table){return Array.from(table.tBodies[0]?.rows||[]).filter(function(row){return !row.querySelector('.empty')&&row.cells.length>1})}
function close(){if(openMenu){openMenu.remove();openMenu=null}}
function mergeContactColumns(table){
 const headers=Array.from(table.querySelectorAll('thead th'));let phone=-1,zalo=-1,combined=-1;
 headers.forEach(function(th,index){const label=headerText(th);if(isCombinedContactHeader(label))combined=index;else if(isPhoneHeader(label))phone=index;else if(isZaloHeader(label))zalo=index});
 if(combined>=0)return combined;
 if(phone<0&&zalo<0)return -1;
 const keep=phone>=0?phone:zalo,hidden=phone>=0&&zalo>=0?zalo:-1;
 rowsOf(table).forEach(function(row){
   const first=clean(row.cells[keep]?.innerText),second=hidden>=0?clean(row.cells[hidden]?.innerText):'';
   const values=[first,second].filter(function(value,index,array){return !isEmpty(value)&&array.indexOf(value)===index});
   if(row.cells[keep])row.cells[keep].innerHTML=values.length?values.map(function(value,index){const safe=value.replace(/[&<>]/g,'');return index?'<span class="aiguka-contact-secondary">Zalo: '+safe+'</span>':safe}).join(''):'-';
   if(hidden>=0&&row.cells[hidden])row.cells[hidden].classList.add('aiguka-merged-zalo-column');
 });
 const keepTh=headers[keep];if(keepTh){const oldButton=keepTh.querySelector('button');keepTh.innerHTML='<span class="aiguka-head-label">SĐT/Zalo</span>';if(oldButton)keepTh.appendChild(oldButton)}
 if(hidden>=0&&headers[hidden])headers[hidden].classList.add('aiguka-merged-zalo-column');
 return keep;
}
function ensureFilterButton(th){let button=th.querySelector('button');if(!button){button=document.createElement('button');button.type='button';button.className='col-filter-btn';button.textContent='▾';th.appendChild(button)}button.dataset.aigukaSmartContact='1';button.title='Lọc Có SĐT/Zalo / Không có SĐT/Zalo';button.classList.toggle('active',contactSelection.size!==2);return button}
function setBadge(th,kind,count){let badge=th.querySelector('.aiguka-head-count.'+kind);if(!badge){badge=document.createElement('span');badge.className='aiguka-head-count '+kind;const button=th.querySelector('button');button?th.insertBefore(badge,button):th.appendChild(badge)}const text=String(count);if(badge.textContent!==text)badge.textContent=text}
function applyContactFilter(table,index){rowsOf(table).forEach(function(row){const match=hasContact(row.cells[index]?.innerText)?'Có SĐT/Zalo':'Không có SĐT/Zalo';row.classList.toggle('aiguka-contact-hidden',!contactSelection.has(match))})}
function updateTable(table){const headers=Array.from(table.querySelectorAll('thead th'));if(!headers.length)return;const customerIndex=headers.findIndex(function(th){return isCustomerHeader(headerText(th))});if(customerIndex<0)return;const contactIndex=mergeContactColumns(table);if(contactIndex<0)return;const updatedHeaders=Array.from(table.querySelectorAll('thead th')),customerTh=updatedHeaders[customerIndex],contactTh=updatedHeaders[contactIndex];if(!customerTh||!contactTh)return;ensureFilterButton(contactTh);applyContactFilter(table,contactIndex);const visible=rowsOf(table).filter(function(row){return getComputedStyle(row).display!=='none'}),contacts=visible.filter(function(row){return hasContact(row.cells[contactIndex]?.innerText)}).length;setBadge(customerTh,'customer',visible.length);setBadge(contactTh,'contact',contacts)}
function updateAll(){scheduled=false;document.querySelectorAll('table').forEach(updateTable)}
function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(updateAll)}
function showMenu(button){close();const menu=document.createElement('div');menu.className='aiguka-smart-contact-menu';openMenu=menu;menu.innerHTML='<h4>Lọc: SĐT/Zalo</h4><label><input type="checkbox" value="Có SĐT/Zalo" '+(contactSelection.has('Có SĐT/Zalo')?'checked':'')+'>Có SĐT/Zalo</label><label><input type="checkbox" value="Không có SĐT/Zalo" '+(contactSelection.has('Không có SĐT/Zalo')?'checked':'')+'>Không có SĐT/Zalo</label><div class="aiguka-smart-contact-actions"><button data-action="clear">Bỏ lọc</button><button class="primary" data-action="apply">Áp dụng</button></div>';document.body.appendChild(menu);const rect=button.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(rect.left,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.min(rect.bottom+5,innerHeight-menu.offsetHeight-8)+'px';menu.querySelector('[data-action=clear]').onclick=function(){contactSelection=new Set(['Có SĐT/Zalo','Không có SĐT/Zalo']);close();schedule()};menu.querySelector('[data-action=apply]').onclick=function(){contactSelection=new Set(Array.from(menu.querySelectorAll('input:checked')).map(function(input){return input.value}));close();schedule()}}
document.addEventListener('click',function(event){const button=event.target.closest('button[data-aiguka-smart-contact="1"]');if(button){event.preventDefault();event.stopImmediatePropagation();showMenu(button);return}if(openMenu&&!event.target.closest('.aiguka-smart-contact-menu'))close()},true);
const observer=new MutationObserver(schedule);observer.observe(document.documentElement,{subtree:true,childList:true});setInterval(schedule,1500);schedule();
})();</script>`;

export function enhanceSmartLeadUi(html) {
  const source = String(html || "");
  if (source.includes(SMART_LEAD_UI_MARKER)) return source;
  return /<\/body>/i.test(source)
    ? source.replace(/<\/body>/i, `${SMART_LEAD_UI}</body>`)
    : `${source}${SMART_LEAD_UI}`;
}

export const __private__ = { SMART_LEAD_UI_MARKER };
