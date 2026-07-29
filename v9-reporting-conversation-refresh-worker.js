const SOURCE_BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const SOURCE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const REPORT_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || SOURCE_BASE).replace(/\/$/, "");
const REPORT_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || SOURCE_KEY);
const INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.AIGUKA_V9_CONVERSATION_REFRESH_MS || 10 * 60_000));
const WORKER = "aiguka-v9-reporting-conversation-refresh";
const VERSION = "1.0.0";
let cycle = 0;
let running = false;

const nowIso = () => new Date().toISOString();
const ready = () => Boolean(SOURCE_BASE && SOURCE_KEY && REPORT_BASE && REPORT_KEY);

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
    signal: AbortSignal.timeout(options.timeout || 20_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(data?.message || data?.error || `HTTP_${response.status}`);
  return data;
}

async function heartbeat(status, details = {}, error = null) {
  try {
    await request(REPORT_BASE, REPORT_KEY, "reporting_worker_heartbeats?on_conflict=worker_name", {
      method: "POST",
      body: {
        worker_name: WORKER,
        worker_version: VERSION,
        status,
        details,
        last_error: error ? String(error).slice(0, 1000) : null,
        last_seen_at: nowIso(),
        updated_at: nowIso(),
      },
      prefer: "resolution=merge-duplicates,return=minimal",
      timeout: 10_000,
    });
  } catch (heartbeatError) {
    console.error(`[${WORKER}] heartbeat failed:`, heartbeatError.message);
  }
}

export function refreshSince(cycleNo = 1, now = Date.now()) {
  const lookbackMs = cycleNo === 1 ? 3 * 86_400_000 : 30 * 60_000;
  return new Date(now - lookbackMs).toISOString();
}

async function refresh() {
  if (running || !ready()) return;
  running = true;
  cycle += 1;
  const started = Date.now();
  const since = refreshSince(cycle);
  const details = {
    cycle,
    since,
    mode: cycle === 1 ? "startup_3d" : "incremental_30m",
    source: "v8_report_conversation_attribution",
    target: "v8_report_v21_conversation_fact",
    raw_contact_logging: false,
  };
  try {
    await heartbeat("running", details);
    const result = await request(SOURCE_BASE, SOURCE_KEY, "rpc/v9_refresh_conversation_fact", {
      method: "POST",
      body: { p_since: since },
      prefer: "return=representation",
      timeout: 20_000,
    });
    details.rows_upserted = Number(result?.rows_upserted || 0);
    details.database_duration_ms = Number(result?.duration_ms || 0);
    details.elapsed_ms = Date.now() - started;
    await heartbeat("healthy", details);
    console.log(`[${WORKER}] healthy`, details);
  } catch (error) {
    details.elapsed_ms = Date.now() - started;
    await heartbeat("degraded", details, error instanceof Error ? error.message : String(error));
    console.error(`[${WORKER}] refresh failed:`, error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

if (!ready()) {
  console.warn(`[${WORKER}] disabled: source/reporting credentials missing`);
} else {
  void refresh();
  setInterval(() => void refresh(), INTERVAL_MS).unref();
}

export const __private__ = { ready, refreshSince };
