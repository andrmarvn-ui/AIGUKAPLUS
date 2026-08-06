import fs from "node:fs";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const CLIENT_FILE = new URL("./followup-admin-v8-client.js", import.meta.url);

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
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
  return data;
}

function sendHtml(res, html) {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

function sendClient(res) {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("content-type", "application/javascript; charset=utf-8");
  res.status(200).send(fs.readFileSync(CLIENT_FILE, "utf8"));
}

function stateStats(logs) {
  const pending = new Set(["queued", "ai_queued", "ai_processing", "ready_to_send", "retry", "delivery_processing"]);
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

function eventPayload(rows = []) {
  return rows.map((row) => ({
    event_name: row.event_name,
    message_text: row.message_text,
    wait_minutes: row.wait_minutes,
    image_urls: row.image_urls || [],
    page_ids: row.page_ids || [],
    enabled: row.enabled !== false,
  }));
}

function pageHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AIGUKA · Quản trị Follow-up</title>
  <style>
    :root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 20px;background:#fff;border-bottom:1px solid #d8e0ec;position:sticky;top:0;z-index:20}.top h1{font-size:20px;margin:0}.top a{padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;color:#24324a;text-decoration:none;font-weight:750}.wrap{max-width:1250px;margin:0 auto;padding:20px}.card{background:#fff;border:1px solid #d7dfeb;border-radius:12px;padding:16px;margin-bottom:14px}.card h2,.card h3{margin:0 0 8px}.muted{color:#667085}.notice{padding:11px;border:1px solid #93c5fd;background:#eff6ff;border-radius:9px;line-height:1.5}.ok{padding:10px;border:1px solid #86efac;background:#f0fdf4;border-radius:9px}.bad{padding:10px;border:1px solid #fda29b;background:#fef3f2;color:#912018;border-radius:9px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn,button{padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;font-weight:700}.primary{background:#155eef;color:#fff;border-color:#155eef}.danger{color:#b42318}.mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mode-card{display:block;border:2px solid #d7dfeb;border-radius:11px;padding:14px;cursor:pointer}.mode-card.active{border-color:#155eef;background:#f5f8ff}.mode-card input{margin-right:8px}.grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.field{display:flex;flex-direction:column;gap:5px}.field input,.field select,.field textarea{width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;font:inherit}.field textarea{min-height:112px;resize:vertical}.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px;border:1px solid #d7dfeb;border-radius:9px;background:#f8fafc}.switch.compact{min-height:62px}.switch input{width:22px;height:22px}.event{border:1px solid #b8c7dd;border-radius:12px;padding:14px;margin-top:12px;background:#fafcff;box-shadow:0 1px 2px #0f172a0a}.event-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid #e4e7ec}.event-number{display:inline-block;padding:5px 9px;border-radius:999px;background:#155eef;color:#fff;font-size:12px;font-weight:800}.event-time-explain{margin-top:6px;font-size:12px}.event-head{display:grid;grid-template-columns:1.5fr .9fr 1fr;gap:10px;align-items:end;margin-top:11px}.event-body{display:grid;grid-template-columns:1.5fr 1fr;gap:10px;margin-top:10px}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.stat{padding:12px;border:1px solid #d7dfeb;border-radius:9px;text-align:center}.stat b{display:block;font-size:23px}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.meta div{padding:9px;background:#f8fafc;border:1px solid #e4e7ec;border-radius:8px}.table{overflow:auto;border:1px solid #d7dfeb;border-radius:9px}.table table{border-collapse:collapse;width:100%;min-width:1050px}.table th,.table td{padding:8px 9px;border-bottom:1px solid #e4e7ec;text-align:left;vertical-align:top}.table th{background:#eef2f7;font-size:12px}.hidden{display:none!important}#toast{position:fixed;right:15px;bottom:15px;padding:10px 14px;border-radius:999px;background:#067647;color:#fff;z-index:50}#toast.fail{background:#b42318}button:disabled{opacity:.45;cursor:not-allowed}
    @media(max-width:850px){.grid,.mode-grid,.event-head,.event-body,.meta{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.wrap{padding:10px}.top,.event-title-row{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <header class="top">
    <div><h1>Follow-up khách hàng · V8 + Event</h1><div class="muted">Tách biệt với luồng BOT trả lời tin chưa được trả lời</div></div>
    <div class="actions"><a href="/admin">Trung tâm quản trị</a><a href="/dashboard">Báo cáo V10</a></div>
  </header>
  <main class="wrap">
    <section class="notice"><b>Mặc định V8:</b> quét 3 giờ/lần, hai lượt trong 20 giờ. <b>Event:</b> mỗi ô Event chính là một lượt Follow-up độc lập; Event 1 tính thời gian từ tin trả lời cuối, Event sau tính từ lúc Event trước gửi thành công. Chỉ gửi trong 08:00–22:30 và luôn loại khách đã có SĐT/Zalo hoặc tag liên hệ trên Pancake.</section>

    <section class="card">
      <div class="actions" style="justify-content:space-between">
        <div><h2>Trạng thái thực tế</h2><div id="live" class="muted">Đang tải…</div></div>
        <div class="actions"><button id="refresh" type="button">Làm mới</button><button id="scan" type="button">Yêu cầu quét ngay</button><button id="reset" type="button">Khôi phục mặc định V8</button><button id="save" type="button" class="primary">Lưu và áp dụng</button></div>
      </div>
      <div class="stats" style="margin-top:12px"><div class="stat"><b id="s-total">0</b>Tổng</div><div class="stat"><b id="s-sent">0</b>Đã gửi</div><div class="stat"><b id="s-pending">0</b>Đang chờ</div><div class="stat"><b id="s-suppressed">0</b>Bỏ qua</div><div class="stat"><b id="s-failed">0</b>Lỗi/thiếu ảnh</div></div>
      <div class="meta"><div>Worker: <b id="worker">—</b></div><div>Heartbeat: <b id="heartbeat">—</b></div><div>Quét cuối: <b id="last-scan">—</b></div><div>Gửi cuối: <b id="last-send">—</b></div></div>
    </section>

    <section class="card">
      <h2>1. Chọn chế độ</h2>
      <div class="mode-grid">
        <label id="mode-default-card" class="mode-card"><input type="radio" name="mode" value="default_v8"><b>Mặc định V8</b><p>AI đọc lại hội thoại, chăm đúng nhu cầu cũ, không xin số dồn dập và có quyền không gửi.</p></label>
        <label id="mode-event-card" class="mode-card"><input type="radio" name="mode" value="event"><b>Theo Event</b><p>Mỗi Event là một lượt Follow-up có thời gian, nội dung và ảnh riêng.</p></label>
      </div>
    </section>

    <section id="common-settings" class="card">
      <h2>2. Lịch và điều kiện chung</h2>
      <div class="grid">
        <label class="switch"><span><b>Kích hoạt quét</b><br><small>Tìm khách đủ điều kiện</small></span><input id="enabled" type="checkbox"></label>
        <label class="switch"><span><b>Cho phép gửi</b><br><small>Gửi sau chốt an toàn</small></span><input id="delivery" type="checkbox"></label>
        <label class="switch"><span><b>Kiểm tra tag Pancake</b><br><small>Loại tag SĐT/Zalo</small></span><input id="pancake" type="checkbox"></label>
        <div class="field"><label>Quét mỗi (phút)</label><input id="scan-min" type="number" min="1" max="180"></div>
        <div class="field"><label>Bắt đầu gửi</label><input id="window-start" type="time"></div>
        <div class="field"><label>Kết thúc gửi</label><input id="window-end" type="time"></div>
        <div class="field"><label>Tuổi hội thoại tối đa (giờ)</label><input id="max-age" type="number" min="1" max="23"></div>
        <div class="field"><label>Tối đa mỗi lần quét</label><input id="max-run" type="number" min="1" max="100"></div>
      </div>
    </section>

    <section id="default-v8-settings" class="card">
      <h2>3. Thời gian mặc định V8</h2>
      <div class="grid">
        <div class="field"><label>Lượt 1 sớm nhất (phút)</label><input id="first-min" type="number" min="60" max="1440"></div>
        <div class="field"><label>Lượt 1 muộn nhất (phút)</label><input id="first-max" type="number" min="60" max="1440"></div>
        <div class="field"><label>Chờ trước lượt 2 (phút)</label><input id="repeat-min" type="number" min="60" max="1440"></div>
      </div>
    </section>

    <section id="event-section" class="card">
      <div class="actions" style="justify-content:space-between;align-items:flex-start">
        <div><h2>3. Chuỗi Event Follow-up</h2><div class="muted">Thêm một Event là thêm đúng một lượt Follow-up. Có thể đổi thứ tự bằng nút ↑ ↓.</div></div>
        <button id="add-event" type="button" class="primary">+ Thêm Event mới</button>
      </div>
      <div id="event-summary" class="ok" style="margin-top:10px">0 Event</div>
      <div id="events"></div>
    </section>

    <section class="card">
      <h2>Lịch sử gần nhất</h2>
      <div class="table"><table><thead><tr><th>Thời gian</th><th>Trang</th><th>Khách</th><th>Lượt</th><th>Chế độ</th><th>Trạng thái</th><th>Lý do</th><th>Nội dung</th></tr></thead><tbody id="logs"></tbody></table></div>
    </section>
  </main>
  <div id="toast">Đang kết nối…</div>
  <script defer src="/follow-up-admin/client.js?v=3"></script>
</body>
</html>`;
}

export function installFollowupAdminV8(app) {
  app.use("/follow-up-admin", app.json({ limit: "2mb" }));
  app.get("/follow-up-admin", (_req, res) => sendHtml(res, pageHtml()));
  app.get("/follow-up-admin/client.js", (_req, res) => sendClient(res));

  app.get("/follow-up-admin/api/state", async (_req, res) => {
    try {
      const [configRows, eventRows, heartbeatRows, logs, pages, guards, guardWorkerRows] = await Promise.all([
        core("v10_followup_config?select=*&id=eq.1&limit=1"),
        core("v10_followup_events?select=*&order=event_no.asc,created_at.asc"),
        core("v9_worker_heartbeats?select=*&worker_name=eq.aiguka-v10-followup&limit=1"),
        core("v10_followup_log?select=*&order=queued_at.desc&limit=200"),
        core("v9_pages?select=page_id,page_name"),
        core("v10_followup_contact_guard?select=has_contact_tag,checked_at&order=checked_at.desc&limit=1000"),
        core("v9_worker_heartbeats?select=*&worker_name=eq.aiguka-v10-pancake-contact-guard&limit=1"),
      ]);
      const pageNames = new Map((pages || []).map((page) => [String(page.page_id), page.page_name]));
      const enriched = (logs || []).map((row) => ({ ...row, page_name: pageNames.get(String(row.page_id)) || null }));
      res.json({
        ok: true,
        config: configRows?.[0] || null,
        events: eventRows || [],
        worker: heartbeatRows?.[0] || null,
        guard_worker: guardWorkerRows?.[0] || null,
        stats: stateStats(enriched),
        logs: enriched.slice(0, 100),
        guard: {
          checked: (guards || []).length,
          tagged: (guards || []).filter((row) => row.has_contact_tag).length,
          last_checked_at: guards?.[0]?.checked_at || null,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/follow-up-admin/api/apply", async (req, res) => {
    try {
      const config = req.body?.config;
      const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 20) : [];
      const data = await core("rpc/v10_apply_followup_admin", {
        method: "POST",
        timeout: 45000,
        body: { p_config: config, p_events: events, p_updated_by: "followup_admin_event_sequence_v3" },
      });
      res.json({ ok: true, data });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/follow-up-admin/api/config", async (req, res) => {
    try {
      const rows = await core("v10_followup_events?select=*&order=event_no.asc,created_at.asc");
      const data = await core("rpc/v10_apply_followup_admin", {
        method: "POST",
        timeout: 45000,
        body: { p_config: req.body || {}, p_events: eventPayload(rows), p_updated_by: "followup_admin_config_compat_v3" },
      });
      res.json({ ok: true, data });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/follow-up-admin/api/events", async (req, res) => {
    try {
      const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 20) : [];
      const data = await core("rpc/v10_replace_followup_events", {
        method: "POST",
        timeout: 45000,
        body: { p_events: events, p_updated_by: "followup_admin_events_compat_v3" },
      });
      res.json({ ok: true, data });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/follow-up-admin/api/scan", async (_req, res) => {
    try {
      await core("v10_followup_config?id=eq.1", {
        method: "PATCH",
        prefer: "return=minimal",
        body: { last_scan_at: null, updated_by: "followup_admin_force_scan_v3", updated_at: new Date().toISOString() },
      });
      res.json({ ok: true, requested: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/follow-up-admin/api/reset", async (_req, res) => {
    try {
      const rows = await core("v10_followup_events?select=*&order=event_no.asc,created_at.asc");
      const config = {
        mode: "default_v8",
        enabled: true,
        delivery_enabled: true,
        use_pancake_contact_tags: true,
        scan_interval_minutes: 180,
        window_start: "08:00",
        window_end: "22:30",
        first_wait_min_minutes: 180,
        first_wait_max_minutes: 240,
        repeat_wait_minutes: 360,
        max_followups_per_cycle: 2,
        max_age_hours: 20,
        max_per_run: 20,
      };
      const data = await core("rpc/v10_apply_followup_admin", {
        method: "POST",
        timeout: 45000,
        body: { p_config: config, p_events: eventPayload(rows), p_updated_by: "followup_admin_reset_v8_v3" },
      });
      res.json({ ok: true, data });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}
