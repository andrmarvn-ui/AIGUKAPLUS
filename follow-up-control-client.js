(() => {
  const byId = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const fmt = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("vi-VN");
  };

  async function api(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || "Phản hồi không hợp lệ" }; }
    if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `HTTP ${response.status}`);
    return data;
  }

  function setMessage(text, ok = true) {
    const node = byId("fu-message");
    if (!node) return;
    node.textContent = text;
    node.className = ok ? "safe" : "notice fu-error";
  }

  function statusLabel(status) {
    const labels = {
      queued: "Đã xếp hàng",
      ai_queued: "Chờ AI",
      ai_processing: "AI đang đọc",
      ready_to_send: "Sẵn sàng gửi",
      sent: "Đã gửi",
      suppressed: "Bỏ qua an toàn",
      retry: "Đang thử lại",
      failed: "Lỗi gửi",
      ai_failed: "AI lỗi",
    };
    return labels[status] || status || "—";
  }

  function render(data) {
    const config = data.config || {};
    const worker = data.worker || {};
    const stats = data.stats || {};
    byId("fu-enabled").checked = config.enabled === true;
    byId("fu-delivery-enabled").checked = config.delivery_enabled === true;
    byId("fu-day-start").value = Number(config.day_start_hour ?? 8);
    byId("fu-evening-start").value = Number(config.evening_start_hour ?? 18);
    byId("fu-day-wait").value = Number(config.day_wait_minutes ?? 240);
    byId("fu-evening-wait").value = Number(config.evening_wait_minutes ?? 120);
    byId("fu-scan-interval").value = Number(config.scan_interval_minutes ?? 15);
    byId("fu-max-age").value = Number(config.max_age_hours ?? 20);
    byId("fu-max-run").value = Number(config.max_per_run ?? 20);

    const active = config.enabled && config.delivery_enabled && worker.status === "healthy";
    byId("fu-live-status").innerHTML = active
      ? "<b>ĐANG HOẠT ĐỘNG</b> — worker khỏe, quét và gửi được bật."
      : `<b>CHƯA HOẠT ĐỘNG ĐẦY ĐỦ</b> — cấu hình: ${config.enabled ? "BẬT" : "TẮT"}, gửi: ${config.delivery_enabled ? "BẬT" : "TẮT"}, worker: ${esc(worker.status || "chưa khởi động")}.`;
    byId("fu-worker-version").textContent = worker.worker_version || "—";
    byId("fu-worker-seen").textContent = fmt(worker.last_seen_at);
    byId("fu-last-scan").textContent = fmt(config.last_scan_at);
    byId("fu-last-delivery").textContent = fmt(config.last_delivery_at);
    byId("fu-stat-total").textContent = Number(stats.total || 0);
    byId("fu-stat-sent").textContent = Number(stats.sent || 0);
    byId("fu-stat-pending").textContent = Number(stats.pending || 0);
    byId("fu-stat-suppressed").textContent = Number(stats.suppressed || 0);
    byId("fu-stat-failed").textContent = Number(stats.failed || 0);

    const rows = data.logs || [];
    byId("fu-log-body").innerHTML = rows.map((row) => `
      <tr>
        <td>${fmt(row.queued_at)}</td>
        <td>${esc(row.period === "daytime" ? "Ban ngày" : "Buổi tối")}</td>
        <td>${esc(row.page_name || row.page_id)}</td>
        <td>${esc(row.sender_id)}</td>
        <td>${esc(statusLabel(row.status))}</td>
        <td>${esc(row.skip_reason || row.last_error || row.final_reply || "—")}</td>
      </tr>`).join("") || '<tr><td colspan="6">Chưa có lượt follow-up.</td></tr>';
  }

  async function load() {
    try {
      const data = await api("/bot-control/api/follow-up/state");
      render(data);
      setMessage("Đã tải trạng thái Follow-up thực tế.");
    } catch (error) {
      setMessage(error.message, false);
    }
  }

  async function save() {
    setMessage("Đang lưu cấu hình Follow-up…");
    try {
      await api("/bot-control/api/follow-up/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: byId("fu-enabled").checked,
          delivery_enabled: byId("fu-delivery-enabled").checked,
          day_start_hour: Number(byId("fu-day-start").value),
          evening_start_hour: Number(byId("fu-evening-start").value),
          day_wait_minutes: Number(byId("fu-day-wait").value),
          evening_wait_minutes: Number(byId("fu-evening-wait").value),
          scan_interval_minutes: Number(byId("fu-scan-interval").value),
          max_age_hours: Number(byId("fu-max-age").value),
          max_per_run: Number(byId("fu-max-run").value),
        }),
      });
      await load();
      setMessage("Đã lưu và áp dụng cấu hình Follow-up.");
    } catch (error) {
      setMessage(error.message, false);
    }
  }

  async function runNow() {
    setMessage("Đang quét khách đủ điều kiện…");
    try {
      const data = await api("/bot-control/api/follow-up/run", { method: "POST" });
      await load();
      const result = data.result || {};
      setMessage(`Đã quét: xem xét ${Number(result.considered || 0)}, tạo ${Number(result.created || 0)} lượt Follow-up.`);
    } catch (error) {
      setMessage(error.message, false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    byId("fu-save")?.addEventListener("click", save);
    byId("fu-run")?.addEventListener("click", runNow);
    byId("fu-refresh")?.addEventListener("click", load);
    load();
    setInterval(load, 15000);
  });
})();
