'use strict';

let state = null;
let dirty = false;

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));

function setToast(text, ok = true) {
  const element = byId('toast');
  element.textContent = text;
  element.className = ok ? '' : 'fail';
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = { error: raw || 'Phản hồi không hợp lệ' }; }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  return payload;
}

function formatDate(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Bangkok' }); }
  catch { return String(value); }
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'default_v8';
}

function eventRows() {
  return [...document.querySelectorAll('#events .event')];
}

function splitLines(value) {
  return String(value || '').split(/\r?\n+/).map((item) => item.trim()).filter(Boolean);
}

function splitPageIds(value) {
  return String(value || '').split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
}

function eventTemplate(event = {}, index = 0) {
  const images = Array.isArray(event.image_urls) ? event.image_urls.join('\n') : '';
  const pages = Array.isArray(event.page_ids) ? event.page_ids.join(', ') : '';
  const waitMinutes = Number(event.wait_minutes ?? (index === 0 ? 180 : 360));
  return `<article class="event" data-event-id="${escapeHtml(event.id || '')}">
    <div class="event-title-row">
      <div>
        <span class="event-number">Lượt Follow-up ${index + 1}</span>
        <div class="event-time-explain muted"></div>
      </div>
      <div class="actions">
        <button type="button" class="e-up" title="Đưa lên trước">↑</button>
        <button type="button" class="e-down" title="Đưa xuống sau">↓</button>
        <button type="button" class="e-remove danger">Xóa Event</button>
      </div>
    </div>
    <div class="event-head">
      <div class="field">
        <label>Tên Event</label>
        <input class="e-name" maxlength="160" value="${escapeHtml(event.event_name || `Event ${index + 1}`)}">
      </div>
      <div class="field">
        <label class="e-wait-label">Thời gian chờ (phút)</label>
        <input class="e-wait" type="number" min="15" max="1200" step="5" value="${waitMinutes}">
      </div>
      <label class="switch compact"><span><b>Kích hoạt</b><br><small>Cho phép gửi lượt này</small></span><input class="e-enabled" type="checkbox" ${event.enabled !== false ? 'checked' : ''}></label>
    </div>
    <div class="event-body">
      <div class="field">
        <label>Nội dung tin nhắn</label>
        <textarea class="e-text" maxlength="2000" placeholder="Nhập nội dung riêng cho lượt Follow-up này">${escapeHtml(event.message_text || '')}</textarea>
      </div>
      <div>
        <div class="field">
          <label>Ảnh kèm theo · mỗi dòng một URL</label>
          <textarea class="e-images" placeholder="https://...">${escapeHtml(images)}</textarea>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Page ID áp dụng · để trống là tất cả</label>
          <input class="e-pages" value="${escapeHtml(pages)}" placeholder="104810069068200">
        </div>
      </div>
    </div>
  </article>`;
}

function renumberEvents() {
  const rows = eventRows();
  rows.forEach((row, index) => {
    row.dataset.eventNo = String(index + 1);
    row.querySelector('.event-number').textContent = `Lượt Follow-up ${index + 1}`;
    row.querySelector('.event-time-explain').textContent = index === 0
      ? 'Tính từ tin trả lời cuối của Page/BOT/Sale.'
      : `Tính từ lúc Event ${index} gửi thành công.`;
    row.querySelector('.e-wait-label').textContent = index === 0
      ? 'Chờ sau tin trả lời cuối (phút)'
      : `Chờ sau Event ${index} (phút)`;
    row.querySelector('.e-up').disabled = index === 0;
    row.querySelector('.e-down').disabled = index === rows.length - 1;
    const name = row.querySelector('.e-name');
    if (!name.value.trim() || /^Event \d+$/.test(name.value.trim())) name.value = `Event ${index + 1}`;
  });
  updateEventSummary();
}

function addEvent(event = {}) {
  const index = eventRows().length;
  byId('events').insertAdjacentHTML('beforeend', eventTemplate(event, index));
  renumberEvents();
  dirty = true;
  const row = eventRows().at(-1);
  row?.querySelector('.e-name')?.focus();
}

function removeEvent(row) {
  row.remove();
  renumberEvents();
  dirty = true;
}

function moveEvent(row, direction) {
  if (direction < 0 && row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling);
  if (direction > 0 && row.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row);
  renumberEvents();
  dirty = true;
}

function collectEvents() {
  return eventRows().map((row, index) => ({
    event_name: row.querySelector('.e-name').value.trim() || `Event ${index + 1}`,
    message_text: row.querySelector('.e-text').value.trim(),
    wait_minutes: Number(row.querySelector('.e-wait').value || (index === 0 ? 180 : 360)),
    image_urls: splitLines(row.querySelector('.e-images').value),
    page_ids: splitPageIds(row.querySelector('.e-pages').value),
    enabled: row.querySelector('.e-enabled').checked,
  })).filter((event) => event.message_text || event.enabled === true);
}

function enabledEvents() {
  return collectEvents().filter((event) => event.enabled);
}

function updateEventSummary() {
  const rows = eventRows();
  const enabled = rows.filter((row) => row.querySelector('.e-enabled').checked);
  const total = enabled.reduce((sum, row) => sum + Number(row.querySelector('.e-wait').value || 0), 0);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const maxMinutes = Number(byId('max-age')?.value || 20) * 60;
  const summary = byId('event-summary');
  if (!summary) return;
  summary.textContent = `${rows.length} Event · ${enabled.length} lượt đang bật · tổng thời gian chờ ${hours} giờ ${minutes} phút`;
  summary.className = total > maxMinutes ? 'bad' : 'ok';
}

function renderMode() {
  const mode = currentMode();
  byId('mode-default-card').classList.toggle('active', mode === 'default_v8');
  byId('mode-event-card').classList.toggle('active', mode === 'event');
  byId('default-v8-settings').classList.toggle('hidden', mode !== 'default_v8');
  byId('event-section').classList.toggle('hidden', mode !== 'event');
}

function configPayload() {
  const eventCount = Math.max(1, enabledEvents().length);
  return {
    mode: currentMode(),
    enabled: byId('enabled').checked,
    delivery_enabled: byId('delivery').checked,
    use_pancake_contact_tags: byId('pancake').checked,
    scan_interval_minutes: Number(byId('scan-min').value || 180),
    window_start: byId('window-start').value,
    window_end: byId('window-end').value,
    first_wait_min_minutes: Number(byId('first-min').value || 180),
    first_wait_max_minutes: Number(byId('first-max').value || 240),
    repeat_wait_minutes: Number(byId('repeat-min').value || 360),
    max_followups_per_cycle: currentMode() === 'event' ? eventCount : 2,
    max_age_hours: Number(byId('max-age').value || 20),
    max_per_run: Number(byId('max-run').value || 20),
  };
}

function validateBeforeSave(config, events) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.window_start || '')) throw new Error('Giờ bắt đầu không hợp lệ');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.window_end || '')) throw new Error('Giờ kết thúc không hợp lệ');
  if (config.mode !== 'event') return;
  const enabled = events.filter((event) => event.enabled);
  if (!enabled.length) throw new Error('Chế độ Event cần ít nhất một Event đang bật');
  for (const [index, event] of events.entries()) {
    if (event.enabled && !event.message_text) throw new Error(`Event ${index + 1} chưa có nội dung`);
    if (!Number.isInteger(event.wait_minutes) || event.wait_minutes < 15 || event.wait_minutes > 1200) {
      throw new Error(`Thời gian Event ${index + 1} phải từ 15 đến 1200 phút`);
    }
    if (event.image_urls.length > 10) throw new Error(`Event ${index + 1} chỉ được tối đa 10 ảnh`);
  }
  const total = enabled.reduce((sum, event) => sum + event.wait_minutes, 0);
  if (total > config.max_age_hours * 60) throw new Error(`Tổng thời gian Event vượt quá ${config.max_age_hours} giờ`);
}

function renderLogs(logs = []) {
  byId('logs').innerHTML = logs.map((row) => `<tr>
    <td>${escapeHtml(formatDate(row.queued_at))}</td>
    <td>${escapeHtml(row.page_name || row.page_id || '')}</td>
    <td>${escapeHtml(row.sender_id || '')}</td>
    <td>${escapeHtml(row.followup_no || 1)}</td>
    <td>${escapeHtml(row.mode || 'default_v8')}</td>
    <td>${escapeHtml(row.status || '')}</td>
    <td>${escapeHtml(row.skip_reason || row.last_error || '')}</td>
    <td>${escapeHtml(row.final_reply || '')}</td>
  </tr>`).join('');
}

function render(data) {
  state = data;
  const config = data.config || {};
  const radio = document.querySelector(`input[name="mode"][value="${config.mode || 'default_v8'}"]`);
  if (radio) radio.checked = true;
  byId('enabled').checked = config.enabled !== false;
  byId('delivery').checked = config.delivery_enabled !== false;
  byId('pancake').checked = config.use_pancake_contact_tags !== false;
  byId('scan-min').value = config.scan_interval_minutes ?? 180;
  byId('window-start').value = String(config.window_start || '08:00').slice(0, 5);
  byId('window-end').value = String(config.window_end || '22:30').slice(0, 5);
  byId('first-min').value = config.first_wait_min_minutes ?? 180;
  byId('first-max').value = config.first_wait_max_minutes ?? 240;
  byId('repeat-min').value = config.repeat_wait_minutes ?? 360;
  byId('max-age').value = config.max_age_hours ?? 20;
  byId('max-run').value = config.max_per_run ?? 20;

  byId('events').innerHTML = '';
  (data.events || []).forEach((event, index) => byId('events').insertAdjacentHTML('beforeend', eventTemplate(event, index)));
  if (!(data.events || []).length && (config.mode || 'default_v8') === 'event') {
    byId('events').insertAdjacentHTML('beforeend', eventTemplate({ event_name: 'Event 1', wait_minutes: 180, enabled: true }, 0));
  }
  renumberEvents();
  renderMode();

  const stats = data.stats || {};
  for (const key of ['total', 'sent', 'pending', 'suppressed', 'failed']) byId(`s-${key}`).textContent = stats[key] || 0;
  const worker = data.worker || {};
  byId('worker').textContent = worker.worker_version || 'Chưa chạy';
  byId('heartbeat').textContent = formatDate(worker.last_seen_at);
  byId('last-scan').textContent = formatDate(config.last_scan_at);
  byId('last-send').textContent = formatDate(config.last_delivery_at);
  byId('live').className = ['healthy', 'idle'].includes(worker.status) ? 'ok' : 'bad';
  byId('live').textContent = `Worker ${worker.status || 'chưa có'} · ${worker.mode || 'OFF'} · chế độ ${config.mode === 'event' ? 'Event' : 'Mặc định V8'} · tag Pancake ${data.guard?.tagged || 0} khách`;
  renderLogs(data.logs || []);
  dirty = false;
}

async function load(force = false) {
  if (dirty && !force) return;
  setToast('Đang tải…');
  try {
    render(await api('/follow-up-admin/api/state'));
    setToast('Đã kết nối');
  } catch (error) {
    setToast(error.message, false);
  }
}

async function save() {
  setToast('Đang lưu…');
  try {
    const config = configPayload();
    const events = collectEvents();
    validateBeforeSave(config, events);
    await api('/follow-up-admin/api/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config, events }),
    });
    dirty = false;
    await load(true);
    setToast('Đã lưu và áp dụng');
  } catch (error) {
    setToast(error.message, false);
  }
}

async function requestScan() {
  try {
    setToast('Đã yêu cầu quét…');
    await api('/follow-up-admin/api/scan', { method: 'POST' });
    setTimeout(() => load(true), 1200);
  } catch (error) {
    setToast(error.message, false);
  }
}

async function resetDefault() {
  if (!window.confirm('Khôi phục cấu hình mặc định V8? Nội dung Event vẫn được giữ lại.')) return;
  try {
    await api('/follow-up-admin/api/reset', { method: 'POST' });
    dirty = false;
    await load(true);
    setToast('Đã khôi phục mặc định V8');
  } catch (error) {
    setToast(error.message, false);
  }
}

function bindEvents() {
  byId('add-event').addEventListener('click', () => {
    const index = eventRows().length;
    addEvent({ event_name: `Event ${index + 1}`, wait_minutes: index === 0 ? 180 : 360, enabled: true });
  });
  byId('events').addEventListener('click', (event) => {
    const row = event.target.closest('.event');
    if (!row) return;
    if (event.target.closest('.e-remove')) removeEvent(row);
    if (event.target.closest('.e-up')) moveEvent(row, -1);
    if (event.target.closest('.e-down')) moveEvent(row, 1);
  });
  byId('events').addEventListener('input', () => { dirty = true; updateEventSummary(); });
  byId('events').addEventListener('change', () => { dirty = true; updateEventSummary(); });
  document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => {
    dirty = true;
    renderMode();
    if (currentMode() === 'event' && !eventRows().length) addEvent({ event_name: 'Event 1', wait_minutes: 180, enabled: true });
  }));
  document.querySelectorAll('#common-settings input, #default-v8-settings input').forEach((input) => input.addEventListener('change', () => {
    dirty = true;
    updateEventSummary();
  }));
  byId('refresh').addEventListener('click', () => load(true));
  byId('save').addEventListener('click', save);
  byId('scan').addEventListener('click', requestScan);
  byId('reset').addEventListener('click', resetDefault);
}

function init() {
  bindEvents();
  load(true);
  setInterval(() => load(false), 30000);
}

document.addEventListener('DOMContentLoaded', init);
