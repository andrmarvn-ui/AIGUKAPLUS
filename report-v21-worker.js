const SUPABASE_URL = String(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
).replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const POLL_MS = Math.max(30_000, Number(process.env.AIGUKA_REPORT_V21_POLL_MS || 30_000));
const BATCH_LIMIT = Math.min(10, Math.max(1, Number(process.env.AIGUKA_REPORT_V21_BATCH_LIMIT || 5)));
const ENABLED = String(process.env.AIGUKA_REPORT_V21_SHADOW_ENABLED || "true").toLowerCase() !== "false";
const WORKER_NAME = "aiguka-report-v21-shadow-worker";
const HEARTBEAT_MS = 60_000;
const RPC_TIMEOUT_MS = Math.max(10_000, Number(process.env.AIGUKA_REPORT_V21_RPC_TIMEOUT_MS || 15_000));

let running = false;
let lastHeartbeatAt = 0;

function configured() {
  return Boolean(ENABLED && SUPABASE_URL && SERVICE_ROLE_KEY);
}

async function rpc(name, body = {}, timeout = RPC_TIMEOUT_MS) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || data?.hint || `SUPABASE_${response.status}`);
  }
  return data;
}

async function heartbeat(status = "healthy", lastError = null, details = {}, force = false) {
  const now = Date.now();
  if (!force && !lastError && now - lastHeartbeatAt < HEARTBEAT_MS) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/v8_worker_heartbeats?on_conflict=worker_name`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      worker_name: WORKER_NAME,
      worker_type: "report_shadow",
      worker_version: "2.1.1-cutover",
      status,
      capabilities: {
        ai_calls: 0,
        incremental_dirty_queue: true,
        bounded_date_refresh: true,
        customer_day_fact: true,
        ad_day_fact: true,
        adaptive_low_contention_batch: true,
        poll_ms: POLL_MS,
        batch_limit: BATCH_LIMIT,
        rpc_timeout_ms: RPC_TIMEOUT_MS,
        ...details,
      },
      last_error: lastError ? String(lastError).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HEARTBEAT_${response.status}`);
  lastHeartbeatAt = now;
}

async function poll() {
  if (!configured() || running) return;
  running = true;
  const startedAt = Date.now();
  try {
    const result = await rpc("v8_report_v21_tick", { p_limit: BATCH_LIMIT });
    const processResult = result?.process || {};
    const discoverResult = result?.discover || {};
    const failed = Number(processResult.failed || 0);
    const pending = Number(processResult.pending || 0);
    const processed = Number(processResult.processed || 0);
    const queued = Number(discoverResult.queued || 0);

    if (failed > 0) {
      console.error(`[AIGUKA Report V2.1] ${failed} fact refresh(es) failed`, result);
    } else if (processed > 0 || queued > 0) {
      console.log(`[AIGUKA Report V2.1] queued=${queued} processed=${processed} pending=${pending} duration=${Date.now() - startedAt}ms`);
    }

    await heartbeat(failed ? "degraded" : "healthy", failed ? `${failed} refresh(es) failed` : null, {
      queued_last_poll: queued,
      processed_last_poll: processed,
      pending_after_poll: pending,
      duration_ms: Date.now() - startedAt,
    }, failed > 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[AIGUKA Report V2.1 worker]", message);
    await heartbeat("degraded", message, { duration_ms: Date.now() - startedAt }, true).catch(() => {});
  } finally {
    running = false;
  }
}

if (!configured()) {
  console.warn("[AIGUKA Report V2.1] Shadow worker disabled or Supabase service configuration missing");
} else {
  setTimeout(() => { poll().catch(() => {}); }, 10_000).unref?.();
  setInterval(() => { poll().catch(() => {}); }, POLL_MS).unref?.();
  console.log(`[AIGUKA Report V2.1] Worker started; poll=${POLL_MS}ms batch=${BATCH_LIMIT} timeout=${RPC_TIMEOUT_MS}ms`);
}
