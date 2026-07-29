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

function enhance(html) {
  let output = String(html)
    .replace(
      "<td class=\"mono\">'+esc(r.page_id||'-')+'</td><td class=\"mono\">'+esc(r.ad_account_id||'-')+'</td>",
      "<td>'+esc(r.page_name||r.page_id||'-')+'</td><td>'+esc(r.ad_account_name||r.ad_account_id||'-')+'</td>",
    )
    .replace(
      "Reporting DB riêng chưa được kết nối. Giao diện đã sẵn sàng nhưng không fallback sang RPC V8 chậm.",
      "Reporting DB chưa kết nối. Báo cáo không quay lại RPC V8 chậm.",
    );
  output = output.includes("aiguka-v9-reporting-status-ui")
    ? output
    : output.replace("</body>", `${REPORTING_STATUS_SCRIPT}</body>`);
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

export const __private__ = { enhance, REPORTING_STATUS_SCRIPT };
