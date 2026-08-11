import fs from "node:fs";
import { installFollowupAdminV8 } from "./followup-admin-v8.js";

export function installBotControlUi(app, options) {
  installFollowupAdminV8(app); // AIGUKA_FOLLOWUP_ADMIN_V8_EVENT_V1
  const { supabaseUrl, serviceRoleKey, publishableKey } = options;
  const key = serviceRoleKey || publishableKey;
  const coreBase = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
  const coreKey = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
  const headers = (token = key) => ({
    apikey: token,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-aiguka-railway-test": "enabled",
    "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE",
  });

  async function dbRequest(base, token, path, options = {}) {
    if (!base || !token) throw new Error("MISSING_DATABASE_SERVICE_ROLE_KEY");
    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: options.method || "GET",
      headers: { ...headers(token), Prefer: options.prefer || "return=representation" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout || 40000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `REST_HTTP_${response.status}`);
    return data;
  }

  const rest = (path, options = {}) => dbRequest(supabaseUrl, key, path, options);
  const core = (path, options = {}) => dbRequest(coreBase, coreKey, path, options);

  async function rpc(name, args = {}) {
    return rest(`rpc/${name}`, { method: "POST", body: args });
  }

  async function coreRpc(name, args = {}) {
    return core(`rpc/${name}`, { method: "POST", body: args, timeout: 45000 });
  }

  async function mirrorCareFeature(enabled) {
    const settingsRows = await rest("bot_working_settings?select=*&setting_key=eq.default&limit=1");
    const settings = settingsRows?.[0] || {};
    const supportConfig = {
      ...(settings.support_config || {}),
      care_enabled: Boolean(enabled),
      updated_by: "railway_followup_admin",
      updated_at: new Date().toISOString(),
    };
    await rest("bot_working_settings?setting_key=eq.default", {
      method: "PATCH",
      prefer: "return=minimal",
      body: { support_config: supportConfig, updated_at: new Date().toISOString() },
    });

    const runtimeRows = await rest("v8_config_hub?select=*&key=eq.runtime_mode&scope=eq.global&is_active=eq.true&order=updated_at.desc&limit=1");
    const runtime = runtimeRows?.[0];
    if (runtime) {
      await rest(`v8_config_hub?id=eq.${encodeURIComponent(runtime.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          value: {
            ...(runtime.value || {}),
            care_enabled: Boolean(enabled),
            aiguka_can_auto_reply: Boolean(runtime.value?.aiguka_can_send_text || enabled),
          },
          updated_at: new Date().toISOString(),
        },
      });
    }
  }

  app.use("/bot-control", app.json({ limit: "1mb" }));

  app.get("/bot-control/api/state", async (_req, res) => {
    try {
      const [pages, settings, config, capabilities] = await Promise.all([
        rest("v8_pages?select=*&order=page_name.asc"),
        rest("bot_working_settings?select=*&setting_key=eq.default&limit=1"),
        rest("v8_config_hub?select=*&key=eq.runtime_mode&scope=eq.global&is_active=eq.true&order=updated_at.desc&limit=1"),
        rest("v8_page_messaging_capabilities?select=*&order=page_id.asc"),
      ]);
      const enriched = [];
      for (const page of pages || []) {
        let policy = null;
        try {
          const rows = await rpc("v8_resolve_runtime_policy", { p_page_id: page.page_id });
          policy = Array.isArray(rows) ? rows[0] : rows;
        } catch {}
        enriched.push({ ...page, policy });
      }
      res.json({ ok: true, pages: enriched, settings: settings?.[0] || null, runtime: config?.[0] || null, capabilities: capabilities || [] });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/bot-control/api/runtime", async (req, res) => {
    try {
      const body = req.body || {};
      const value = {
        mode: String(body.mode || "OBSERVE").toUpperCase(),
        queue_first: body.queue_first !== false,
        aiguka_can_send_text: Boolean(body.aiguka_can_send_text),
        aiguka_can_send_image: Boolean(body.aiguka_can_send_image),
        aiguka_can_auto_reply: Boolean(body.aiguka_can_auto_reply),
        aiguka_can_create_sale_task: body.aiguka_can_create_sale_task !== false,
        operational_mode: body.operational_mode || null,
        support_slide_only: Boolean(body.support_slide_only),
        meta_is_source_of_truth: true,
        aiguka_can_queue_internal: true,
      };
      const rows = await rest("v8_config_hub?key=eq.runtime_mode&scope=eq.global&is_active=eq.true", {
        method: "PATCH",
        body: { value, updated_at: new Date().toISOString() },
      });
      res.json({ ok: true, data: rows?.[0] || rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/bot-control/api/page-mode", async (req, res) => {
    try {
      const body = req.body || {};
      const data = await rpc("v8_set_runtime_mode", {
        p_page_id: String(body.page_id || ""),
        p_target_mode: String(body.mode || "OBSERVE"),
        p_requested_by: "railway_bot_control",
      });
      res.json({ ok: true, data });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/bot-control/api/features", async (req, res) => {
    try {
      const body = req.body || {};
      const features = {
        text_enabled: body.text_enabled === true,
        slide_enabled: body.slide_enabled === true,
        care_enabled: body.care_enabled === true,
        updated_by: "railway_bot_control_admin",
        updated_at: new Date().toISOString(),
      };
      const settingsRows = await rest("bot_working_settings?select=*&setting_key=eq.default&limit=1");
      const settings = settingsRows?.[0] || {};
      const supportConfig = { ...(settings.support_config || {}), ...features };
      const savedSettings = await rest("bot_working_settings?setting_key=eq.default", {
        method: "PATCH",
        body: { support_config: supportConfig, updated_at: new Date().toISOString() },
      });

      const runtimeRows = await rest("v8_config_hub?select=*&key=eq.runtime_mode&scope=eq.global&is_active=eq.true&order=updated_at.desc&limit=1");
      const runtime = runtimeRows?.[0] || null;
      let savedRuntime = null;
      if (runtime) {
        const value = {
          ...(runtime.value || {}),
          aiguka_can_send_text: features.text_enabled,
          aiguka_can_send_image: features.slide_enabled,
          aiguka_can_auto_reply: features.text_enabled || features.care_enabled,
          care_enabled: features.care_enabled,
          support_slide_only: features.slide_enabled && !features.text_enabled,
          meta_is_source_of_truth: true,
        };
        const rows = await rest(`v8_config_hub?id=eq.${encodeURIComponent(runtime.id)}`, {
          method: "PATCH",
          body: { value, updated_at: new Date().toISOString() },
        });
        savedRuntime = rows?.[0] || null;
      }
      if (coreBase && coreKey) {
        await core("v10_followup_config?id=eq.1", {
          method: "PATCH",
          prefer: "return=minimal",
          body: {
            enabled: features.care_enabled,
            delivery_enabled: features.care_enabled,
            updated_by: "railway_bot_control_admin",
            updated_at: new Date().toISOString(),
          },
        });
      }
      res.json({ ok: true, features, settings: savedSettings?.[0] || null, runtime: savedRuntime });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/bot-control/api/guides", async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.guide_texts || typeof body.guide_texts !== "object" || Array.isArray(body.guide_texts)) {
        throw new Error("NOI_DUNG_HUONG_DAN_KHONG_HOP_LE");
      }
      const clean = (value) => String(value || "").trim().slice(0, 800);
      const guideTexts = {
        on: clean(body.guide_texts.on),
        support: clean(body.guide_texts.support),
        off: clean(body.guide_texts.off),
      };
      const settingsRows = await rest("bot_working_settings?select=*&setting_key=eq.default&limit=1");
      const settings = settingsRows?.[0] || {};
      const supportConfig = {
        ...(settings.support_config || {}),
        guide_texts: guideTexts,
        guide_texts_updated_by: "railway_bot_control_admin",
        guide_texts_updated_at: new Date().toISOString(),
      };
      const rows = await rest("bot_working_settings?setting_key=eq.default", {
        method: "PATCH",
        body: { support_config: supportConfig, updated_at: new Date().toISOString() },
      });
      res.json({ ok: true, guide_texts: guideTexts, settings: rows?.[0] || null });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/bot-control/api/schedule", async (req, res) => {
    try {
      const body = req.body || {};
      const payload = {
        timezone: body.timezone || "Asia/Ho_Chi_Minh",
        work_start: body.work_start || "08:00",
        work_end: body.work_end || "22:00",
        is_open: body.is_open !== false,
        holiday_mode: Boolean(body.holiday_mode),
        staff_online_count: Number(body.staff_online_count || 0),
        admin_pause_minutes: Number(body.admin_pause_minutes || 10),
        customer_wait_minutes: Number(body.customer_wait_minutes || 5),
        working_wait_minutes: Number(body.working_wait_minutes || 5),
        outside_wait_minutes: Number(body.outside_wait_minutes || 5),
        bot_mode: body.bot_mode || "scheduled",
        support_wait_minutes: Number(body.support_wait_minutes || body.working_wait_minutes || 5),
        reply_windows: Array.isArray(body.reply_windows) ? body.reply_windows : [],
        working_windows: Array.isArray(body.working_windows) ? body.working_windows : [],
        after_hours_windows: Array.isArray(body.after_hours_windows) ? body.after_hours_windows : [],
        updated_at: new Date().toISOString(),
      };
      const rows = await rest("bot_working_settings?setting_key=eq.default", { method: "PATCH", body: payload });
      res.json({ ok: true, data: rows?.[0] || rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/bot-control/api/follow-up/state", async (_req, res) => {
    try {
      if (!coreBase || !coreKey) throw new Error("V10_CORE_CONNECTION_NOT_READY");
      const [configRows, heartbeatRows, logs, pages] = await Promise.all([
        core("v10_followup_config?select=*&id=eq.1&limit=1"),
        core("v9_worker_heartbeats?select=worker_name,worker_version,status,mode,details,last_error,last_seen_at,updated_at&worker_name=eq.aiguka-v10-followup&limit=1"),
        core("v10_followup_log?select=*&order=queued_at.desc&limit=200"),
        core("v9_pages?select=page_id,page_name"),
      ]);
      const pageNames = new Map((pages || []).map((page) => [String(page.page_id), page.page_name]));
      const enrichedLogs = (logs || []).map((row) => ({ ...row, page_name: pageNames.get(String(row.page_id)) || null }));
      const pendingStatuses = new Set(["queued", "ai_queued", "ai_processing", "ready_to_send", "retry"]);
      const failedStatuses = new Set(["failed", "ai_failed"]);
      const stats = enrichedLogs.reduce((acc, row) => {
        acc.total += 1;
        if (row.status === "sent") acc.sent += 1;
        if (pendingStatuses.has(row.status)) acc.pending += 1;
        if (row.status === "suppressed") acc.suppressed += 1;
        if (failedStatuses.has(row.status)) acc.failed += 1;
        return acc;
      }, { total: 0, sent: 0, pending: 0, suppressed: 0, failed: 0 });
      res.json({
        ok: true,
        config: configRows?.[0] || null,
        worker: heartbeatRows?.[0] || null,
        stats,
        logs: enrichedLogs.slice(0, 100),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/bot-control/api/follow-up/config", async (req, res) => {
    try {
      if (!coreBase || !coreKey) throw new Error("V10_CORE_CONNECTION_NOT_READY");
      const body = req.body || {};
      const integer = (name, fallback, min, max) => {
        const value = Number(body[name] ?? fallback);
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`FOLLOWUP_${name.toUpperCase()}_INVALID`);
        return value;
      };
      const payload = {
        enabled: body.enabled === true,
        delivery_enabled: body.delivery_enabled === true,
        day_start_hour: integer("day_start_hour", 8, 0, 23),
        evening_start_hour: integer("evening_start_hour", 18, 0, 23),
        day_wait_minutes: integer("day_wait_minutes", 240, 15, 1440),
        evening_wait_minutes: integer("evening_wait_minutes", 120, 15, 1440),
        scan_interval_minutes: integer("scan_interval_minutes", 15, 1, 180),
        max_age_hours: integer("max_age_hours", 20, 1, 23),
        max_per_run: integer("max_per_run", 20, 1, 100),
        text_only: true,
        updated_by: "railway_followup_admin",
        updated_at: new Date().toISOString(),
      };
      if (payload.day_start_hour === payload.evening_start_hour) throw new Error("FOLLOWUP_DAY_AND_EVENING_START_MUST_DIFFER");
      const rows = await core("v10_followup_config?id=eq.1", { method: "PATCH", body: payload });
      await mirrorCareFeature(payload.enabled && payload.delivery_enabled);
      res.json({ ok: true, config: rows?.[0] || null });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/bot-control/api/follow-up/run", async (_req, res) => {
    try {
      if (!coreBase || !coreKey) throw new Error("V10_CORE_CONNECTION_NOT_READY");
      const result = await coreRpc("v10_enqueue_due_followups", { p_limit: null, p_force: true });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/bot-control-client.js", (_req, res) => {
    res.type("application/javascript").send(fs.readFileSync(new URL("./bot-control-client.js", import.meta.url), "utf8"));
  });
  app.get("/follow-up-control-client.js", (_req, res) => {
    res.type("application/javascript").send(fs.readFileSync(new URL("./follow-up-control-client.js", import.meta.url), "utf8"));
  });
  app.get("/bot-control", (_req, res) => {
    res.type("html").send(fs.readFileSync(new URL("./bot-control.html", import.meta.url), "utf8"));
  });
}
