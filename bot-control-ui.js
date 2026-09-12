import fs from "node:fs";
import { installFollowupAdminV8 } from "./followup-admin-v8.js";

export function installBotControlUi(app, options = {}) {
  installFollowupAdminV8(app);
  const coreBase = String(process.env.AIGUKA_V9_CORE_URL || options.supabaseUrl || "").replace(/\/$/, "");
  const coreKey = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || options.serviceRoleKey || "");

  function headers(token = coreKey) {
    return {
      apikey: token,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
  }

  async function dbRequest(base, token, path, options = {}) {
    if (!base || !token) throw new Error("V10_CORE_CONNECTION_NOT_READY");
    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: options.method || "GET",
      headers: { ...headers(token), Prefer: options.prefer || "return=representation" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout || 40_000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `REST_HTTP_${response.status}`);
    return data;
  }

  const core = (path, options = {}) => dbRequest(coreBase, coreKey, path, options);
  const coreRpc = (name, args = {}) => core(`rpc/${name}`, { method: "POST", body: args, timeout: 45_000 });
  const now = () => new Date().toISOString();

  function toUiMode(mode) {
    const value = String(mode || "OFF").toUpperCase();
    if (value === "ON") return "PRODUCTION";
    if (value === "SUPPORT") return "OBSERVE";
    return "OFF";
  }

  function toCoreMode(mode) {
    const value = String(mode || "OFF").toUpperCase();
    if (["ON", "LIVE", "PRODUCTION"].includes(value)) return "ON";
    if (["SUPPORT", "OBSERVE", "TEST"].includes(value)) return "SUPPORT";
    if (value === "OFF") return "OFF";
    throw new Error("CHE_DO_PAGE_KHONG_HOP_LE");
  }

  function pagePolicy(page) {
    const mode = String(page.operating_mode || "OFF").toUpperCase();
    const settings = page.settings || {};
    return {
      runtime_mode: mode,
      can_send_text: mode === "ON" && settings.aiguka_text_enabled !== false,
      can_send_image: mode !== "OFF" && settings.aiguka_media_enabled !== false,
      coexistence_mode: page.coexistence_mode || null,
    };
  }

  async function activePages() {
    return core("v9_pages?select=*&is_active=eq.true&order=page_name.asc");
  }

  async function updatePageSettings(page, patch) {
    const settings = { ...(page.settings || {}), ...patch };
    const rows = await core(`v9_pages?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { settings, updated_at: now() },
    });
    return rows?.[0] || { ...page, settings };
  }

  async function mirrorCareFeature(enabled) {
    const pages = await activePages();
    for (const page of pages || []) {
      if (String(page.operating_mode || "OFF").toUpperCase() === "OFF") continue;
      await updatePageSettings(page, { care_enabled: Boolean(enabled) });
    }
  }

  app.use("/bot-control", app.json({ limit: "1mb" }));

  app.get("/bot-control/api/state", async (_req, res) => {
    try {
      const [pages, runtimeRows, followupRows] = await Promise.all([
        activePages(),
        core("v9_runtime_config?select=*&id=eq.1&limit=1"),
        core("v10_followup_config?select=*&id=eq.1&limit=1"),
      ]);
      const runtime = runtimeRows?.[0] || null;
      const followup = followupRows?.[0] || null;
      const primary = (pages || []).find((page) => String(page.operating_mode || "OFF").toUpperCase() !== "OFF") || pages?.[0] || null;
      const primarySettings = primary?.settings || {};
      const schedule = primarySettings.admin_schedule || {};
      const supportConfig = {
        text_enabled: Boolean(primarySettings.aiguka_text_enabled),
        slide_enabled: Boolean(primarySettings.aiguka_media_enabled),
        care_enabled: Boolean(followup?.enabled && followup?.delivery_enabled),
        guide_texts: primarySettings.guide_texts || {},
      };
      const settings = {
        setting_key: "v10_core",
        timezone: schedule.timezone || primary?.timezone || "Asia/Ho_Chi_Minh",
        work_start: schedule.work_start || "08:00",
        work_end: schedule.work_end || "22:00",
        is_open: schedule.is_open !== false,
        holiday_mode: Boolean(schedule.holiday_mode),
        staff_online_count: Number(schedule.staff_online_count || 0),
        support_wait_minutes: Number(schedule.support_wait_minutes || 5),
        reply_windows: Array.isArray(schedule.reply_windows) ? schedule.reply_windows : [],
        support_config: supportConfig,
      };
      const enriched = (pages || []).map((page) => ({
        ...page,
        bot_mode: toUiMode(page.operating_mode),
        webhook_status: String(page.operating_mode || "OFF").toUpperCase() === "OFF" ? "OFF" : "DIRECT_CORE",
        policy: pagePolicy(page),
      }));
      res.json({
        ok: true,
        core: true,
        pages: enriched,
        settings,
        runtime: runtime ? { ...runtime, value: {
          mode: runtime.mode,
          aiguka_can_send_text: supportConfig.text_enabled,
          aiguka_can_send_image: supportConfig.slide_enabled,
          care_enabled: supportConfig.care_enabled,
          meta_is_source_of_truth: true,
        }} : null,
        capabilities: enriched.map((page) => ({
          page_id: page.page_id,
          can_send_text: page.policy.can_send_text,
          can_send_image: page.policy.can_send_image,
          webhook_status: page.webhook_status,
        })),
      });
    } catch (error) {
      console.error("[AIGUKA bot-control state]", error instanceof Error ? error.message : String(error));
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/bot-control/api/runtime", async (req, res) => {
    try {
      const requested = String(req.body?.mode || "ACTIVE").toUpperCase();
      const mode = requested === "OFF" ? "OFF" : "ACTIVE";
      const rows = await core("v9_runtime_config?id=eq.1", {
        method: "PATCH",
        body: { mode, ingest_mode: mode === "OFF" ? "OFF" : "DIRECT_CORE", updated_at: now() },
      });
      res.json({ ok: true, data: rows?.[0] || null });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/bot-control/api/page-mode", async (req, res) => {
    try {
      const pageId = String(req.body?.page_id || "").trim();
      if (!pageId) throw new Error("THIEU_PAGE_ID");
      const mode = toCoreMode(req.body?.mode);
      const currentRows = await core(`v9_pages?select=*&page_id=eq.${encodeURIComponent(pageId)}&limit=1`);
      const current = currentRows?.[0];
      if (!current) throw new Error("KHONG_TIM_THAY_PAGE");
      const settings = {
        ...(current.settings || {}),
        aiguka_text_enabled: mode === "ON",
        aiguka_media_enabled: mode !== "OFF",
        support_text_owner: mode === "SUPPORT" ? "aicake" : current.settings?.support_text_owner || "aiguka",
      };
      const rows = await core(`v9_pages?page_id=eq.${encodeURIComponent(pageId)}`, {
        method: "PATCH",
        body: { operating_mode: mode, settings, updated_at: now() },
      });
      const saved = rows?.[0] || { ...current, operating_mode: mode, settings };
      res.json({
        ok: true,
        data: {
          saved: true,
          changed: String(current.operating_mode || "OFF").toUpperCase() !== mode,
          page_id: pageId,
          previous_page_mode: current.operating_mode || null,
          new_page_mode: mode,
          actual_runtime_mode: mode,
          can_send_text: pagePolicy(saved).can_send_text,
          can_send_image: pagePolicy(saved).can_send_image,
          warnings: [],
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/bot-control/api/features", async (req, res) => {
    try {
      const features = {
        text_enabled: req.body?.text_enabled === true,
        slide_enabled: req.body?.slide_enabled === true,
        care_enabled: req.body?.care_enabled === true,
      };
      const pages = await activePages();
      for (const page of pages || []) {
        if (String(page.operating_mode || "OFF").toUpperCase() === "OFF") continue;
        await updatePageSettings(page, {
          aiguka_text_enabled: features.text_enabled,
          aiguka_media_enabled: features.slide_enabled,
          care_enabled: features.care_enabled,
        });
      }
      await core("v10_followup_config?id=eq.1", {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          enabled: features.care_enabled,
          delivery_enabled: features.care_enabled,
          updated_by: "railway_bot_control_v10",
          updated_at: now(),
        },
      });
      res.json({ ok: true, features });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/bot-control/api/guides", async (req, res) => {
    try {
      const source = req.body?.guide_texts;
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("NOI_DUNG_HUONG_DAN_KHONG_HOP_LE");
      const clean = (value) => String(value || "").trim().slice(0, 800);
      const guideTexts = { on: clean(source.on), support: clean(source.support), off: clean(source.off) };
      const pages = await activePages();
      for (const page of pages || []) await updatePageSettings(page, { guide_texts: guideTexts });
      res.json({ ok: true, guide_texts: guideTexts });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/bot-control/api/schedule", async (req, res) => {
    try {
      const body = req.body || {};
      const schedule = {
        timezone: body.timezone || "Asia/Ho_Chi_Minh",
        work_start: body.work_start || "08:00",
        work_end: body.work_end || "22:00",
        is_open: body.is_open !== false,
        holiday_mode: Boolean(body.holiday_mode),
        staff_online_count: Number(body.staff_online_count || 0),
        support_wait_minutes: Number(body.support_wait_minutes || body.working_wait_minutes || 5),
        reply_windows: Array.isArray(body.reply_windows) ? body.reply_windows : [],
        updated_at: now(),
      };
      const pages = await activePages();
      for (const page of pages || []) await updatePageSettings(page, { admin_schedule: schedule });
      res.json({ ok: true, data: schedule });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/bot-control/api/follow-up/state", async (_req, res) => {
    try {
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
      res.json({ ok: true, config: configRows?.[0] || null, worker: heartbeatRows?.[0] || null, stats, logs: enrichedLogs.slice(0, 100) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/bot-control/api/follow-up/config", async (req, res) => {
    try {
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
        updated_by: "railway_followup_admin_v10",
        updated_at: now(),
      };
      if (payload.day_start_hour === payload.evening_start_hour) throw new Error("FOLLOWUP_DAY_AND_EVENING_START_MUST_DIFFER");
      const rows = await core("v10_followup_config?id=eq.1", { method: "PATCH", body: payload });
      await mirrorCareFeature(payload.enabled && payload.delivery_enabled);
      res.json({ ok: true, config: rows?.[0] || null });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/bot-control/api/follow-up/run", async (_req, res) => {
    try {
      const result = await coreRpc("v10_enqueue_due_followups", { p_limit: null, p_force: true });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
