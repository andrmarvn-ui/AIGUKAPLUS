function dashboardHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AIGUKA · Báo cáo vận hành</title>
  <style>
    :root{--bg:#f4f7fb;--panel:#fff;--text:#172b4d;--muted:#667085;--line:#dfe6ef;--primary:#1458e6;--primary2:#0b46c5;--ok:#067647;--warn:#b54708;--bad:#b42318;--shadow:0 12px 34px rgba(16,24,40,.08)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}.app{min-height:100vh}.top{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid var(--line)}
    .top-inner{max-width:1500px;margin:auto;padding:12px 18px;display:flex;align-items:center;gap:16px}.brand{font-weight:800;font-size:18px;white-space:nowrap}.brand small{display:block;font-size:11px;font-weight:600;color:var(--muted);margin-top:2px}.source{margin-left:auto;border:1px solid #a7f3d0;background:#ecfdf3;color:var(--ok);padding:6px 10px;border-radius:999px;font-size:12px;font-weight:800}
    .links{display:flex;gap:6px;overflow:auto;padding:0 18px 10px;max-width:1500px;margin:auto}.links a{color:#344054;text-decoration:none;padding:7px 10px;border-radius:8px;font-size:13px;font-weight:700;white-space:nowrap}.links a:hover{background:#eef4ff;color:var(--primary)}
    main{max-width:1500px;margin:auto;padding:18px}.hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}.hero h1{margin:0;font-size:25px}.hero p{margin:6px 0 0;color:var(--muted);font-size:13px}.status{font-size:12px;font-weight:800;padding:7px 10px;border-radius:999px;background:#fff7ed;color:var(--warn);border:1px solid #fed7aa}.status.ok{background:#ecfdf3;color:var(--ok);border-color:#a7f3d0}.status.bad{background:#fef3f2;color:var(--bad);border-color:#fecdca}
    .filters{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;box-shadow:var(--shadow);display:grid;grid-template-columns:repeat(6,minmax(130px,1fr));gap:10px;margin-bottom:14px}.field label{display:block;font-size:11px;color:var(--muted);font-weight:800;margin-bottom:5px}.field input,.field select{width:100%;height:38px;border:1px solid #cfd8e5;border-radius:8px;background:#fff;padding:0 10px;color:var(--text)}button{height:38px;border:0;border-radius:8px;padding:0 14px;font-weight:800;cursor:pointer}.primary{background:var(--primary);color:#fff}.primary:hover{background:var(--primary2)}.secondary{background:#eef4ff;color:var(--primary)}
    .notice{display:none;margin-bottom:14px;padding:11px 13px;border-radius:10px;border:1px solid #fecaca;background:#fff1f2;color:#991b1b;font-size:13px;font-weight:700}.notice.show{display:block}.tabs{display:flex;gap:8px;overflow:auto;margin-bottom:14px}.tab{background:#fff;border:1px solid var(--line);color:#475467;white-space:nowrap}.tab.active{background:var(--primary);border-color:var(--primary);color:#fff}
    .cards{display:grid;grid-template-columns:repeat(6,minmax(150px,1fr));gap:10px;margin-bottom:14px}.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:14px;box-shadow:var(--shadow)}.card .label{font-size:12px;color:var(--muted);font-weight:700}.card .value{font-size:25px;font-weight:850;margin-top:7px;line-height:1.1}.card .sub{font-size:11px;color:#98a2b3;margin-top:6px}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}.panel-head{padding:13px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}.panel-head strong{font-size:15px}.count{font-size:12px;color:var(--muted)}.table-wrap{overflow:auto;max-height:68vh}table{border-collapse:separate;border-spacing:0;width:100%;min-width:1050px}th,td{padding:10px 11px;border-bottom:1px solid #edf1f6;text-align:left;font-size:12px;vertical-align:top}th{position:sticky;top:0;background:#f8fafc;color:#475467;font-size:11px;text-transform:none;z-index:2}tr:hover td{background:#f9fbff}.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.pill{display:inline-block;padding:3px 7px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:10px;font-weight:800}.pill.hot{background:#fff1f3;color:#c01048}.empty{padding:50px 20px;text-align:center;color:var(--muted)}.loading{opacity:.55;pointer-events:none}
    @media(max-width:1100px){.filters{grid-template-columns:repeat(3,1fr)}.cards{grid-template-columns:repeat(3,1fr)}}@media(max-width:680px){main{padding:12px}.top-inner{padding:10px 12px}.links{padding:0 12px 9px}.hero{display:block}.status{display:inline-block;margin-top:10px}.filters{grid-template-columns:1fr 1fr}.cards{grid-template-columns:1fr 1fr}.hero h1{font-size:21px}}
  </style>
</head>
<body>
<div class="app">
  <header class="top">
    <div class="top-inner"><div class="brand">AIGUKA Dashboard<small>Báo cáo và tổng hợp số liệu vận hành</small></div><div class="source">Nguồn V1 ổn định</div></div>
    <nav class="links"><a href="/dashboard">Báo cáo</a><a href="/mapping-center">Mapping</a><a href="/drive-slides">Drive & Slide</a><a href="/bot-control">Điều khiển Bot</a><a href="/ai-contexts">Ngữ cảnh AI</a><a href="/learning-reviewed">Học từ hội thoại</a><a href="/ai-providers">Kết nối AI</a></nav>
  </header>
  <main>
    <section class="hero"><div><h1 id="pageTitle">Tổng quan báo cáo</h1><p>Giao diện được đóng gói cố định trong Railway; không quay về bản cũ khi Supabase chậm.</p></div><div id="status" class="status">Đang tải dữ liệu…</div></section>
    <div id="notice" class="notice"></div>
    <section class="filters" id="filters">
      <div class="field"><label>Từ ngày</label><input id="from" type="date"></div>
      <div class="field"><label>Đến ngày</label><input id="to" type="date"></div>
      <div class="field"><label>Page</label><select id="page"><option value="">Tất cả Page</option></select></div>
      <div class="field"><label>Tài khoản quảng cáo</label><select id="account"><option value="">Tất cả tài khoản</option></select></div>
      <div class="field"><label>Tìm kiếm</label><input id="search" placeholder="Tên khách, QC, chiến dịch…"></div>
      <div class="field"><label>&nbsp;</label><div style="display:flex;gap:7px"><button id="refresh" class="primary" style="flex:1">Làm mới</button><button id="export" class="secondary" title="Xuất Excel">Excel</button></div></div>
    </section>
    <div class="tabs"><button class="tab active" data-tab="summary">Tổng quan</button><button class="tab" data-tab="daily">Báo cáo ngày</button><button class="tab" data-tab="ads">Hiệu quả quảng cáo</button><button class="tab" data-tab="leads">Khách hàng / Lead</button></div>
    <section id="cards" class="cards"></section>
    <section class="panel"><div class="panel-head"><strong id="tableTitle">Chi tiết</strong><span id="count" class="count"></span></div><div id="content" class="table-wrap"><div class="empty">Đang tải dữ liệu…</div></div></section>
  </main>
</div>
<script>
(function(){
  var state={tab:'summary',loading:false};
  var el=function(id){return document.getElementById(id)};
  var fmt=new Intl.NumberFormat('vi-VN');
  var moneyFmt=new Intl.NumberFormat('vi-VN',{maximumFractionDigits:0});
  function today(offset){var d=new Date();d.setDate(d.getDate()+offset);return d.toISOString().slice(0,10)}
  el('to').value=today(0);el('from').value=today(-6);
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function num(v){var n=Number(v||0);return Number.isFinite(n)?fmt.format(n):'0'}
  function money(v){var n=Number(v||0);return Number.isFinite(n)?moneyFmt.format(n)+' đ':'0 đ'}
  function params(extra){var p=new URLSearchParams({version:'1',from:el('from').value,to:el('to').value,limit:'1000'});if(el('page').value)p.set('page_id',el('page').value);if(el('account').value)p.set('ad_account_id',el('account').value);if(el('search').value)p.set('search',el('search').value);Object.keys(extra||{}).forEach(function(k){p.set(k,extra[k])});return p}
  async function api(action,extra){var p=params(extra);p.set('action',action);var r=await fetch('/functions/v1/aiguka-v8-report-api?'+p.toString(),{cache:'no-store'});var text=await r.text();var data;try{data=JSON.parse(text)}catch(_){data={raw:text}}if(!r.ok||data&&data.ok===false)throw new Error(data.error||data.message||('HTTP '+r.status));return data}
  function rows(payload){if(Array.isArray(payload))return payload;if(Array.isArray(payload&&payload.data))return payload.data;if(Array.isArray(payload&&payload.rows))return payload.rows;if(Array.isArray(payload&&payload.data&&payload.data.rows))return payload.data.rows;return []}
  function dataObject(payload){if(payload&&payload.data&&!Array.isArray(payload.data))return payload.data;return payload||{}}
  function setStatus(ok,text){var s=el('status');s.className='status '+(ok?'ok':'bad');s.textContent=text}
  function notice(text){el('notice').textContent=text||'';el('notice').classList.toggle('show',Boolean(text))}
  function loading(on){state.loading=on;el('filters').classList.toggle('loading',on);el('content').classList.toggle('loading',on);el('refresh').disabled=on}
  function field(o,names){for(var i=0;i<names.length;i++){if(o&&o[names[i]]!=null)return o[names[i]]}return ''}
  function card(label,value,sub){return '<div class="card"><div class="label">'+esc(label)+'</div><div class="value">'+value+'</div><div class="sub">'+esc(sub||'')+'</div></div>'}
  function renderCards(o){
    var conv=field(o,['conversations','conversation_count','customers','customer_count','total_conversations']);
    var contacts=field(o,['contacts','contact_count','phones','phone_count','total_contacts']);
    var spend=field(o,['spend_with_tax','spend','total_spend']);
    var messages=field(o,['message_count','messages','meta_messages']);
    var hot=field(o,['hot_leads','hot_lead_count']);
    var rate=field(o,['contact_rate','phone_rate']);
    el('cards').innerHTML=card('Khách hàng / Hội thoại',num(conv),'Trong khoảng thời gian đã chọn')+card('SĐT / Zalo',num(contacts),'Liên hệ thu được')+card('Chi tiêu gồm thuế',money(spend),'Tổng ngân sách')+card('Tin nhắn',num(messages),'Tin nhắn ghi nhận')+card('Khách nóng',num(hot),'Khách cần ưu tiên')+card('Tỷ lệ lấy số',num(rate)+'%','SĐT/Zalo trên hội thoại');
  }
  function renderGeneric(list){if(!list.length){el('content').innerHTML='<div class="empty">Không có dữ liệu phù hợp.</div>';return}var keys=Object.keys(list[0]).slice(0,14);var h='<table><thead><tr>'+keys.map(function(k){return '<th>'+esc(k)+'</th>'}).join('')+'</tr></thead><tbody>';h+=list.map(function(r){return '<tr>'+keys.map(function(k){return '<td>'+esc(r[k])+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table>';el('content').innerHTML=h}
  function renderDaily(list){
    if(!list.length)return renderGeneric(list);
    var h='<table><thead><tr><th>#</th><th>Ngày</th><th>Page</th><th>Tài khoản QC</th><th class="num">Chi tiêu</th><th class="num">Hội thoại</th><th class="num">SĐT/Zalo</th><th class="num">Tỷ lệ</th><th class="num">Khách nóng</th><th>Nhân viên</th></tr></thead><tbody>';
    h+=list.map(function(x,i){return '<tr><td>'+(i+1)+'</td><td>'+esc(field(x,['report_date','date']))+'</td><td>'+esc(field(x,['page_name','page_id']))+'</td><td>'+esc(field(x,['ad_account_name','account_name','ad_account_id']))+'</td><td class="num">'+money(field(x,['spend_with_tax','spend']))+'</td><td class="num">'+num(field(x,['conversations','customers']))+'</td><td class="num">'+num(field(x,['contacts','phones']))+'</td><td class="num">'+num(field(x,['contact_rate']))+'%</td><td class="num">'+num(field(x,['hot_leads']))+'</td><td>'+esc(field(x,['pancake_employee','employee_name','staff_name']))+'</td></tr>'}).join('');
    el('content').innerHTML=h+'</tbody></table>';
  }
  function renderAds(list){
    if(!list.length)return renderGeneric(list);
    var h='<table><thead><tr><th>#</th><th>Quảng cáo</th><th>Trạng thái</th><th>Tài khoản</th><th>Chiến dịch / Nhóm</th><th class="num">Chi tiêu</th><th class="num">Hội thoại</th><th class="num">SĐT/Zalo</th><th class="num">Tỷ lệ</th><th class="num">Cost/Hội thoại</th><th class="num">Cost/SĐT</th></tr></thead><tbody>';
    h+=list.map(function(x,i){var active=String(field(x,['effective_status','status','ad_status'])).toUpperCase();var status=active==='ACTIVE'||active==='ENABLED'?'Đang bật':(active||'Không rõ');return '<tr><td>'+(i+1)+'</td><td><strong>'+esc(field(x,['ad_name','name','ad_id']))+'</strong><br><span class="muted">'+esc(field(x,['ad_id']))+'</span></td><td><span class="pill">'+esc(status)+'</span></td><td>'+esc(field(x,['ad_account_name','account_name','ad_account_id']))+'</td><td>'+esc(field(x,['campaign_name','campaign_id']))+'<br><span class="muted">'+esc(field(x,['adset_name','adset_id']))+'</span></td><td class="num">'+money(field(x,['spend_with_tax','spend']))+'</td><td class="num">'+num(field(x,['conversations']))+'</td><td class="num">'+num(field(x,['contacts']))+'</td><td class="num">'+num(field(x,['contact_rate']))+'%</td><td class="num">'+money(field(x,['cost_per_conversation']))+'</td><td class="num">'+money(field(x,['cost_per_contact']))+'</td></tr>'}).join('');
    el('content').innerHTML=h+'</tbody></table>';
  }
  function renderLeads(list){
    if(!list.length)return renderGeneric(list);
    var h='<table><thead><tr><th>#</th><th>Khách hàng</th><th>Liên hệ</th><th>Ngày</th><th>Page</th><th>Quảng cáo / Chiến dịch</th><th>Sản phẩm</th><th>Nhân viên</th><th>Trạng thái</th><th>Tin cuối</th></tr></thead><tbody>';
    h+=list.map(function(x,i){var hot=Boolean(field(x,['is_hot_lead','hot_lead']));var contact=[field(x,['phone']),field(x,['zalo'])].filter(Boolean).join(' / ');return '<tr><td>'+(i+1)+'</td><td><strong>'+esc(field(x,['customer_name','name','sender_name']))+'</strong><br><span class="muted">'+esc(field(x,['customer_id','sender_id']))+'</span></td><td>'+esc(contact||'Chưa có')+'</td><td>'+esc(field(x,['report_date','created_date','date']))+'</td><td>'+esc(field(x,['page_name','page_id']))+'</td><td>'+esc(field(x,['ad_name','ad_id']))+'<br><span class="muted">'+esc(field(x,['campaign_name','campaign_id']))+'</span></td><td>'+esc(field(x,['product_label','product_group','product']))+'</td><td>'+esc(field(x,['pancake_employee','employee_name','staff_name']))+'</td><td><span class="pill '+(hot?'hot':'')+'">'+(hot?'Khách nóng':'Đang chăm sóc')+'</span></td><td>'+esc(field(x,['last_snippet','last_message','snippet']))+'</td></tr>'}).join('');
    el('content').innerHTML=h+'</tbody></table>';
  }
  function optionValue(x,type){return field(x,type==='page'?['page_id','id','value']:['ad_account_id','account_id','id','value'])}
  function optionLabel(x,type){return field(x,type==='page'?['page_name','name','label','page_id']:['ad_account_name','account_name','name','label','ad_account_id'])}
  function fillSelect(select,list,type){var current=select.value;var first=type==='page'?'Tất cả Page':'Tất cả tài khoản';select.innerHTML='<option value="">'+first+'</option>'+list.map(function(x){var v=optionValue(x,type),l=optionLabel(x,type)||v;return v?'<option value="'+esc(v)+'">'+esc(l)+'</option>':''}).join('');select.value=current}
  async function loadFilters(){try{var p=await api('filters',{});var f=dataObject(p);fillSelect(el('page'),Array.isArray(f.pages)?f.pages:[],'page');fillSelect(el('account'),Array.isArray(f.ad_accounts)?f.ad_accounts:[],'account')}catch(_){}}
  async function load(){if(state.loading)return;loading(true);notice('');try{
      var summary=await api('summary',{});renderCards(dataObject(summary));
      if(state.tab==='summary'){el('tableTitle').textContent='Tổng hợp theo ngày';var d=rows(await api('daily',{}));renderDaily(d);el('count').textContent=num(d.length)+' dòng';}
      if(state.tab==='daily'){el('tableTitle').textContent='Báo cáo ngày';var daily=rows(await api('daily',{}));renderDaily(daily);el('count').textContent=num(daily.length)+' dòng';}
      if(state.tab==='ads'){el('tableTitle').textContent='Hiệu quả quảng cáo';var ads=rows(await api('ads',{}));renderAds(ads);el('count').textContent=num(ads.length)+' quảng cáo';}
      if(state.tab==='leads'){el('tableTitle').textContent='Khách hàng / Lead';var leads=rows(await api('leads',{}));renderLeads(leads);el('count').textContent=num(leads.length)+' khách';}
      setStatus(true,'Dữ liệu đã kết nối');
    }catch(e){setStatus(false,'Dữ liệu tạm gián đoạn');notice('Không tải được dữ liệu báo cáo: '+(e&&e.message?e.message:String(e))+'. Giao diện vẫn hoạt động; hãy bấm Làm mới sau ít phút.');el('content').innerHTML='<div class="empty">Nguồn dữ liệu đang bận. Giao diện không bị hạ cấp về bản cũ.</div>'}finally{loading(false)}}
  document.querySelectorAll('.tab').forEach(function(b){b.addEventListener('click',function(){state.tab=b.dataset.tab;document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x===b)});var titles={summary:'Tổng quan báo cáo',daily:'Báo cáo ngày',ads:'Hiệu quả quảng cáo',leads:'Khách hàng / Lead'};el('pageTitle').textContent=titles[state.tab];load()})});
  el('refresh').addEventListener('click',load);el('search').addEventListener('keydown',function(e){if(e.key==='Enter')load()});el('export').addEventListener('click',function(){var report=state.tab==='summary'?'daily':state.tab;var p=params({action:'export',report:report});window.location='/functions/v1/aiguka-v8-report-api?'+p.toString()});
  ['from','to','page','account'].forEach(function(id){el(id).addEventListener('change',load)});
  loadFilters().finally(load);
})();
</script>
</body></html>`;
}

export function installStableV7Dashboard(app) {
  const render = (_req, res) => {
    res.status(200);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("pragma", "no-cache");
    res.setHeader("expires", "0");
    res.setHeader("x-aiguka-dashboard-version", "stable-self-contained-v2");
    res.send(dashboardHtml());
  };
  for (const path of ["/", "/dashboard", "/admin-v8", "/v8-dashboard", "/v7-dashboard", "/dashboard-v7", "/reports"]) {
    app.get(path, render);
  }
  app.get("/__aiguka/dashboard-version", (_req, res) => {
    res.json({ ok: true, version: "stable-self-contained-v2", report_default: "v1" });
  });
}
