import { buildSupportOperationalFallback, supportFallbackCustomerAt } from "./v10/core/support-operational-fallback.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-primary-provider-fallback";
const VERSION = "v10_primary_provider_starvation_fallback_v1";
const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_V10_PRIMARY_FALLBACK_POLL_MS || 3000));
const SCAN_LIMIT = Math.max(20, Math.min(200, Number(process.env.AIGUKA_V10_PRIMARY_FALLBACK_SCAN_LIMIT || 120)));
const BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.AIGUKA_V10_PRIMARY_FALLBACK_BATCH || 10)));
const MIN_ASSETS = Math.max(1, Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_MIN_CATALOG_ASSETS || 5));
const RESPONSE_WINDOW_MS = 23 * 60 * 60_000;
let running = false;
let timer;
let knowledgeCache = { expiresAt: 0, keys: new Set() };

function configured() {
  return Boolean(CORE_BASE && CORE_KEY && KNOWLEDGE_BASE && KNOWLEDGE_KEY);
}

async function request(base, key, path, options = {}) {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 20000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`);
  return data;
}

const core = (path, options = {}) => request(CORE_BASE, CORE_KEY, path, options);
const knowledge = (path, options = {}) => request(KNOWLEDGE_BASE, KNOWLEDGE_KEY, path, options);

async function runtime() {
  const rows = await core("v9_runtime_config?select=mode,ingest_mode,response_sla_seconds,external_bot_mode,external_bot_policy&id=eq.1&limit=1", { timeout: 10000 });
  return rows?.[0] || { mode: "OFF" };
}

async function pages() {
  return core("v9_pages?select=page_id,operating_mode,coexistence_mode,is_active,settings&is_active=eq.true", { timeout: 10000 });
}

async function stateRow(pageId, senderId) {
  const rows = await core(
    `v9_conversation_state?select=last_source_event_id,last_customer_event_at,last_page_event_at,human_takeover,human_takeover_until&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&limit=1`,
    { timeout: 10000 },
  );
  return rows?.[0] || null;
}

async function availableSlideKeys() {
  if (knowledgeCache.expiresAt > Date.now()) return knowledgeCache.keys;
  const configs = await knowledge("ai_runtime_config?select=published_snapshot_id,mode&id=eq.1&limit=1", { timeout: 10000 });
  const config = configs?.[0];
  if (!config?.published_snapshot_id || String(config.mode || "").toUpperCase() === "OFF") {
    throw new Error("PRIMARY_FALLBACK_KNOWLEDGE_NOT_PUBLISHED");
  }
  const rows = await knowledge(`ai_published_snapshots?select=content&id=eq.${encodeURIComponent(config.published_snapshot_id)}&status=eq.published&limit=1`, { timeout: 15000 });
  const nodes = Array.isArray(rows?.[0]?.content?.catalog) ? rows[0].content.catalog : [];
  const keys = new Set(nodes
    .filter((node) => Array.isArray(node?.assets) && node.assets.length >= MIN_ASSETS)
    .map((node) => String(node?.catalog_key || "").trim())
    .filter(Boolean));
  knowledgeCache = { expiresAt: Date.now() + 60_000, keys };
  return keys;
}

function waitMs(config = {}) {
  const configuredSeconds = Number(process.env.AIGUKA_V10_PRIMARY_PROVIDER_FALLBACK_SECONDS || 90);
  return Math.max(90_000, configuredSeconds * 1000, Number(config.response_sla_seconds || 45) * 1000);
}

function primaryRuntime(config = {}) {
  return String(config.mode || "").toUpperCase() === "ACTIVE"
    && String(config.ingest_mode || "").toUpperCase() === "DIRECT_CORE"
    && String(config.external_bot_mode || "").toUpperCase() === "AICAKE_DISABLED"
    && String(config.external_bot_policy || "").toUpperCase() === "AIGUKA_PRIMARY";
}

function fallbackPageEnabled(page = {}) {
  return page.is_active === true
    && String(page.operating_mode || "").toUpperCase() === "ACTIVE"
    && String(page.coexistence_mode || "").toUpperCase() === "AICAKE_DISABLED"
    && page?.settings?.support_operational_fallback_enabled === true;
}

function humanTakeoverActive(state = {}) {
  if (state?.human_takeover !== true) return false;
  const until = Date.parse(state?.human_takeover_until || "");
  return !Number.isFinite(until) || until > Date.now();
}

function currentUnansweredFrontier(row, state, customerAt) {
  if (!state || customerAt <= 0) return false;
  if (humanTakeoverActive(state)) return false;
  const lastCustomerAt = Date.parse(state.last_customer_event_at || "");
  const lastPageAt = Date.parse(state.last_page_event_at || "");
  if (!Number.isFinite(lastCustomerAt)) return false;
  if (Number.isFinite(lastPageAt) && lastPageAt >= lastCustomerAt) return false;
  if (String(state.last_source_event_id || "") && String(row.source_event_id || "")
      && String(state.last_source_event_id) !== String(row.source_event_id)) return false;
  if (lastCustomerAt > customerAt + 1000) return false;
  return true;
}

async function heartbeat(status, details = {}, error = null) {
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: "AIGUKA_PRIMARY_EMERGENCY_FALLBACK",
      details: {
        ...details,
        provider_independent: true,
        deterministic_safe_fallback: true,
        only_when_provider_wait: true,
        current_unanswered_frontier_only: true,
      },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function complete(row, plan, customerAt, fallbackWaitMs) {
  const now = new Date().toISOString();
  const status = plan.kind === "suppress" ? "shadow_suppressed" : "shadow_ai_completed";
  const claimed = await core(`v9_decisions?id=eq.${encodeURIComponent(row.id)}&status=eq.shadow_context_ready&output->>provider_wait_reason=eq.NO_AI_PROVIDER_CURRENTLY_AVAILABLE`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status,
      action: plan.action,
      confidence: plan.kind === "suppress" ? 1 : 0.95,
      output: {
        ...(row.output || {}),
        action: plan.action,
        confidence: plan.kind === "suppress" ? 1 : 0.95,
        final_reply: plan.final_reply,
        should_send: plan.kind !== "suppress",
        needs_slides: plan.needs_slides,
        selected_products: plan.selected_products,
        selected_catalog_keys: plan.selected_catalog_keys,
        should_request_contact: plan.should_request_contact,
        transport_locked: plan.kind === "suppress",
        operational_primary_provider_fallback: plan.kind !== "suppress",
        operational_support_fallback: plan.kind !== "suppress",
        operational_support_fallback_enabled: true,
        primary_provider_fallback_reason: plan.reason,
        primary_provider_fallback_customer_at: new Date(customerAt).toISOString(),
        primary_provider_fallback_due_at: new Date(customerAt + fallbackWaitMs).toISOString(),
        primary_provider_fallback_created_at: now,
        provider_wait_resolved_by: "deterministic_primary_fallback",
        suppression_reason: plan.kind === "suppress" ? plan.reason : null,
      },
      updated_at: now,
    },
  });
  return claimed?.[0] || null;
}

async function tick() {
  if (!configured() || running) return;
  running = true;
  let scanned = 0;
  let due = 0;
  let completed = 0;
  let suppressed = 0;
  let stale = 0;
  try {
    const config = await runtime();
    if (!primaryRuntime(config)) {
      await heartbeat("idle", { enabled: false, reason: "runtime_not_aiguka_primary" });
      return;
    }

    const enabledPages = new Set((await pages())
      .filter(fallbackPageEnabled)
      .map((page) => String(page.page_id)));
    if (!enabledPages.size) {
      await heartbeat("idle", { enabled: false, reason: "no_active_primary_page_enabled" });
      return;
    }

    const since = encodeURIComponent(new Date(Date.now() - RESPONSE_WINDOW_MS).toISOString());
    const fields = "id,source_event_id,page_id,sender_id,mode,status,goal,action,confidence,input_snapshot,output,created_at,updated_at";
    const [rows, slideKeys] = await Promise.all([
      core(`v9_decisions?select=${fields}&status=eq.shadow_context_ready&output->>provider_wait_reason=eq.NO_AI_PROVIDER_CURRENTLY_AVAILABLE&created_at=gte.${since}&order=created_at.asc&limit=${SCAN_LIMIT}`),
      availableSlideKeys(),
    ]);
    scanned = rows?.length || 0;
    const fallbackWaitMs = waitMs(config);
    const nowMs = Date.now();
    const candidates = [];

    for (const row of rows || []) {
      if (!enabledPages.has(String(row.page_id))) continue;
      if (row?.input_snapshot?.architecture !== "v10_ai_hard_commerce") continue;
      const customerAt = supportFallbackCustomerAt(row.input_snapshot);
      if (customerAt <= 0 || nowMs - customerAt < fallbackWaitMs || nowMs - customerAt > RESPONSE_WINDOW_MS) continue;
      const state = await stateRow(row.page_id, row.sender_id);
      if (!currentUnansweredFrontier(row, state, customerAt)) {
        stale += 1;
        continue;
      }
      candidates.push({ row, customerAt });
      if (candidates.length >= BATCH_SIZE) break;
    }
    due = candidates.length;

    for (const { row, customerAt } of candidates) {
      const plan = buildSupportOperationalFallback(row.input_snapshot, slideKeys);
      const result = await complete(row, plan, customerAt, fallbackWaitMs);
      if (!result) continue;
      if (plan.kind === "suppress") suppressed += 1;
      else completed += 1;
    }

    await heartbeat("healthy", {
      enabled: true,
      wait_seconds: Math.round(fallbackWaitMs / 1000),
      scanned,
      due,
      completed,
      suppressed,
      stale,
      available_slide_catalogs: slideKeys.size,
    });
  } catch (error) {
    await heartbeat("degraded", { scanned, due, completed, suppressed, stale }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!configured()) {
  console.warn("[AIGUKA V10 primary provider fallback] Core/Knowledge credentials missing; disabled");
} else {
  console.log(`[AIGUKA V10 primary provider fallback] ${VERSION} started; provider-starvation no-drop guard enabled`);
  tick().catch(() => {});
}
