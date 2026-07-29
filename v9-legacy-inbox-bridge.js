import { normalizeLegacyWebhookInboxRow } from "./v9/core/legacy-inbox-normalizer.js";

const LEGACY_BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const LEGACY_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v9-legacy-inbox-bridge";
const VERSION = "v9_legacy_inbox_bridge_v2_cutover";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V9_BRIDGE_POLL_MS || 5000));
const BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.AIGUKA_V9_BRIDGE_BATCH || 20)));
const CUTOVER_AT = Number.isFinite(Date.parse(String(process.env.AIGUKA_V9_BRIDGE_CUTOVER_AT || "")))
  ? new Date(Date.parse(process.env.AIGUKA_V9_BRIDGE_CUTOVER_AT)).toISOString()
  : new Date().toISOString();
let running = false;
let timer;

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

function legacy(path, options = {}) {
  return request(LEGACY_BASE, LEGACY_KEY, path, options);
}

function core(path, options = {}) {
  return request(CORE_BASE, CORE_KEY, path, options);
}

async function recoverStaleClaims() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await legacy(`v8_webhook_inbox?status=eq.processing&locked_at=lt.${encodeURIComponent(cutoff)}&created_at=gte.${encodeURIComponent(CUTOVER_AT)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "pending",
      locked_at: null,
      locked_by: null,
      next_attempt_at: new Date().toISOString(),
      last_error: "stale_claim_recovered_for_v9_bridge",
      updated_at: new Date().toISOString(),
    },
  });
}

async function candidates() {
  const now = encodeURIComponent(new Date().toISOString());
  return legacy(
    `v8_webhook_inbox?select=id,page_id,sender_id,recipient_id,message_id,event_time,payload,status,attempts,next_attempt_at,locked_at,locked_by,created_at,updated_at&status=in.(pending,error,dead)&created_at=gte.${encodeURIComponent(CUTOVER_AT)}&or=(next_attempt_at.is.null,next_attempt_at.lte.${now})&order=created_at.asc,id.asc&limit=${BATCH_SIZE}`,
  );
}

async function claim(candidate) {
  const rows = await legacy(`v8_webhook_inbox?id=eq.${candidate.id}&status=eq.${candidate.status}&created_at=gte.${encodeURIComponent(CUTOVER_AT)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "processing",
      attempts: Number(candidate.attempts || 0) + 1,
      locked_at: new Date().toISOString(),
      locked_by: NAME,
      updated_at: new Date().toISOString(),
    },
  });
  return rows?.[0] || null;
}

async function ingestCore(event) {
  const result = await core("rpc/v9_ingest_meta_batch", {
    method: "POST",
    body: { p_events: [event] },
    timeout: 30000,
  });
  if (!result || Number(result.failed || 0) > 0) {
    const detail = result?.results?.find?.((item) => item.status === "failed")?.error;
    throw new Error(detail || "V9_CORE_INGEST_FAILED");
  }
  return result;
}

async function complete(row, result, ignored = false) {
  await legacy(`v8_webhook_inbox?id=eq.${row.id}&status=eq.processing&locked_by=eq.${encodeURIComponent(NAME)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "completed",
      processed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: ignored ? "v9_bridge_ignored_unsupported_payload" : null,
      updated_at: new Date().toISOString(),
      payload: row.payload,
    },
  });
  return result;
}

async function fail(row, error) {
  const attempts = Number(row.attempts || 0);
  const terminal = attempts >= 8;
  await legacy(`v8_webhook_inbox?id=eq.${row.id}&locked_by=eq.${encodeURIComponent(NAME)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: terminal ? "dead" : "pending",
      next_attempt_at: new Date(Date.now() + Math.min(15 * 60 * 1000, Math.max(30000, attempts * 30000))).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: String(error?.message || error).slice(0, 800),
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

async function heartbeat(status, details = {}, error = null) {
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: "SHADOW",
      details: { ...details, cutover_at: CUTOVER_AT },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function tick() {
  if (!LEGACY_BASE || !LEGACY_KEY || !CORE_BASE || !CORE_KEY || running) return;
  running = true;
  let bridged = 0;
  let duplicates = 0;
  let skipped = 0;
  let failed = 0;
  try {
    await recoverStaleClaims();
    const rows = await candidates();
    for (const candidate of rows || []) {
      const row = await claim(candidate);
      if (!row) continue;
      try {
        const event = normalizeLegacyWebhookInboxRow(row);
        if (!event) {
          skipped += 1;
          await complete(row, null, true);
          continue;
        }
        const result = await ingestCore(event);
        bridged += Number(result.inserted || 0);
        duplicates += Number(result.duplicates || 0);
        skipped += Number(result.skipped || 0);
        await complete(row, result);
      } catch (error) {
        failed += 1;
        await fail(row, error);
      }
    }
    await heartbeat(failed ? "degraded" : "healthy", {
      bridged_last_tick: bridged,
      duplicates_last_tick: duplicates,
      skipped_last_tick: skipped,
      failed_last_tick: failed,
      batch_size: BATCH_SIZE,
      source: "v8_webhook_inbox",
      outbound_enabled: false,
      historical_replay_enabled: false,
    }, failed ? `${failed} legacy inbox row(s) failed` : null);
  } catch (error) {
    await heartbeat("degraded", {
      bridged_last_tick: bridged,
      duplicates_last_tick: duplicates,
      skipped_last_tick: skipped,
      failed_last_tick: failed,
      source: "v8_webhook_inbox",
      outbound_enabled: false,
      historical_replay_enabled: false,
    }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!LEGACY_BASE || !LEGACY_KEY || !CORE_BASE || !CORE_KEY) {
  console.warn("[AIGUKA V9 bridge] legacy or Core configuration missing; disabled");
} else {
  console.log(`[AIGUKA V9 bridge] started; accepting durable inbox rows from cutover ${CUTOVER_AT}`);
  tick().catch(() => {});
}

export const __private__ = { CUTOVER_AT };
