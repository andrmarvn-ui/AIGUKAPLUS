const SUPABASE_URL = String(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
).replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

// Reporting stays isolated from webhook, AI dispatch and outbound delivery.
// Recovery uses one small key per tick and backs off automatically on pressure.
const BASE_POLL_MS = Math.max(
  60_000,
  Number(process.env.AIGUKA_REPORT_V21_POLL_MS || 60_000),
);
const BATCH_LIMIT = Math.min(
  2,
  Math.max(1, Number(process.env.AIGUKA_REPORT_V21_BATCH_LIMIT || 1)),
);
const ENABLED = String(
  process.env.AIGUKA_REPORT_V21_SHADOW_ENABLED || "true",
).toLowerCase() !== "false";
const WORKER_NAME = "aiguka-report-v21-shadow-worker";
const HEARTBEAT_MS = 60_000;
const RPC_TIMEOUT_MS = Math.max(
  5_000,
  Math.min(12_000, Number(process.env.AIGUKA_REPORT_V21_RPC_TIMEOUT_MS || 10_000)),
);
const MAX_BACKOFF_MS = 900_000;
const INITIAL_DELAY_MS = 15_000;

let running = false;
let lastHeartbeatAt = 0;
let timer = null;
let nextDelayMs = BASE_POLL_MS;
let lastReportedStatus = "starting";
let lastReportedError = null;
let lastReportedDetails = { startup: true };

function configured() {
  return Boolean(ENABLED && SUPABASE_URL && SERVICE_ROLE_KEY);
}

function isDatabasePressureError(message) {
  return /timeout|connection|503|504|too many|remaining connection|reset by peer|statement/i.test(
    String(message || ""),
  );
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
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw: raw.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || data?.hint || `SUPABASE_${response.status}`,
    );
  }
  return data;
}

async function heartbeat(status = lastReportedStatus, lastError = lastReportedError, details = lastReportedDetails) {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/v8_worker_heartbeats?on_conflict=worker_name`,
    {
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
        worker_version: "2.1.3-ui-report-recovery",
        status,
        capabilities: {
          ai_calls: 0,
          incremental_dirty_queue: true,
          bounded_date_refresh: true,
          customer_day_fact: true,
          ad_day_fact: true,
          realtime_priority_load_shedding: true,
          recursive_backoff_scheduler: true,
          independent_heartbeat: true,
          poll_ms: BASE_POLL_MS,
          current_delay_ms: nextDelayMs,
          batch_limit: BATCH_LIMIT,
          rpc_timeout_ms: RPC_TIMEOUT_MS,
          worker_busy: running,
          ...details,
        },
        last_error: lastError ? String(lastError).slice(0, 800) : null,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`HEARTBEAT_${response.status}`);
  lastHeartbeatAt = now;
}

function schedule(delayMs) {
  if (!configured()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    poll().catch(() => {});
  }, delayMs);
  timer.unref?.();
}

async function poll() {
  if (!configured() || running) {
    schedule(nextDelayMs);
    return;
  }
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

    nextDelayMs = failed
      ? Math.min(MAX_BACKOFF_MS, Math.max(120_000, nextDelayMs * 2))
      : BASE_POLL_MS;

    if (failed > 0) {
      console.error(`[AIGUKA Report V2.1] ${failed} fact refresh(es) failed`);
    } else if (processed > 0 || queued > 0) {
      console.log(
        `[AIGUKA Report V2.1] queued=${queued} processed=${processed} pending=${pending} duration=${Date.now() - startedAt}ms`,
      );
    }

    lastReportedStatus = failed ? "degraded" : "healthy";
    lastReportedError = failed ? `${failed} refresh(es) failed` : null;
    lastReportedDetails = {
      queued_last_poll: queued,
      processed_last_poll: processed,
      pending_after_poll: pending,
      duration_ms: Date.now() - startedAt,
    };
    await heartbeat().catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nextDelayMs = isDatabasePressureError(message)
      ? Math.min(MAX_BACKOFF_MS, Math.max(180_000, nextDelayMs * 2))
      : Math.min(MAX_BACKOFF_MS, Math.max(120_000, nextDelayMs * 2));
    console.error(
      `[AIGUKA Report V2.1 worker] ${message}; backing off ${Math.round(nextDelayMs / 1000)}s`,
    );
    lastReportedStatus = "degraded";
    lastReportedError = message;
    lastReportedDetails = {
      duration_ms: Date.now() - startedAt,
      database_pressure: isDatabasePressureError(message),
    };
    await heartbeat().catch(() => {});
  } finally {
    running = false;
    schedule(nextDelayMs);
  }
}

if (!configured()) {
  console.warn(
    "[AIGUKA Report V2.1] Shadow worker disabled or Supabase service configuration missing",
  );
} else {
  void heartbeat("starting", null, { startup: true }).catch(() => {});
  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch(() => {});
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
  schedule(INITIAL_DELAY_MS);
  console.log(
    `[AIGUKA Report V2.1] Recovery worker started; poll>=${BASE_POLL_MS}ms batch=${BATCH_LIMIT} timeout=${RPC_TIMEOUT_MS}ms`,
  );
}
