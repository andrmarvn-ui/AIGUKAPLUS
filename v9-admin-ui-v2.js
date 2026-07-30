import { installV9AdminUi } from "./v9-admin-ui.js";

const REPORTING_STATUS_SCRIPT = `<script id="aiguka-v9-reporting-status-ui">
(function(){
 const baseOverview=renderOverview;
 renderOverview=function(d){
  baseOverview(d);
  const c=d.core||{},r=d.reporting||{},reportWorkers=Array.isArray(r.heartbeats)?r.heartbeats:[];
  const refresh=reportWorkers.find(x=>x.worker_name==='aiguka-v9-reporting-legacy-refresh')||null;
  const reportReady=r.status==='ready';
  const refreshHealthy=refresh&&refresh.status==='healthy';
  const coreReady=c.status==='ready';
  $('#globalDot').className='dot '+(reportReady&&refreshHealthy?'ok':reportReady?'warn':coreReady?'warn':'bad');
  $('#globalStatus').textContent=reportReady
   ?('Báo cáo V9 sẵn sàng'+(coreReady?' · Core sẵn sàng':' · Core chưa kết nối'))
   :(coreReady?'Core sẵn sàng · Reporting chưa kết nối':'Chưa kết nối dữ liệu V9');
  const coreHtml=$('#workerList').innerHTML;
  const reportHtml=reportWorkers.length
   ?'<div class="kv"><strong>Reporting workers</strong><span></span></div>'+reportWorkers.map(w=>{
      const age=Math.max(0,Math.round((Date.now()-Date.parse(w.last_seen_at||0))/1000));
      const stale=age>900;
      return '<div class="kv"><span class="mono">'+esc(w.worker_name)+'</span><span>'+badge(w.status+' · '+age+'s',healthType(w.status,stale))+(w.worker_version?'<div class="muted">v'+esc(w.worker_version)+'</div>':'')+(w.last_error?'<div class="muted">'+esc(w.last_error)+'</div>':'')+'</span></div>';
    }).join('')
   :'<div class="kv"><span>Reporting worker</span><span>'+badge('Chưa có heartbeat','warn')+'</span></div>';
  $('#workerList').innerHTML=coreHtml+reportHtml;
  const source='<div class="kv"><span>Core</span><strong>'+badge(c.status||'unknown',healthType(c.status))+'</strong></div>'
   +'<div class="kv"><span>AI Knowledge</span><strong>'+badge(d.knowledge?.status||'unknown',healthType(d.knowledge?.status))+'</strong></div>'
   +'<div class="kv"><span>Reporting DB</span><strong>'+badge(r.status||'not_configured',healthType(r.status))+'</strong></div>'
   +'<div class="kv"><span>Reporting host</span><span>'+(r.temporary_host?'Tạm trên Knowledge DB':'Project riêng')+'</span></div>'
   +'<div class="kv"><span>Fact ngày</span><strong>'+n(r.daily_rows||0)+'</strong></div>'
   +'<div class="kv"><span>Khách báo cáo</span><strong>'+n(r.customers||0)+'</strong></div>'
   +'<div class="kv"><span>Refresh worker</span><span>'+(refresh?badge(refresh.status,healthType(refresh.status,false))+' <span class="mono">v'+esc(refresh.worker_version||'-')+'</span>':'-')+'</span></div>'
   +'<div class="kv"><span>Refresh gần nhất</span><span>'+date(refresh?.last_seen_at)+'</span></div>'
   +'<div class="kv"><span>Snapshot AI</span><span class="mono">'+esc(d.knowledge?.current_snapshot?.version_no||'-')+'</span></div>'
   +'<div class="kv"><span>Thời gian API</span><span>'+n(d.elapsed_ms||0)+' ms</span></div>';
  $('#sourceState').innerHTML=source;
 };
 const baseLeads=renderLeads;
 renderLeads=function(rows){
  baseLeads(rows);
  const pageMap=new Map(((S.filters&&S.filters.pages)||[]).map(x=>[x.page_id,x.page_name||x.page_id]));
  const trs=[...document.querySelectorAll('#leadRows tr')];
  (rows||[]).forEach((row,index)=>{
   const tr=trs[index];if(!tr||tr.children.length<2)return;
   tr.children[1].classList.remove('mono');
   tr.children[1].textContent=pageMap.get(row.page_id)||row.page_id||'-';
  });
 };
 if(S.overview)renderOverview(S.overview);
})();
</script>`;

const VAT_BENCHMARK_SCRIPT = `<script id="aiguka-v9-vat-benchmark-ui">
(function(){
 T.benchmark='So sánh AIGUKA / AICAKE';
 const baseLoadReport=loadReport;
 const baseRenderDaily=renderDaily;
 renderDaily=function(s,rows){
  baseRenderDaily(s,rows);
  const spend=Number(s.spend||0),tax=Number(s.tax_amount||spend*0.05),withVat=Number(s.spend_with_tax||spend+tax);
  $('#dailyMetrics').innerHTML=[
   metric('Tổng chi tiêu',money(spend),'Chưa gồm VAT'),
   metric('VAT 5%',money(tax),'Thuế Meta theo cấu hình 5%'),
   metric('Tổng chi tiêu có VAT',money(withVat),'Chi phí thanh toán'),
   metric('Tỷ lệ ra SĐT/Zalo',n(s.contact_rate||0)+'%',n(s.contacts||0)+' / '+n(s.conversations||0)+' hội thoại')
  ].join('');
 };
 async function loadVatDaily(){
  const tb=await initToolbar('daily'),q=reportQuery(tb);
  try{
   loading(true);notice('');
   const [sum,data]=await Promise.all([api('/api/v9/report/summary-vat?'+q),api('/api/v9/report/daily?'+q)]);
   renderDaily(sum.data||{},data.data||[]);
  }catch(e){notice('Không tải được báo cáo: '+e.message)}finally{loading(false)}
 }
 function benchmarkStatusType(status){return status==='complete'||status==='completed'?'ok':status==='timed_out'||status==='degraded'?'bad':'warn'}
 function shortText(value){const text=String(value||'').trim();return text||'-'}
 function renderBenchmark(d){
  const run=d.run||{},p=d.progress||{},rows=d.data||[];
  const aigukaReady=rows.filter(x=>x.aiguka_decision_id||x.aiguka_status).length;
  const actualReplies=rows.filter(x=>x.aicake_reply).length;
  const verifiedAicake=rows.filter(x=>x.comparison&&x.comparison.aicake_source_verified===true).length;
  $('#benchmarkMetrics').innerHTML=[
   metric('Hội thoại đã nhận',n(p.observed||0)+' / '+n(p.target||0),'Bắt đầu 14:16 · ban đầu 0'),
   metric('AIGUKA chạy ngầm',n(aigukaReady),'Không gửi Messenger'),
   metric('AICAKE đã xác minh',n(verifiedAicake),'Theo Botcake/app ID'),
   metric('Phản hồi thực tế đã gửi',n(actualReplies),'Đủ cặp: '+n(p.completed||0)+' · còn '+n(p.remaining||0))
  ].join('');
  $('#benchmarkInfo').innerHTML=run.id
   ?'<div class="kv"><span>Đợt kiểm tra</span><strong>'+esc(run.benchmark_name||run.id)+'</strong></div>'
    +'<div class="kv"><span>Mốc bắt đầu</span><span>'+date(run.started_at)+'</span></div>'
    +'<div class="kv"><span>Trạng thái</span><span>'+badge(run.status||'-',benchmarkStatusType(run.status))+'</span></div>'
    +'<div class="kv"><span>Outbound AIGUKA</span><strong>'+badge(d.transport_locked?'Khóa · chạy ngầm':'Không khóa',d.transport_locked?'ok':'bad')+'</strong></div>'
    +'<div class="kv"><span>Bot trả khách</span><strong>'+esc(d.external_bot_mode||'-')+'</strong></div>'
   :'<div class="empty">Chưa có đợt benchmark</div>';
  $('#benchmarkRows').innerHTML=rows.length?rows.map(r=>{
   const match=r.comparison&&r.comparison.contact_request_match;
   const verified=r.comparison&&r.comparison.aicake_source_verified===true;
   const sourceLabel=verified?'AICAKE đã xác minh':(r.aicake_reply?'Sale/admin hoặc nguồn chưa xác minh':'Chưa có phản hồi');
   const sourceType=verified?'ok':(r.aicake_reply?'warn':'warn');
   const compare=match===true?badge('Khớp xin số','ok'):match===false?badge('Khác cách xin số','warn'):badge('Chờ đủ dữ liệu','warn');
   return '<tr><td><strong>'+n(r.sequence_no)+'</strong></td>'
    +'<td><div class="mono">'+esc(r.page_id)+'</div><div class="mono muted">'+esc(r.sender_id)+'</div><div class="muted">'+date(r.first_customer_at)+'</div></td>'
    +'<td class="reply-cell">'+esc(shortText(r.customer_message))+'</td>'
    +'<td class="reply-cell"><strong>'+esc(r.aiguka_action||r.aiguka_status||'-')+'</strong><div>'+esc(shortText(r.aiguka_reply))+'</div><div class="muted">'+(r.aiguka_latency_ms!=null?n(r.aiguka_latency_ms)+' ms':'')+'</div></td>'
    +'<td class="reply-cell">'+badge(sourceLabel,sourceType)+'<div>'+esc(shortText(r.aicake_reply))+'</div><div class="muted">Nguồn: '+esc(r.aicake_source||'-')+(r.comparison&&r.comparison.observed_actor_app_id?' · app '+esc(r.comparison.observed_actor_app_id):'')+' · '+date(r.aicake_reply_at)+'</div></td>'
    +'<td>'+compare+'<div class="muted">'+esc(r.status||'pending')+'</div></td></tr>';
  }).join(''):'<tr><td colspan="6" class="empty">Chưa có hội thoại mới sau 14:16</td></tr>';
 }
 async function loadBenchmark(){
  try{loading(true);notice('');const d=await api('/api/v9/benchmark/current?t='+Date.now());renderBenchmark(d)}
  catch(e){notice('Không tải được benchmark: '+e.message)}finally{loading(false)}
 }
 loadReport=async function(panel,force=false){
  if(panel==='daily')return loadVatDaily();
  if(panel==='benchmark')return loadBenchmark();
  return baseLoadReport(panel,force);
 };
 setInterval(()=>{if(S.tab==='benchmark')loadBenchmark()},30000);
 if(location.hash==='#benchmark')setTimeout(()=>switchTab('benchmark'),0);
})();
</script>`;

function enhance(html) {
  let output = String(html)
    .replace(
      "<td class=\"mono\">'+esc(r.page_id||'-')+'</td><td class=\"mono\">'+esc(r.ad_account_id||'-')+'</td>",
      "<td>'+esc(r.page_name||r.page_id||'-')+'</td><td>'+esc(r.ad_account_name||r.ad_account_id||'-')+'</td>",
    )
    .replace(
      "Reporting DB riêng chưa được kết nối. Giao diện đã sẵn sàng nhưng không fallback sang RPC V8 chậm.",
      "Reporting DB chưa kết nối. Báo cáo không quay lại RPC V8 chậm.",
    )
    .replace('<button data-tab="admin">⚙️ <span>Quản trị hệ thống</span></button>', '<button data-tab="benchmark">🧪 <span>So sánh AIGUKA/AICAKE</span></button><button data-tab="admin">⚙️ <span>Quản trị hệ thống</span></button>')
    .replace('<th>Chi tiêu</th><th>Hội thoại</th>', '<th>Chi tiêu có VAT</th><th>Hội thoại</th>')
    .replace('<section class="panel" id="panel-admin">', '<section class="panel" id="panel-benchmark"><div class="grid" id="benchmarkMetrics"></div><div class="section card"><h3>Đợt chạy song song</h3><div id="benchmarkInfo"></div></div><div class="section table-wrap"><table class="table" style="min-width:1300px"><thead><tr><th>#</th><th>Hội thoại</th><th>Tin khách mở đầu</th><th>AIGUKA chạy ngầm</th><th>AICAKE / phản hồi thực tế</th><th>Đối chiếu</th></tr></thead><tbody id="benchmarkRows"></tbody></table></div></section><section class="panel" id="panel-admin">');
  output = output.replace('</style>', '.reply-cell{white-space:pre-wrap;min-width:280px;max-width:420px;line-height:1.45}</style>');
  if (!output.includes("aiguka-v9-reporting-status-ui")) output = output.replace("</body>", `${REPORTING_STATUS_SCRIPT}</body>`);
  if (!output.includes("aiguka-v9-vat-benchmark-ui")) output = output.replace("</body>", `${VAT_BENCHMARK_SCRIPT}</body>`);
  return output;
}

export function installV9AdminUiV2(app) {
  const routes = [];
  installV9AdminUi({
    get(path, handler) { routes.push({ path, handler }); },
  });

  for (const { path, handler } of routes) {
    app.get(path, (req, res) => {
      const send = res.send.bind(res);
      res.send = (body) => send(enhance(body));
      return handler(req, res);
    });
  }
}

export const __private__ = { enhance, REPORTING_STATUS_SCRIPT, VAT_BENCHMARK_SCRIPT };