const VERSION = "v8_v9_mode_sync_v2";
const WORKER = "aiguka-v8-v9-mode-sync";
const INTERVAL_MS = Math.max(10_000, Number(process.env.AIGUKA_V8_V9_MODE_SYNC_MS || 15_000));

const legacyBase = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const legacyKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const coreBase = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const coreKey = String(
  process.env.AIGUKA_V9_CORE_API_KEY
  || process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY
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
  if (!base || !key) throw new Error("MODE_SYNC_CREDENTIALS_MISSING");
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
  if (!response.ok) throw new Error(data?.message || data?.error || `MODE_SYNC_HTTP_${response.status}`);
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

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function heartbeat(status, details = {}, lastError = null) {
  try {
    await coreRest("v9_worker_heartbeats?on_conflict=worker_name", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        worker_name: WORKER,
        worker_version: VERSION,
        status,
        mode: "SUPPORT_SYNC",
        details,
        last_error: lastError,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
  let primaryPages = 0;
  let changedPages = 0;
  const now = new Date().toISOString();

  for (const legacy of legacyPages || []) {
    const pageId = String(legacy.page_id || "").trim();
    if (!pageId) continue;
    const legacyMode = normalizeLegacyMode(legacy.bot_mode);
    if (legacyMode === "SUPPORT" && legacy.is_active !== false) supportPages += 1;
    if (legacyMode === "ACTIVE" && legacy.is_active !== false) primaryPages += 1;

    const current = coreByPage.get(pageId) || {};
    const support = legacyMode === "SUPPORT";
    const active = legacyMode === "ACTIVE";
    const targetMode = support ? "SUPPORT" : active ? "ACTIVE" : "OFF";
    const targetCoexistence = support ? "AICAKE_ACTIVE" : active ? "AICAKE_DISABLED" : "AICAKE_ACTIVE";
    const targetActive = legacy.is_active !== false && targetMode !== "OFF";
    const settings = {
      ...(current.settings || {}),
      legacy_bot_mode: legacyMode === "ACTIVE" ? "PRODUCTION" : legacyMode,
      migration_source: "v8_pages_continuous_sync",
      primary_bot: support ? "AICAKE" : active ? "AIGUKA" : "AICAKE",
      assistant_bot: support ? "AIGUKA" : null,
      support_enabled: support,
      support_scope: support ? "SLIDE_ONLY" : null,
      live_transport_enabled: targetActive,
      mode_synced_from_v8_at: now,
    };
    if (support && (!current.settings?.support_cutover_at || current.operating_mode !== "SUPPORT")) {
      settings.support_cutover_at = now;
    }
    if (active && (!current.settings?.active_cutover_at || current.operating_mode !== "ACTIVE")) {
      settings.active_cutover_at = now;
    }

    const body = {
      page_name: legacy.page_name || current.page_name || pageId,
      operating_mode: targetMode,
      coexistence_mode: targetCoexistence,
      is_active: targetActive,
      settings,
      updated_at: now,
    };
    const unchanged = current.page_id
      && current.page_name === body.page_name
      && current.operating_mode === body.operating_mode
      && current.coexistence_mode === body.coexistence_mode
      && current.is_active === body.is_active
      && sameJson(current.settings || {}, body.settings || {});
    if (unchanged) continue;

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
  const runtimeBody = {
    external_bot_mode: supportPolicy ? "AICAKE_ACTIVE" : "AICAKE_DISABLED",
    external_bot_policy: supportPolicy ? "AICAKE_PRIMARY_SUPPORT" : "AIGUKA_PRIMARY",
    updated_at: now,
  };
  let runtimeChanged = false;
  if (
    runtime.external_bot_mode !== runtimeBody.external_bot_mode
    || runtime.external_bot_policy !== runtimeBody.external_bot_policy
  ) {
    await coreRest("v9_runtime_config?id=eq.1", {
      method: "PATCH",
      prefer: "return=minimal",
      body: runtimeBody,
    });
    runtimeChanged = true;
  }

  await heartbeat("healthy", {
    source: "v8_pages",
    support_pages: supportPages,
    aiguka_primary_pages: primaryPages,
    changed_pages: changedPages,
    runtime_changed: runtimeChanged,
    external_bot_mode: runtimeBody.external_bot_mode,
    external_bot_policy: runtimeBody.external_bot_policy,
    safety_rule: "SUPPORT wins globally to prevent AIGUKA text interference",
  });
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await syncOnce(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AIGUKA mode sync] ${message}`);
    await heartbeat("degraded", { source: "v8_pages" }, message);
  } finally { running = false; }
}

// Never block Railway HTTP startup on cross-project synchronization. The first
// synchronization runs immediately in the background; subsequent runs retain
// the same interval and single-flight guard.
void tick();
setInterval(() => void tick(), INTERVAL_MS).unref();
console.log(`[AIGUKA mode sync] scheduled non-blocking; V8 page modes -> V9 Core every ${INTERVAL_MS}ms`);
