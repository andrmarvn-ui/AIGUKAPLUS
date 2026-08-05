const VERSION = "v10_mode_compat_v1";
const WORKER = "aiguka-v10-mode-compat";
const INTERVAL_MS = Math.max(30_000, Number(process.env.AIGUKA_V10_MODE_COMPAT_MS || 60_000));

const legacyBase = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const legacyKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const coreBase = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const coreKey = String(
  process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY
  || process.env.AIGUKA_V9_CORE_API_KEY
  || process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY
  || "",
).trim();

function headers(key, prefer = "") {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function rest(base, key, path, options = {}) {
  if (!base || !key) throw new Error("MODE_COMPAT_CREDENTIALS_MISSING");
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: headers(key, options.prefer || ""),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || `MODE_COMPAT_HTTP_${response.status}`);
  return data;
}

const legacyRest = (path, options) => rest(legacyBase, legacyKey, path, options);
const coreRest = (path, options) => rest(coreBase, coreKey, path, options);

function normalizeLegacyMode(value) {
  const mode = String(value || "").trim().toUpperCase();
  if (["SUPPORT", "ASSIST", "SLIDE_ONLY"].includes(mode)) return "SUPPORT";
  if (["PRODUCTION", "ACTIVE", "ON", "100%"].includes(mode)) return "ACTIVE";
  return "OFF";
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function sameJson(a, b) {
  return JSON.stringify(stableJson(a || {})) === JSON.stringify(stableJson(b || {}));
}

function targetForPage(legacy, current = {}) {
  const legacyMode = normalizeLegacyMode(legacy.bot_mode);
  const support = legacyMode === "SUPPORT" && legacy.is_active !== false;
  const active = legacyMode === "ACTIVE" && legacy.is_active !== false;
  const operatingMode = support ? "SUPPORT" : active ? "ACTIVE" : "OFF";
  const coexistenceMode = support ? "AICAKE_ACTIVE" : active ? "AICAKE_DISABLED" : "AICAKE_ACTIVE";
  const isActive = operatingMode !== "OFF";
  const sourceUpdatedAt = legacy.updated_at || null;
  const settings = {
    ...(current.settings || {}),
    legacy_bot_mode: active ? "PRODUCTION" : legacyMode,
    migration_source: "v10_mode_compat_bridge",
    legacy_source_updated_at: sourceUpdatedAt,
    primary_bot: support ? "AICAKE" : active ? "AIGUKA" : "AICAKE",
    assistant_bot: support ? "AIGUKA" : null,
    support_enabled: support,
    support_scope: support ? "SLIDE_ONLY" : null,
    live_transport_enabled: isActive,
  };
  delete settings.mode_synced_from_v8_at;
  return {
    page_name: legacy.page_name || current.page_name || String(legacy.page_id || ""),
    operating_mode: operatingMode,
    coexistence_mode: coexistenceMode,
    is_active: isActive,
    settings,
  };
}

function pageNeedsUpdate(current = {}, target = {}) {
  return !current.page_id
    || current.page_name !== target.page_name
    || current.operating_mode !== target.operating_mode
    || current.coexistence_mode !== target.coexistence_mode
    || current.is_active !== target.is_active
    || !sameJson(current.settings, target.settings);
}

async function heartbeat(status, details = {}, lastError = null) {
  try {
    const now = new Date().toISOString();
    await coreRest("v9_worker_heartbeats?on_conflict=worker_name", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        worker_name: WORKER,
        worker_version: VERSION,
        status,
        mode: "COMPATIBILITY",
        details: { outbound_enabled: false, source: "v8_pages", ...details },
        last_error: lastError,
        last_seen_at: now,
        updated_at: now,
      },
    });
  } catch {}
}

async function syncOnce() {
  const [legacyPages, corePages, runtimeRows] = await Promise.all([
    legacyRest("v8_pages?select=page_id,page_name,bot_mode,is_active,updated_at&order=page_id.asc"),
    coreRest("v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,is_active,settings,updated_at&order=page_id.asc"),
    coreRest("v9_runtime_config?select=*&id=eq.1&limit=1"),
  ]);

  const coreByPage = new Map((corePages || []).map((page) => [String(page.page_id), page]));
  let supportPages = 0;
  let activePages = 0;
  let changedPages = 0;
  const now = new Date().toISOString();

  for (const legacy of legacyPages || []) {
    const pageId = String(legacy.page_id || "").trim();
    if (!pageId) continue;
    const current = coreByPage.get(pageId) || {};
    const target = targetForPage(legacy, current);
    if (target.operating_mode === "SUPPORT") supportPages += 1;
    if (target.operating_mode === "ACTIVE") activePages += 1;
    if (!pageNeedsUpdate(current, target)) continue;

    const body = {
      ...target,
      settings: { ...target.settings, mode_compat_synced_at: now },
      updated_at: now,
    };
    if (current.page_id) {
      await coreRest(`v9_pages?page_id=eq.${encodeURIComponent(pageId)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body,
      });
    } else {
      await coreRest("v9_pages", {
        method: "POST",
        prefer: "return=minimal",
        body: { page_id: pageId, ...body },
      });
    }
    changedPages += 1;
  }

  const runtime = runtimeRows?.[0] || null;
  if (!runtime) throw new Error("V9_RUNTIME_CONFIG_MISSING");
  const supportPolicy = supportPages > 0;
  const runtimeTarget = {
    external_bot_mode: supportPolicy ? "AICAKE_ACTIVE" : "AICAKE_DISABLED",
    external_bot_policy: supportPolicy ? "AICAKE_PRIMARY_SUPPORT" : "AIGUKA_PRIMARY",
  };
  const runtimeChanged = runtime.external_bot_mode !== runtimeTarget.external_bot_mode
    || runtime.external_bot_policy !== runtimeTarget.external_bot_policy;
  if (runtimeChanged) {
    await coreRest("v9_runtime_config?id=eq.1", {
      method: "PATCH",
      prefer: "return=minimal",
      body: { ...runtimeTarget, updated_at: now },
    });
  }

  await heartbeat("healthy", {
    support_pages: supportPages,
    aiguka_primary_pages: activePages,
    changed_pages: changedPages,
    runtime_changed: runtimeChanged,
    external_bot_mode: runtimeTarget.external_bot_mode,
    external_bot_policy: runtimeTarget.external_bot_policy,
    writes_suppressed_when_unchanged: true,
  });
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await syncOnce(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AIGUKA V10 mode compatibility] ${message}`);
    await heartbeat("degraded", {}, message);
  } finally {
    running = false;
  }
}

if (!legacyBase || !legacyKey || !coreBase || !coreKey) {
  console.warn("[AIGUKA V10 mode compatibility] legacy or Core configuration missing; disabled");
} else {
  void tick();
  setInterval(() => void tick(), INTERVAL_MS).unref();
  console.log(`[AIGUKA V10 mode compatibility] non-blocking bridge scheduled every ${INTERVAL_MS}ms`);
}

export const __private__ = { normalizeLegacyMode, targetForPage, pageNeedsUpdate, sameJson };
