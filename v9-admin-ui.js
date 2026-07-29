const HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AIGUKA V9 · Quản trị & Báo cáo</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182230;background:#f5f7fa;--brand:#6941c6;--ok:#067647;--warn:#b54708;--bad:#b42318;--line:#e4e7ec}
*{box-sizing:border-box}body{margin:0}.layout{display:grid;grid-template-columns:238px 1fr;min-height:100vh}.side{background:#101828;color:#fff;padding:18px 14px;position:sticky;top:0;height:100vh}.brand{font-weight:850;font-size:19px;padding:8px 10px 18px}.brand small{display:block;color:#98a2b3;font-size:11px;margin-top:4px}.nav{display:flex;flex-direction:column;gap:6px}.nav button{border:0;background:transparent;color:#d0d5dd;text-align:left;padding:11px 12px;border-radius:9px;font-size:14px;cursor:pointer}.nav button:hover,.nav button.active{background:#344054;color:#fff}.side-foot{position:absolute;left:14px;right:14px;bottom:18px;color:#98a2b3;font-size:12px}.main{min-width:0}.top{height:66px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;z-index:5}.title{font-size:19px;font-weight:800}.status{display:flex;align-items:center;gap:8px;font-size:13px}.dot{width:9px;height:9px;border-radius:50%;background:#98a2b3}.dot.ok{background:#12b76a}.dot.warn{background:#f79009}.dot.bad{background:#f04438}.content{padding:22px;max-width:1600px}.panel{display:none}.panel.active{display:block}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.toolbar input,.toolbar select{height:38px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:0 10px;min-width:145px}.btn{height:38px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;padding:0 14px;font-weight:700;cursor:pointer}.btn.primary{background:var(--brand);color:#fff;border-color:var(--brand)}.btn:disabled{opacity:.55;cursor:not-allowed}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:0 1px 2px rgba(16,24,40,.03)}.metric-label{color:#667085;font-size:12px}.metric-value{font-size:26px;font-weight:850;margin-top:8px}.metric-note{color:#667085;font-size:12px;margin-top:4px}.section{margin-top:16px}.section h3{font-size:15px;margin:0 0 12px}.table-wrap{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:auto}.table{width:100%;border-collapse:collapse;min-width:880px}.table th,.table td{padding:11px 12px;border-bottom:1px solid #eaecf0;text-align:left;font-size:13px;vertical-align:top}.table th{background:#f9fafb;color:#475467;position:sticky;top:0}.table tr:last-child td{border-bottom:0}.badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:11px;font-weight:750}.badge.ok{background:#ecfdf3;color:#027a48}.badge.warn{background:#fffaeb;color:#b54708}.badge.bad{background:#fef3f2;color:#b42318}.empty{padding:34px;text-align:center;color:#667085}.loading{opacity:.55;pointer-events:none}.notice{padding:12px 14px;border-radius:9px;background:#fffaeb;color:#93370d;margin-bottom:14px;display:none}.notice.show{display:block}.mode-select{height:32px;border:1px solid #d0d5dd;border-radius:7px;background:#fff}.pager{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.split{display:grid;grid-template-columns:1.1fr .9fr;gap:14px}.kv{display:grid;grid-template-columns:170px 1fr;gap:8px;font-size:13px;padding:7px 0;border-bottom:1px solid #f2f4f7}.kv:last-child{border-bottom:0}.right{text-align:right}.muted{color:#667085}.skeleton{height:18px;background:linear-gradient(90deg,#f2f4f7,#eaecf0,#f2f4f7);border-radius:6px;animation:pulse 1.2s infinite}@keyframes pulse{50%{opacity:.5}}
@media(max-width:1050px){.layout{grid-template-columns:78px 1fr}.brand{font-size:0}.brand:before{content:"A9";font-size:18px}.brand small,.nav button span{display:none}.nav button{text-align:center}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.split{grid-template-columns:1fr}}
@media(max-width:680px){.layout{display:block}.side{height:auto;position:static}.nav{flex-direction:row;overflow:auto}.nav button{white-space:nowrap}.side-foot{display:none}.grid{grid-template-columns:1fr}.content{padding:14px}.top{padding:0 14px}}
</style>
</head>
<body>
<div class="layout">
<aside class="side">
  <div class="brand">AIGUKA V9<small>Quản trị & Báo cáo</small></div>
  <nav class="nav">
    <button class="active" data-tab="overview">🏠 <span>Tổng quan</span></button>
    <button data-tab="daily">📅 <span>Báo cáo ngày</span></button>
    <button data-tab="leads">👥 <span>Khách hàng / Lead</span></button>
    <button data-tab="ads">📣 <span>Hiệu quả quảng cáo</span></button>
    <button data-tab="admin">⚙️ <span>Quản trị hệ thống</span></button>
  </nav>
  <div class="side-foot">V9 SHADOW · AICAKE customer-facing</div>
</aside>
<main class="main">
<header class="top"><div class="title" id="pageTitle">Tổng quan</div><div class="status"><span class="dot" id="globalDot"></span><span id="globalStatus">Đang kiểm tra…</span></div></header>
<div class="content">
<div class="notice" id="notice"></div>
<section class="panel active" id="panel-overview">
  <div class="grid" id="overviewMetrics"></div>
  <div class="split section">
    <div class="card"><h3>Worker V9</h3><div id="workerList"></div></div>
    <div class="card"><h3>Trạng thái dữ liệu</h3><div id="sourceState"></div></div>
  </div>
  <div class="section"><h3>Page và chế độ vận hành</h3><div class="table-wrap"><table class="table"><thead><tr><th>Page</th><th>Chế độ</th><th>AICAKE</th><th>Canary</th><th>Trạng thái</th><th>Cập nhật</th></tr></thead><tbody id="pageRows"></tbody></table></div></div>
</section>
<section class="panel" id="panel-daily"><div class="toolbar report-toolbar"></div><div class="grid" id="dailyMetrics"></div><div class="section table-wrap"><table class="table"><thead><tr><th>Ngày</th><th>Page</th><th>Tài khoản QC</th><th>Chi tiêu</th><th>Hội thoại</th><th>SĐT/Zalo</th><th>Tỷ lệ lấy số</th><th>Cost/Hội thoại</th><th>Cost/SĐT</th></tr></thead><tbody id="dailyRows"></tbody></table></div></section>
<section class="panel" id="panel-leads"><div class="toolbar report-toolbar"></div><div class="section table-wrap"><table class="table"><thead><tr><th>Khách hàng</th><th>Page</th><th>Giới tính</th><th>SĐT</th><th>Zalo</th><th>Có liên hệ</th><th>Lần đầu</th><th>Gần nhất</th></tr></thead><tbody id="leadRows"></tbody></table></div><div class="pager"><button class="btn" id="leadPrev">Trước</button><button class="btn" id="leadNext">Sau</button></div></section>
<section class="panel" id="panel-ads"><div class="toolbar report-toolbar"></div><div class="section table-wrap"><table class="table"><thead><tr><th>QC</th><th>Chiến dịch</th><th>Nhóm QC</th><th>Tài khoản</th><th>Chi tiêu</th><th>Hội thoại</th><th>SĐT/Zalo</th><th>Tỷ lệ</th><th>Cost/SĐT</th></tr></thead><tbody id="adRows"></tbody></table></div></section>
<section class="panel" id="panel-admin">
 <div class="split"><div class="card"><h3>Cấu hình runtime</h3><div id="runtimeForm"></div></div><div class="card"><h3>Nguyên tắc an toàn</h3><div class="kv"><span>Outbound V9</span><strong>Đang khóa</strong></div><div class="kv"><span>Chế độ tối đa</span><strong>CANARY</strong></div><div class="kv"><span>Bot đang phục vụ</span><strong>AICAKE</strong></div><div class="kv"><span>Dashboard</span><strong>Không đọc bảng realtime</strong></div></div></div>
 <div class="section card"><h3>Công cụ</h3><button class="btn" id="clearCache">Xóa cache quản trị/báo cáo</button> <a class="btn" href="/dashboard">Mở Dashboard V8 hiện tại</a></div>
</section>
</div>
</main>
</div>
<script>
const S={tab:'overview',overview:null,filters:null,leadOffset:0,loading:false};
const T={overview:'Tổng quan',daily:'Báo cáo ngày',leads:'Khách hàng / Lead',ads:'Hiệu quả quảng cáo',admin:'Quản trị hệ thống'};
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function money(v){return new Intl.NumberFormat('vi-VN',{maximumFractionDigits:0}).format(Number(v||0))+' ₫'}
function n(v){return new Intl.NumberFormat('vi-VN').format(Number(v||0))}
function date(v){if(!v)return '-';return new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short'}).format(new Date(v))}
function badge(text,type=''){return '<span class="badge '+type+'">'+esc(text)+'</span>'}
function notice(text){const el=$('#notice');el.textContent=text||'';el.classList.toggle('show',Boolean(text))}
async function api(path,opt={}){const r=await fetch(path,{cache:'no-store',headers:{'content-type':'application/json'},...opt});const d=await r.json().catch(()=>({}));if(!r.ok||d.ok===false){const e=new Error(d.error||('HTTP '+r.status));e.data=d;throw e}return d}
function loading(on){S.loading=on;document.body.classList.toggle('loading',on)}
function healthType(status,stale){if(stale||status==='degraded'||status==='dead_letter')return 'bad';if(status==='healthy'||status==='ready')return 'ok';return 'warn'}
function metric(label,value,note=''){return '<div class="card"><div class="metric-label">'+esc(label)+'</div><div class="metric-value">'+esc(value)+'</div><div class="metric-note">'+esc(note)+'</div></div>'}
async function loadOverview(force=false){
 if(S.overview&&!force){renderOverview(S.overview);return}
 try{loading(true);const d=await api('/api/v9/admin/overview'+(force?'?t='+Date.now():''));S.overview=d;renderOverview(d);notice('')}
 catch(e){notice('Không tải được quản trị V9: '+e.message);$('#globalDot').className='dot bad';$('#globalStatus').textContent='Chưa kết nối Core'}finally{loading(false)}
}
function renderOverview(d){
 const c=d.core||{},jobs=c.jobs||{},pages=c.pages||[];const workers=c.workers||[];
 $('#overviewMetrics').innerHTML=[metric('Page',pages.length,c.runtime?.mode||'Chưa cấu hình'),metric('Job đang chờ',n(jobs.queued||0),'Processing: '+n(jobs.processing||0)),metric('Dead-letter',n(jobs.dead_letter||0),'Cần xử lý thủ công'),metric('Reporting outbox',n(c.reporting_outbox_pending||0),'Chờ đồng bộ báo cáo')].join('');
 const criticalMissing=workers.some(w=>w.status==='missing'||w.stale);$('#globalDot').className='dot '+(c.status==='ready'&&!criticalMissing?'ok':'warn');$('#globalStatus').textContent=c.status==='ready'?(criticalMissing?'Core sẵn sàng · worker chưa đủ':'V9 Core sẵn sàng'):'Thiếu Core credential';
 $('#workerList').innerHTML=workers.length?workers.map(w=>'<div class="kv"><span class="mono">'+esc(w.worker_name)+'</span><span>'+badge(w.status+(w.age_seconds!=null?' · '+w.age_seconds+'s':''),healthType(w.status,w.stale))+(w.last_error?'<div class="muted">'+esc(w.last_error)+'</div>':'')+'</span></div>').join(''):'<div class="empty">Chưa có heartbeat</div>';
 $('#sourceState').innerHTML='<div class="kv"><span>Core</span><strong>'+badge(c.status||'unknown',healthType(c.status))+'</strong></div><div class="kv"><span>AI Knowledge</span><strong>'+badge(d.knowledge?.status||'unknown',healthType(d.knowledge?.status))+'</strong></div><div class="kv"><span>Reporting DB</span><strong>'+badge(d.reporting?.status||'not_configured',healthType(d.reporting?.status))+'</strong></div><div class="kv"><span>Snapshot AI</span><span class="mono">'+esc(d.knowledge?.current_snapshot?.version||'-')+'</span></div><div class="kv"><span>Thời gian API</span><span>'+n(d.elapsed_ms||0)+' ms</span></div>';
 $('#pageRows').innerHTML=pages.length?pages.map(p=>'<tr><td><strong>'+esc(p.page_name||p.page_id)+'</strong><div class="mono muted">'+esc(p.page_id)+'</div></td><td><select class="mode-select" data-page="'+esc(p.page_id)+'">'+['OFF','SUPPORT','SHADOW','CANARY'].map(m=>'<option '+(p.operating_mode===m?'selected':'')+'>'+m+'</option>').join('')+'</select></td><td>'+badge(p.coexistence_mode||'-','warn')+'</td><td>'+n(p.canary_percent||0)+'%</td><td>'+badge(p.is_active?'Đang bật':'Đã tắt',p.is_active?'ok':'')+'</td><td>'+date(p.updated_at)+'</td></tr>').join(''):'<tr><td colspan="6" class="empty">Chưa có Page trong Core</td></tr>';
 $$('.mode-select').forEach(el=>el.onchange=async()=>{const old=el.dataset.old||'';try{el.disabled=true;await api('/api/v9/admin/pages/'+encodeURIComponent(el.dataset.page),{method:'PATCH',body:JSON.stringify({operating_mode:el.value})});S.overview=null;await loadOverview(true)}catch(e){notice('Không đổi được chế độ Page: '+e.message);if(old)el.value=old}finally{el.disabled=false}});
 renderRuntime(c.runtime||{});
}
function renderRuntime(r){$('#runtimeForm').innerHTML='<div class="kv"><span>Chế độ</span><select id="runtimeMode" class="mode-select">'+['OFF','SHADOW','CANARY'].map(m=>'<option '+(r.mode===m?'selected':'')+'>'+m+'</option>').join('')+'</select></div><div class="kv"><span>Gộp lượt khách</span><input id="debounce" type="number" min="5" max="120" value="'+esc(r.debounce_seconds||20)+'"/></div><div class="kv"><span>SLA phản hồi</span><input id="sla" type="number" min="15" max="600" value="'+esc(r.response_sla_seconds||90)+'"/></div><div style="margin-top:12px"><button class="btn primary" id="saveRuntime">Lưu cấu hình</button></div>';const b=$('#saveRuntime');if(b)b.onclick=async()=>{try{b.disabled=true;await api('/api/v9/admin/runtime',{method:'PATCH',body:JSON.stringify({mode:$('#runtimeMode').value,debounce_seconds:Number($('#debounce').value),response_sla_seconds:Number($('#sla').value)})});S.overview=null;await loadOverview(true);notice('Đã lưu runtime V9')}catch(e){notice('Không lưu được runtime: '+e.message)}finally{b.disabled=false}}}
function toolbar(){const today=new Date().toISOString().slice(0,10),from=new Date(Date.now()-6*86400000).toISOString().slice(0,10);return '<label>Từ <input type="date" class="r-from" value="'+from+'"/></label><label>Đến <input type="date" class="r-to" value="'+today+'"/></label><select class="r-page"><option value="">Tất cả Page</option></select><select class="r-account"><option value="">Tất cả tài khoản QC</option></select><button class="btn primary r-load">Tải dữ liệu</button>'}
async function ensureFilters(){if(S.filters)return S.filters;const d=await api('/api/v9/report/filters');S.filters=d.data||{};return S.filters}
async function initToolbar(panel){const el=$('#panel-'+panel+' .report-toolbar');if(!el.dataset.ready){el.innerHTML=toolbar();el.dataset.ready='1';try{const f=await ensureFilters();el.querySelector('.r-page').innerHTML='<option value="">Tất cả Page</option>'+((f.pages||[]).map(x=>'<option value="'+esc(x.page_id)+'">'+esc(x.page_name||x.page_id)+'</option>').join(''));el.querySelector('.r-account').innerHTML='<option value="">Tất cả tài khoản QC</option>'+((f.ad_accounts||[]).map(x=>'<option value="'+esc(x.ad_account_id)+'">'+esc(x.ad_account_name||x.ad_account_id)+'</option>').join(''))}catch(e){notice('Reporting DB chưa sẵn sàng: '+e.message)}el.querySelector('.r-load').onclick=()=>loadReport(panel,true)}return el}
function reportQuery(el){const p=new URLSearchParams({from:el.querySelector('.r-from').value,to:el.querySelector('.r-to').value});const page=el.querySelector('.r-page').value,acc=el.querySelector('.r-account').value;if(page)p.set('page_id',page);if(acc)p.set('ad_account_id',acc);return p}
async function loadReport(panel,force=false){const tb=await initToolbar(panel);const q=reportQuery(tb);if(panel==='leads'){q.set('limit','50');q.set('offset',String(S.leadOffset))}try{loading(true);notice('');if(panel==='daily'){const [sum,data]=await Promise.all([api('/api/v9/report/summary?'+q),api('/api/v9/report/daily?'+q)]);renderDaily(sum.data||{},data.data||[])}else if(panel==='ads'){const d=await api('/api/v9/report/ads?'+q);renderAds(d.data||[])}else if(panel==='leads'){const d=await api('/api/v9/report/leads?'+q);renderLeads(d.data||[])} }catch(e){notice(e.message==='REPORTING_NOT_CONFIGURED'?'Reporting DB riêng chưa được kết nối. Giao diện đã sẵn sàng nhưng không fallback sang RPC V8 chậm.':'Không tải được báo cáo: '+e.message)}finally{loading(false)}}
function renderDaily(s,rows){$('#dailyMetrics').innerHTML=[metric('Chi tiêu',money(s.spend)),metric('Hội thoại',n(s.conversations)),metric('SĐT/Zalo',n(s.contacts),'Tỷ lệ '+n(s.contact_rate)+'%'),metric('Cost/SĐT',money(s.cost_per_contact))].join('');$('#dailyRows').innerHTML=rows.length?rows.map(r=>'<tr><td>'+esc(r.report_date)+'</td><td class="mono">'+esc(r.page_id||'-')+'</td><td class="mono">'+esc(r.ad_account_id||'-')+'</td><td>'+money(r.spend)+'</td><td>'+n(r.conversations)+'</td><td>'+n(r.contacts)+'</td><td>'+n(r.contact_rate)+'%</td><td>'+money(r.cost_per_conversation)+'</td><td>'+money(r.cost_per_contact)+'</td></tr>').join(''):'<tr><td colspan="9" class="empty">Không có dữ liệu</td></tr>'}
function renderAds(rows){const f=S.filters||{},map=new Map((f.ads||[]).map(x=>[x.ad_id,x]));$('#adRows').innerHTML=rows.length?rows.map(r=>{const a=map.get(r.ad_id)||{};return '<tr><td><strong>'+esc(a.ad_name||r.ad_id||'-')+'</strong><div class="mono muted">'+esc(r.ad_id||'')+'</div></td><td>'+esc(a.campaign_name||r.campaign_id||'-')+'</td><td>'+esc(a.adset_name||r.adset_id||'-')+'</td><td>'+esc(a.ad_account_name||r.ad_account_id||'-')+'</td><td>'+money(r.spend)+'</td><td>'+n(r.conversations)+'</td><td>'+n(r.contacts)+'</td><td>'+n(r.contact_rate)+'%</td><td>'+money(r.cost_per_contact)+'</td></tr>'}).join(''):'<tr><td colspan="9" class="empty">Không có dữ liệu</td></tr>'}
function renderLeads(rows){$('#leadRows').innerHTML=rows.length?rows.map(r=>'<tr><td><strong>'+esc(r.display_name||'Khách hàng')+'</strong><div class="mono muted">'+esc(r.customer_id)+'</div></td><td class="mono">'+esc(r.page_id)+'</td><td>'+esc(r.gender||'Chưa rõ')+'</td><td>'+esc(r.phone||'-')+'</td><td>'+esc(r.zalo||'-')+'</td><td>'+badge(r.has_contact?'Có':'Chưa',r.has_contact?'ok':'warn')+'</td><td>'+date(r.first_seen_at)+'</td><td>'+date(r.last_seen_at)+'</td></tr>').join(''):'<tr><td colspan="8" class="empty">Không có dữ liệu</td></tr>'}
async function switchTab(tab){S.tab=tab;$$('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$$('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+tab));$('#pageTitle').textContent=T[tab]||tab;if(tab==='overview'||tab==='admin')await loadOverview();else await loadReport(tab)}
$$('.nav button').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));$('#leadPrev').onclick=()=>{S.leadOffset=Math.max(0,S.leadOffset-50);loadReport('leads',true)};$('#leadNext').onclick=()=>{S.leadOffset+=50;loadReport('leads',true)};$('#clearCache').onclick=async()=>{await api('/api/v9/admin/cache/clear',{method:'POST'});S.overview=null;S.filters=null;notice('Đã xóa cache');await loadOverview(true)};
loadOverview();
</script>
</body></html>`;

export function installV9AdminUi(app) {
  const serve = (_req, res) => {
    res.status(200);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    res.setHeader("x-content-type-options", "nosniff");
    res.send(HTML);
  };
  app.get("/v9", serve);
  app.get("/v9-admin", serve);
  app.get("/v9-dashboard", serve);
}
