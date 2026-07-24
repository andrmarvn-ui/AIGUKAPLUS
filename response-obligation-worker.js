const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const WORKER_NAME = process.env.AIGUKA_RESPONSE_OBLIGATION_WORKER_NAME
  || "aiguka-railway-response-obligation";
const WORKER_VERSION = "zero_silent_drop_v1";
const POLL_MS = Math.max(5_000, Number(process.env.AIGUKA_RESPONSE_OBLIGATION_POLL_MS || 10_000));
const HEARTBEAT_MS = Math.max(30_000, Number(process.env.AIGUKA_RESPONSE_OBLIGATION_HEARTBEAT_MS || 60_000));
const BATCH_SIZE = Math.min(500, Math.max(20, Number(process.env.AIGUKA_RESPONSE_OBLIGATION_BATCH_SIZE || 100)));

let running = false;
let lastHeartbeatAt = 0;

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 60_000),
    cache: "no-store",
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const rpc = (name, body = {}) => request(`/rest/v1/rpc/${name}`, {
  method: "POST",
  body,
});

const rest = (path, options = {}) => request(`/rest/v1/${path}`, options);

async function heartbeat(status = "healthy", lastError = null, capabilities = {}) {
  await rest("v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_type: "response_obligation",
      worker_version: WORKER_VERSION,
      status,
      capabilities: {
        durable_response_obligations: true,
        terminal_ai_error_recovery: true,
        completed_without_staging_recovery: true,
        slide_failure_text_degrade: true,
        outbound_final_gate_reconcile: true,
        deterministic_safe_fallback: true,
        sale_escalation: true,
        ...capabilities,
      },
      last_error: lastError ? String(lastError).slice(0, 500) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  lastHeartbeatAt = Date.now();
}

async function hasDueObligation() {
  const now = encodeURIComponent(new Date().toISOString());
  const rows = await rest(
    `v8_response_obligations?select=id&is_resolved=eq.false&next_check_at=lte.${now}&limit=1`,
    { timeout: 15_000 },
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function poll() {
  if (!configured() || running) return;
  running = true;

  try {
    const due = await hasDueObligation();
    let result = null;
    if (due) {
      result = await rpc("v8_zero_silent_drop_tick", { p_limit: BATCH_SIZE });
    }

    const shouldHeartbeat = due || Date.now() - lastHeartbeatAt >= HEARTBEAT_MS;
    if (shouldHeartbeat) {
      const status = result?.status?.healthy === false ? "degraded" : "healthy";
      const lastError = status === "degraded"
        ? `${result?.status?.unresolved_over_2m || 0} unresolved obligation(s) over two minutes`
        : null;
      await heartbeat(status, lastError, {
        last_tick_at: due ? new Date().toISOString() : null,
        unresolved_total: Number(result?.status?.unresolved_total || 0),
        unresolved_over_2m: Number(result?.status?.unresolved_over_2m || 0),
        sale_escalations_open: Number(result?.status?.sale_escalations_open || 0),
        safe_fallbacks_24h: Number(result?.status?.fallbacks_24h || 0),
      });
    }
  } catch (error) {
    const message = String(error?.message || error);
    console.error(`[AIGUKA response obligation worker] ${message}`);
    await heartbeat("degraded", message).catch(() => {});
  } finally {
    running = false;
  }
}

export async function startResponseObligationWorker() {
  if (!configured()) {
    console.warn("[AIGUKA response obligation worker] Supabase service configuration missing; worker not started");
    return;
  }

  await heartbeat("starting", null).catch(() => {});
  await poll();
  setInterval(() => { poll().catch(() => {}); }, POLL_MS).unref?.();
  console.log(
    `[AIGUKA response obligation worker] ${WORKER_NAME} started; poll ${POLL_MS}ms; batch ${BATCH_SIZE}`,
  );
}

await startResponseObligationWorker();
