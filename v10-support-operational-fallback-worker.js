import { buildSupportOperationalFallback, supportFallbackCustomerAt } from "./v10/core/support-operational-fallback.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-support-failover";
const VERSION = "v10_support_failover_v4_recover_customer_media_reask";
const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_POLL_MS || 3000));
const MIN_ASSETS = Math.max(1, Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_MIN_CATALOG_ASSETS || 5));
const SCAN_LIMIT = Math.max(20, Math.min(200, Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_SCAN_LIMIT || 100)));
const BATCH_SIZE = Math.max(1, Math.min(30, Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_BATCH || 15)));
const RECOVERY_CLONE_AFTER_MS = Math.max(30 * 60_000, Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_CLONE_AFTER_MS || 90 * 60_000));
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

async function supportPages() {
  return core("v9_pages?select=page_id,operating_mode,coexistence_mode,is_active,settings&is_active=eq.true", { timeout: 10000 });
}

async function availableSlideKeys() {
  if (knowledgeCache.expiresAt > Date.now()) return knowledgeCache.keys;
  const configs = await knowledge("ai_runtime_config?select=published_snapshot_id,mode&id=eq.1&limit=1", { timeout: 10000 });
  const config = configs?.[0];
  if (!config?.published_snapshot_id || String(config.mode || "").toUpperCase() === "OFF") throw new Error("SUPPORT_FALLBACK_KNOWLEDGE_NOT_PUBLISHED");
  const rows = await knowledge(`ai_published_snapshots?select=content&id=eq.${encodeURIComponent(config.published_snapshot_id)}&status=eq.published&limit=1`, { timeout: 15000 });
  const nodes = Array.isArray(rows?.[0]?.content?.catalog) ? rows[0].content.catalog : [];
  const keys = new Set(nodes
    .filter((node) => Array.isArray(node?.assets) && node.assets.length >= MIN_ASSETS)
    .map((node) => String(node?.catalog_key || "").trim())
    .filter(Boolean));
  knowledgeCache = { expiresAt: Date.now() + 60_000, keys };
  return keys;
}

function fallbackWaitMs(config = {}) {
  const configuredSeconds = Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_SECONDS || 90);
  return Math.max(60_000, configuredSeconds * 1000, (Number(config.response_sla_seconds || 45) + 30) * 1000);
}

async function completeWithFallback(row, plan, customerAt, waitMs) {
  const now = new Date().toISOString();
  const body = {
    status: plan.kind === "suppress" ? "shadow_suppressed" : "shadow_ai_completed",
    action: plan.action,
    confidence: plan.kind === "suppress" ? 1 : 0.95,
    output: {
      ...(row.output || {}),
      action: plan.action,
      confidence: plan.kind === "suppress" ? 1 : 0.95,
      final_reply: plan.final_reply,
      should_send: plan.kind !== "suppress",
      needs_slides: plan.needs_slides,
      support_mode: true,
      selected_products: plan.selected_products,
      selected_catalog_keys: plan.selected_catalog_keys,
      should_request_contact: plan.should_request_contact,
      transport_locked: plan.kind === "suppress",
      operational_support_fallback: plan.kind !== "suppress",
      operational_support_fallback_enabled: true,
      support_fallback_reason: plan.reason,
      support_fallback_customer_at: new Date(customerAt).toISOString(),
      support_fallback_due_at: new Date(customerAt + waitMs).toISOString(),
      support_fallback_created_at: now,
      suppression_reason: plan.kind === "suppress" ? plan.reason : null,
    },
    updated_at: now,
  };
  if (plan.kind !== "suppress" && Date.now() - Date.parse(row.created_at || "") >= RECOVERY_CLONE_AFTER_MS) {
    const recoverySource = `${row.source_event_id || row.id}:support_fallback_recovery_v1`;
    const inserted = await core("v9_decisions?on_conflict=source_event_id", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=representation",
      body: {
        source_event_id: recoverySource,
        page_id: row.page_id,
        sender_id: row.sender_id,
        mode: row.mode || "ACTIVE",
        status: body.status,
        goal: row.goal || "ai_sovereign_customer_assistance",
        action: body.action,
        confidence: body.confidence,
        input_snapshot: row.input_snapshot,
        output: {
          ...body.output,
          support_fallback_recovery_clone: true,
          support_fallback_recovery_of_decision_id: row.id,
        },
        created_at: now,
        updated_at: now,
      },
    });
    let clone = inserted?.[0] || null;
    if (!clone) {
      const existing = await core(`v9_decisions?select=id,status,action,output,created_at,updated_at&source_event_id=eq.${encodeURIComponent(recoverySource)}&limit=1`);
      clone = existing?.[0] || null;
    }
    if (!clone) return null;
    await core(`v9_decisions?id=eq.${encodeURIComponent(row.id)}&status=eq.${encodeURIComponent(row.status)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_suppressed",
        action: "superseded_by_support_fallback_recovery",
        output: {
          ...(row.output || {}),
          should_send: false,
          transport_locked: true,
          suppression_reason: "support_fallback_recovery_clone_created",
          support_fallback_recovery_clone_id: clone.id,
        },
        updated_at: now,
      },
    });
    return clone;
  }

  const claimed = await core(`v9_decisions?id=eq.${encodeURIComponent(row.id)}&status=eq.${encodeURIComponent(row.status)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body,
  });
  return claimed?.[0] || null;
}

async function recoverDuplicateMediaSuppression(row, plan, customerAt, waitMs) {
  if (plan.kind !== "media") return null;
  const now = new Date().toISOString();
  const recoverySource = `${row.source_event_id || row.id}:support_media_dedupe_recovery_v1`;
  const inserted = await core("v9_decisions?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: {
      source_event_id: recoverySource,
      page_id: row.page_id,
      sender_id: row.sender_id,
      mode: row.mode || "ACTIVE",
      status: "shadow_ai_completed",
      goal: row.goal || "ai_sovereign_customer_assistance",
      action: plan.action,
      confidence: 0.99,
      input_snapshot: row.input_snapshot,
      output: {
        ...(row.output || {}),
        action: plan.action,
        confidence: 0.99,
        final_reply: plan.final_reply,
        should_send: true,
        needs_slides: true,
        support_mode: true,
        selected_products: plan.selected_products,
        selected_catalog_keys: plan.selected_catalog_keys,
        should_request_contact: plan.should_request_contact,
        transport_locked: false,
        operational_support_fallback: true,
        operational_support_fallback_enabled: true,
        live_suppression_reason: null,
        support_fallback_reason: plan.reason,
        support_fallback_customer_at: new Date(customerAt).toISOString(),
        support_fallback_due_at: new Date(customerAt + waitMs).toISOString(),
        support_fallback_created_at: now,
        support_media_dedupe_recovery: true,
        support_media_dedupe_recovery_of_decision_id: row.id,
      },
      created_at: now,
      updated_at: now,
    },
  });
  let clone = inserted?.[0] || null;
  if (!clone) {
    const existing = await core(`v9_decisions?select=id,status,action,output,created_at,updated_at&source_event_id=eq.${encodeURIComponent(recoverySource)}&limit=1`);
    clone = existing?.[0] || null;
  }
  if (!clone) return null;
  await core(`v9_decisions?id=eq.${encodeURIComponent(row.id)}&status=eq.live_suppressed`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      output: {
        ...(row.output || {}),
        support_media_dedupe_recovery_attempted: true,
        support_media_dedupe_recovery_clone_id: clone.id,
        support_media_dedupe_recovery_at: now,
      },
      updated_at: now,
    },
  });
  return clone;
}

async function heartbeat(status, details = {}, error = null) {
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: "SUPPORT_FAILOVER",
      details: {
        ...details,
        deterministic_safe_fallback: true,
        aicake_silence_verified_at_outbound: true,
        provider_independent: true,
      },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function tick() {
  if (!configured() || running) return;
  running = true;
  let scanned = 0;
  let due = 0;
  let completed = 0;
  let suppressed = 0;
  try {
    const config = await runtime();
    const active = String(config.mode || "").toUpperCase() === "ACTIVE"
      && String(config.ingest_mode || "").toUpperCase() === "DIRECT_CORE"
      && String(config.external_bot_mode || "").toUpperCase() === "AICAKE_ACTIVE"
      && String(config.external_bot_policy || "").toUpperCase() === "AICAKE_PRIMARY_SUPPORT";
    if (!active) {
      await heartbeat("idle", { enabled: false, reason: "runtime_not_in_aicake_support" });
      return;
    }

    const pages = await supportPages();
    const enabledPages = new Set((pages || [])
      .filter((page) => String(page.operating_mode || "").toUpperCase() === "SUPPORT")
      .filter((page) => String(page.coexistence_mode || "").toUpperCase() === "AICAKE_ACTIVE")
      .filter((page) => page?.settings?.support_operational_fallback_enabled === true)
      .map((page) => String(page.page_id)));
    if (!enabledPages.size) {
      await heartbeat("idle", { enabled: false, reason: "no_support_page_enabled" });
      return;
    }

    const decisionFields = "id,source_event_id,page_id,sender_id,mode,status,goal,action,confidence,input_snapshot,output,created_at,updated_at";
    const recoverySince = encodeURIComponent(new Date(Date.now() - RESPONSE_WINDOW_MS).toISOString());
    const [pendingRows, mediaOnlyRows, duplicateMediaRows, slideKeys] = await Promise.all([
      core(`v9_decisions?select=${decisionFields}&status=in.(shadow_context_ready,shadow_ai_error)&created_at=gte.${recoverySince}&order=created_at.asc&limit=${SCAN_LIMIT}`),
      core(`v9_decisions?select=${decisionFields}&status=eq.live_suppressed&output->>live_suppression_reason=eq.SUPPORT_MEDIA_ONLY&created_at=gte.${recoverySince}&order=created_at.asc&limit=${SCAN_LIMIT}`),
      core(`v9_decisions?select=${decisionFields}&status=eq.live_suppressed&output->>live_suppression_reason=eq.DUPLICATE_MEDIA_SCOPE_24H&created_at=gte.${recoverySince}&order=created_at.asc&limit=${SCAN_LIMIT}`),
      availableSlideKeys(),
    ]);
    const rows = [...(pendingRows || []), ...(mediaOnlyRows || []), ...(duplicateMediaRows || [])]
      .sort((a, b) => Date.parse(a.created_at || "") - Date.parse(b.created_at || ""));
    scanned = rows?.length || 0;
    const waitMs = fallbackWaitMs(config);
    const nowMs = Date.now();
    const candidates = (rows || []).filter((row) => {
      if (!enabledPages.has(String(row.page_id))) return false;
      if (row?.input_snapshot?.architecture !== "v10_ai_sovereign_advisory") return false;
      if (row.status === "live_suppressed") {
        const reason = row?.output?.live_suppression_reason;
        if (!["SUPPORT_MEDIA_ONLY", "DUPLICATE_MEDIA_SCOPE_24H"].includes(reason)) return false;
        if (reason === "SUPPORT_MEDIA_ONLY" && row?.output?.operational_support_fallback === true) return false;
        if (reason === "DUPLICATE_MEDIA_SCOPE_24H" && (
          row?.output?.support_media_dedupe_recovery_attempted === true
          || row?.output?.support_media_dedupe_recovery === true
        )) return false;
      }
      const customerAt = supportFallbackCustomerAt(row.input_snapshot);
      return customerAt > 0 && nowMs - customerAt >= waitMs;
    }).slice(0, BATCH_SIZE);
    due = candidates.length;

    for (const row of candidates) {
      const customerAt = supportFallbackCustomerAt(row.input_snapshot);
      const plan = buildSupportOperationalFallback(row.input_snapshot, slideKeys);
      const result = row?.output?.live_suppression_reason === "DUPLICATE_MEDIA_SCOPE_24H"
        ? await recoverDuplicateMediaSuppression(row, plan, customerAt, waitMs)
        : await completeWithFallback(row, plan, customerAt, waitMs);
      if (!result) continue;
      if (plan.kind === "suppress") suppressed += 1;
      else completed += 1;
    }
    await heartbeat("healthy", {
      enabled: true,
      wait_seconds: Math.round(waitMs / 1000),
      scanned,
      due,
      completed,
      suppressed,
      available_slide_catalogs: slideKeys.size,
    });
  } catch (error) {
    await heartbeat("degraded", { scanned, due, completed, suppressed }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!configured()) {
  console.warn("[AIGUKA V10 support failover] Core/Knowledge credentials missing; disabled");
} else {
  console.log(`[AIGUKA V10 support failover] ${VERSION} started; deterministic no-drop safety net enabled`);
  tick().catch(() => {});
}
