const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");

async function core(path, options = {}) {
  if (!CORE_BASE || !CORE_KEY) throw new Error("V10_CORE_CONNECTION_NOT_READY");
  const response = await fetch(`${CORE_BASE}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: CORE_KEY,
      authorization: `Bearer ${CORE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 40000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
  return data;
}

function sendHtml(res, html) {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

function integer(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error("FOLLOWUP_NUMBER_INVALID");
  return parsed;
}

function clock(value, fallback) {
  const text = String(value || fallback).slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error("FOLLOWUP_CLOCK_INVALID");
  return text;
}

function stateStats(logs) {
  const pending = new Set(["queued", "ai_queued", "ai_processing", "ready_to_send", "retry"]);
  const failed = new Set(["failed", "ai_failed", "sent_partial"]);
  return (logs || []).reduce((acc, row) => {
    acc.total += 1;
    if (["sent", "sent_partial"].includes(row.status)) acc.sent += 1;
    if (pending.has(row.status)) acc.pending += 1;
    if (row.status === "suppressed") acc.suppressed += 1;
    if (failed.has(row.status)) acc.failed += 1;
    return acc;
  }, { total: 0, sent: 0, pending: 0, suppressed: 0, failed: 0 });
}

function pageHtml() {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIGUKA · Quản trị Follow-up</title>
<style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 20px;background:#fff;border-bottom:1px solid #d8e0ec;position:sticky;top:0;z-index:20}.top h1{font-size:20px;margin:0}.top a{padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;color:#24324a;text-decoration:none;font-weight:750}.wrap{max-width:1250px;margin:0 auto;padding:20px}.card{background:#fff;border:1px solid #d7dfeb;border-radius:12px;padding:16px;margin-bottom:14px}.card h2,.card h3{margin:0 0 8px}.muted{color:#667085}.notice{padding:11px;border:1px solid #93c5fd;background:#eff6ff;border-radius:9px;line-height:1.5}.ok{padding:10px;border:1px solid #86efac;background:#f0fdf4;border-radius:9px}.bad{padding:10px;border:1px solid #fda29b;background:#fef3f2;color:#912018;border-radius:9px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn,button{padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;font-weight:700}.primary{background:#155eef;color:#fff;border-color:#155eef}.danger{color:#b42318}.mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mode-card{display:block;border:2px solid #d7dfeb;border-radius:11px;padding:14px;cursor:pointer}.mode-card.active{border-color:#155eef;background:#f5f8ff}.mode-card input{margin-right:8px}.grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.field{display:flex;flex-direction:column;gap:5px}.field input,.field select,.field textarea{width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;font:inherit}.field textarea{min-height:105px;resize:vertical}.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px;border:1px solid #d7dfeb;border-radius:9px;background:#f8fafc}.switch input{width:22px;height:22px}.event{border:1px solid #cbd5e1;border-radius:11px;padding:13px;margin-top:10px;background:#fafcff}.event-head{display:grid;grid-template-columns:1.4fr .7fr .6fr 90px auto;gap:8px;align-items:end}.event-body{display:grid;grid-template-columns:1.5fr 1fr;gap:10px;margin-top:9px}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.stat{padding:12px;border:1px solid #d7dfeb;border-radius:9px;text-align:center}.stat b{display:block;font-size:23px}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.meta div{padding:9px;background:#f8fafc;border:1px solid #e4e7ec;border-radius:8px}.table{overflow:auto;border:1px solid #d7dfeb;border-radius:9px}.table table{border-collapse:collapse;width:100%;min-width:1050px}.table th,.table td{padding:8px 9px;border-bottom:1px solid #e4e7ec;text-align:left;vertical-align:top}.table th{background:#eef2f7;font-size:12px}.hidden{display:none!important}#toast{position:fixed;right:15px;bottom:15px;padding:10px 14px;border-radius:999px;background:#067647;color:#fff;z-index:50}#toast.fail{background:#b42318}
@media(max-width:850px){.grid,.mode-grid,.event-head,.event-body,.meta{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.wrap{padding:10px}.top{align-items:flex-start}}
</style></head><body>
<header class="top"><div><h1>Follow-up khách hàng · V8 + Event</h1><div class="muted">Tách biệt với luồng BOT trả lời tin chưa được trả lời</div></div><div class="actions"><a href="/admin">Trung tâm quản trị</a><a href="/dashboard">Báo cáo V10</a></div></header>
<main class="wrap">
<section class="notice"><b>Mặc định:</b> quét 3 giờ/lần; lượt 1 được lên lịch sau 3–4 giờ im lặng; lượt 2 sau 6 giờ nếu khách vẫn chưa phản hồi; chỉ gửi từ 08:00 đến 22:30; tối đa 2 lượt trong 20 giờ. Khách có SĐT/Zalo hoặc tag SĐT/Zalo trên Pancake sẽ bị loại.</section>
<section class="card"><div class="actions" style="justify-content:space-between"><div><h2>Trạng thái thực tế</h2><div id="live" class="muted">Đang tải…</div></div><div class="actions"><button id="refresh">Làm mới</button><button id="scan">Yêu cầu quét ngay</button><button id="reset">Khôi phục mặc định V8</button><button id="save" class="primary">Lưu và áp dụng</button></div></div><div class="stats" style="margin-top:12px"><div class="stat"><b id="s-total">0</b>Tổng</div><div class="stat"><b id="s-sent">0</b>Đã gửi</div><div class="stat"><b id="s-pending">0</b>Đang chờ</div><div class="stat"><b id="s-suppressed">0</b>Bỏ qua</div><div class="stat"><b id="s-failed">0</b>Lỗi/thiếu ảnh</div></div><div class="meta"><div>Worker: <b id="worker">—</b></div><div>Heartbeat: <b id="heartbeat">—</b></div><div>Quét cuối: <b id="last-scan">—</b></div><div>Gửi cuối: <b id="last-send">—</b></div></div></section>
<section class="card"><h2>1. Chọn chế độ</h2><div class="mode-grid"><label id="mode-default-card" class="mode-card"><input type="radio" name="mode" value="default_v8"><b>Mặc định V8</b><p>AI đọc lại hội thoại, chăm đúng nhu cầu cũ, không xin số dồn dập và có quyền không gửi.</p></label><label id="mode-event-card" class="mode-card"><input type="radio" name="mode" value="event"><b>Theo Event</b><p>Dùng nội dung quản trị nhập sẵn; có thể kèm ảnh và tạo nhiều ô nội dung.</p></label></div></section>
<section class="card"><h2>2. Lịch và điều kiện chung</h2><div class="grid"><label class="switch"><span><b>Kích hoạt quét</b><br><small>Tìm khách đủ điều kiện</small></span><input id="enabled" type="checkbox"></label><label class="switch"><span><b>Cho phép gửi</b><br><small>Gửi sau chốt an toàn</small></span><input id="delivery" type="checkbox"></label><label class="switch"><span><b>Kiểm tra tag Pancake</b><br><small>Loại tag SĐT/Zalo</small></span><input id="pancake" type="checkbox"></label><div class="field"><label>Quét mỗi (phút)</label><input id="scan-min" type="number" min="1" max="180"></div><div class="field"><label>Bắt đầu gửi</label><input id="window-start" type="time"></div><div class="field"><label>Kết thúc gửi</label><input id="window-end" type="time"></div><div class="field"><label>Lượt 1 sớm nhất (phút)</label><input id="first-min" type="number" min="60" max="1440"></div><div class="field"><label>Lượt 1 muộn nhất (phút)</label><input id="first-max" type="number" min="60" max="1440"></div><div class="field"><label>Cách lượt 2 (phút)</label><input id="repeat-min" type="number" min="60" max="1440"></div><div class="field"><label>Số lượt tối đa</label><input id="max-followups" type="number" min="1" max="5"></div><div class="field"><label>Tuổi hội thoại tối đa (giờ)</label><input id="max-age" type="number" min="1" max="23"></div><div class="field"><label>Tối đa mỗi lần quét</label><input id="max-run" type="number" min="1" max="100"></div></div></section>
<section id="event-section" class="card"><div class="actions" style="justify-content:space-between"><div><h2>3. Nội dung Event</h2><div class="muted">Mỗi ô có thể áp dụng cho lượt 1, lượt 2 hoặc cả hai. URL ảnh/Google Drive: mỗi dòng một ảnh.</div></div><button id="add-event">+ Thêm ô Event</button></div><div id="events"></div></section>
<section class="card"><h2>Lịch sử gần nhất</h2><div class="table"><table><thead><tr><th>Thời gian</th><th>Trang</th><th>Khách</th><th>Lượt</th><th>Chế độ</th><th>Trạng thái</th><th>Lý do</th><th>Nội dung</th></tr></thead><tbody id="logs"></tbody></table></div></section>
</main><div id="toast">Đang kết nối…</div>
<script>
const $=id=>document.getElementById(id); let state=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(text,ok=true){const el=$('toast');el.textContent=text;el.className=ok?'':'fail';}
async function api(url,options={}){const r=await fetch(url,options);const t=await r.text();let j;try{j=t?JSON.parse(t):{};}catch{j={error:t};}if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j;}
function iso(v){if(!v)return '—';try{return new Date(v).toLocaleString('vi-VN',{timeZone:'Asia/Bangkok'});}catch{return String(v);}}
function mode(){return document.querySelector('input[name=mode]:checked')?.value||'default_v8';}
function renderMode(){const m=mode();$('mode-default-card').classList.toggle('active',m==='default_v8');$('mode-event-card').classList.toggle('active',m==='event');$('event-section').classList.toggle('hidden',m!=='event');}
function eventHtml(e={}){const images=Array.isArray(e.image_urls)?e.image_urls.join('\n'):'';const pages=Array.isArray(e.page_ids)?e.page_ids.join(', '):'';return '<div class="event"><div class="event-head"><div class="field"><label>Tên ô Event</label><input class="e-name" value="'+esc(e.event_name||'Nội dung Event')+'"></div><div class="field"><label>Áp dụng</label><select class="e-no"><option value="" '+(e.apply_followup_no==null?'selected':'')+'>Cả hai lượt</option><option value="1" '+(Number(e.apply_followup_no)===1?'selected':'')+'>Lượt 1</option><option value="2" '+(Number(e.apply_followup_no)===2?'selected':'')+'>Lượt 2</option></select></div><div class="field"><label>Thứ tự</label><input class="e-order" type="number" value="'+Number(e.sort_order||100)+'"></div><label class="switch"><span>Bật</span><input class="e-enabled" type="checkbox" '+(e.enabled!==false?'checked':'')+'></label><button class="e-remove danger">Xóa</button></div><div class="event-body"><div class="field"><label>Nội dung tin nhắn</label><textarea class="e-text" maxlength="2000">'+esc(e.message_text||'')+'</textarea></div><div><div class="field"><label>Ảnh kèm theo · mỗi dòng một URL</label><textarea class="e-images">'+esc(images)+'</textarea></div><div class="field" style="margin-top:7px"><label>Page ID áp dụng · để trống là tất cả</label><input class="e-pages" value="'+esc(pages)+'"></div></div></div></div>';}
function addEvent(e={}){$('events').insertAdjacentHTML('beforeend',eventHtml(e));}
function collectEvents(){return [...document.querySelectorAll('.event')].map((row,i)=>({event_name:row.querySelector('.e-name').value.trim()||('Event '+(i+1)),message_text:row.querySelector('.e-text').value.trim(),image_urls:row.querySelector('.e-images').value.split(/\n+/).map(x=>x.trim()).filter(Boolean),page_ids:row.querySelector('.e-pages').value.split(',').map(x=>x.trim()).filter(Boolean),apply_followup_no:row.querySelector('.e-no').value?Number(row.querySelector('.e-no').value):null,sort_order:Number(row.querySelector('.e-order').value||100),enabled:row.querySelector('.e-enabled').checked})).filter(x=>x.message_text);}
function configPayload(){return {mode:mode(),enabled:$('enabled').checked,delivery_enabled:$('delivery').checked,use_pancake_contact_tags:$('pancake').checked,scan_interval_minutes:Number($('scan-min').value),window_start:$('window-start').value,window_end:$('window-end').value,first_wait_min_minutes:Number($('first-min').value),first_wait_max_minutes:Number($('first-max').value),repeat_wait_minutes:Number($('repeat-min').value),max_followups_per_cycle:Number($('max-followups').value),max_age_hours:Number($('max-age').value),max_per_run:Number($('max-run').value)};}
function render(data){state=data;const c=data.config||{};document.querySelector('input[name=mode][value="'+(c.mode||'default_v8')+'"]').checked=true;renderMode();$('enabled').checked=c.enabled!==false;$('delivery').checked=c.delivery_enabled!==false;$('pancake').checked=c.use_pancake_contact_tags!==false;$('scan-min').value=c.scan_interval_minutes??180;$('window-start').value=String(c.window_start||'08:00').slice(0,5);$('window-end').value=String(c.window_end||'22:30').slice(0,5);$('first-min').value=c.first_wait_min_minutes??180;$('first-max').value=c.first_wait_max_minutes??240;$('repeat-min').value=c.repeat_wait_minutes??360;$('max-followups').value=c.max_followups_per_cycle??2;$('max-age').value=c.max_age_hours??20;$('max-run').value=c.max_per_run??20;$('events').innerHTML='';(data.events||[]).forEach(addEvent);if(!(data.events||[]).length)addEvent({apply_followup_no:1});const s=data.stats||{};['total','sent','pending','suppressed','failed'].forEach(k=>$('s-'+k).textContent=s[k]||0);const w=data.worker||{};$('worker').textContent=w.worker_version||'Chưa chạy';$('heartbeat').textContent=iso(w.last_seen_at);$('last-scan').textContent=iso(c.last_scan_at);$('last-send').textContent=iso(c.last_delivery_at);$('live').className=w.status==='healthy'?'ok':'bad';$('live').textContent='Worker '+(w.status||'chưa có')+' · '+(w.mode||'OFF')+' · chế độ '+(c.mode==='event'?'Event':'Mặc định V8')+' · tag Pancake '+(data.guard?.tagged||0)+' khách';$('logs').innerHTML=(data.logs||[]).map(r=>'<tr><td>'+esc(iso(r.queued_at))+'</td><td>'+esc(r.page_name||r.page_id)+'</td><td>'+esc(r.sender_id)+'</td><td>'+esc(r.followup_no||1)+'</td><td>'+esc(r.mode||'default_v8')+'</td><td>'+esc(r.status)+'</td><td>'+esc(r.skip_reason||r.last_error||'')+'</td><td>'+esc(r.final_reply||'')+'</td></tr>').join('');}
async function load(){toast('Đang tải…');try{render(await api('/follow-up-admin/api/state'));toast('Đã kết nối');}catch(e){toast(e.message,false);}}
async function save(){toast('Đang lưu…');try{const payload=configPayload();await api('/follow-up-admin/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});await api('/follow-up-admin/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:collectEvents()})});await load();toast('Đã lưu và áp dụng');}catch(e){toast(e.message,false);}}
$('add-event').onclick=()=>addEvent({sort_order:100});$('events').onclick=e=>{if(e.target.classList.contains('e-remove'))e.target.closest('.event').remove();};document.querySelectorAll('input[name=mode]').forEach(x=>x.onchange=renderMode);$('refresh').onclick=load;$('save').onclick=save;$('scan').onclick=async()=>{try{toast('Đã yêu cầu quét…');await api('/follow-up-admin/api/scan',{method:'POST'});setTimeout(load,1200);}catch(e){toast(e.message,false);}};$('reset').onclick=async()=>{if(!confirm('Khôi phục cấu hình mặc định V8?'))return;try{await api('/follow-up-admin/api/reset',{method:'POST'});await load();toast('Đã khôi phục mặc định V8');}catch(e){toast(e.message,false);}};load();setInterval(load,30000);
</script></body></html>`;
}

export function installFollowupAdminV8(app) {
  app.use("/follow-up-admin", app.json({ limit: "2mb" }));
  app.get("/follow-up-admin", (_req, res) => sendHtml(res, pageHtml()));
  app.get("/follow-up-admin/api/state", async (_req, res) => {
    try {
      const [configRows, eventRows, heartbeatRows, logs, pages, guards] = await Promise.all([
        core("v10_followup_config?select=*&id=eq.1&limit=1"),
        core("v10_followup_events?select=*&order=sort_order.asc,created_at.asc"),
        core("v9_worker_heartbeats?select=*&worker_name=eq.aiguka-v10-followup&limit=1"),
        core("v10_followup_log?select=*&order=queued_at.desc&limit=200"),
        core("v9_pages?select=page_id,page_name"),
        core("v10_followup_contact_guard?select=has_contact_tag,checked_at&order=checked_at.desc&limit=1000"),
      ]);
      const pageNames = new Map((pages || []).map((page) => [String(page.page_id), page.page_name]));
      const enriched = (logs || []).map((row) => ({ ...row, page_name: pageNames.get(String(row.page_id)) || null }));
      res.json({ ok: true, config: configRows?.[0] || null, events: eventRows || [], worker: heartbeatRows?.[0] || null,
        stats: stateStats(enriched), logs: enriched.slice(0, 100), guard: { checked: (guards || []).length,
          tagged: (guards || []).filter((row) => row.has_contact_tag).length, last_checked_at: guards?.[0]?.checked_at || null } });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  app.post("/follow-up-admin/api/config", async (req, res) => {
    try {
      const body = req.body || {}; const mode = ["default_v8", "event"].includes(body.mode) ? body.mode : "default_v8";
      const firstMin = integer(body.first_wait_min_minutes, 180, 60, 1440); const firstMax = integer(body.first_wait_max_minutes, 240, firstMin, 1440);
      const payload = { mode, enabled: body.enabled === true, delivery_enabled: body.delivery_enabled === true, timezone: "Asia/Bangkok",
        window_start: clock(body.window_start, "08:00"), window_end: clock(body.window_end, "22:30"),
        scan_interval_minutes: integer(body.scan_interval_minutes, 180, 1, 180), first_wait_min_minutes: firstMin,
        first_wait_max_minutes: firstMax, repeat_wait_minutes: integer(body.repeat_wait_minutes, 360, 60, 1440),
        max_followups_per_cycle: integer(body.max_followups_per_cycle, 2, 1, 5), max_age_hours: integer(body.max_age_hours, 20, 1, 23),
        max_per_run: integer(body.max_per_run, 20, 1, 100), one_per_conversation_cycle: false, text_only: mode !== "event",
        use_pancake_contact_tags: body.use_pancake_contact_tags !== false, last_scan_at: null,
        updated_by: "followup_admin_v8_event", updated_at: new Date().toISOString() };
      const rows = await core("v10_followup_config?id=eq.1", { method: "PATCH", body: payload }); res.json({ ok: true, config: rows?.[0] || null });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.post("/follow-up-admin/api/events", async (req, res) => {
    try { const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
      const data = await core("rpc/v10_replace_followup_events", { method: "POST", body: { p_events: events, p_updated_by: "followup_admin_v8_event" } });
      res.json({ ok: true, data }); } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.post("/follow-up-admin/api/scan", async (_req, res) => {
    try { await core("v10_followup_config?id=eq.1", { method: "PATCH", prefer: "return=minimal",
      body: { last_scan_at: null, updated_by: "followup_admin_force_scan", updated_at: new Date().toISOString() } });
      res.json({ ok: true, requested: true }); } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  app.post("/follow-up-admin/api/reset", async (_req, res) => {
    try { const rows = await core("v10_followup_config?id=eq.1", { method: "PATCH", body: { mode: "default_v8", enabled: true,
      delivery_enabled: true, timezone: "Asia/Bangkok", window_start: "08:00", window_end: "22:30", scan_interval_minutes: 180,
      first_wait_min_minutes: 180, first_wait_max_minutes: 240, repeat_wait_minutes: 360, max_followups_per_cycle: 2,
      max_age_hours: 20, max_per_run: 20, one_per_conversation_cycle: false, text_only: true, use_pancake_contact_tags: true,
      last_scan_at: null, updated_by: "followup_admin_reset_v8", updated_at: new Date().toISOString() } });
      res.json({ ok: true, config: rows?.[0] || null }); } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
}
