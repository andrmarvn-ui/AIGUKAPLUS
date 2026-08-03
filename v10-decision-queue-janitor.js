const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-queue-janitor";
const VERSION = "v10_queue_hygiene_v1";
const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_V10_JANITOR_POLL_MS || 2000));
const V10 = "v10_ai_sovereign_advisory";
let running = false;
let timer;

async function core(path, options = {}) {
  const response = await fetch(`${CORE_BASE}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: CORE_KEY,
      authorization: `Bearer ${CORE_KEY}`,
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
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
  return data;
}

function isV10(row) {
  return row?.input_snapshot?.architecture === V10 || row?.output?.architecture === V10;
}

async function suppress(row, action, reason) {
  await core(`v9_decisions?id=eq.${row.id}&status=eq.${encodeURIComponent(row.status)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "shadow_suppressed",
      action,
      output: {
        ...(row.output || {}),
        should_send: false,
        transport_locked: true,
        queue_hygiene_reason: reason,
        architecture: row?.output?.architecture || row?.input_snapshot?.architecture || null,
      },
      updated_at: new Date().toISOString(),
    },
  });
}

async function cleanup() {
  const rows = await core("v9_decisions?select=id,page_id,sender_id,status,action,input_snapshot,output,created_at,updated_at&status=in.(shadow_context_ready,shadow_ai_processing,shadow_ai_completed,live_delivery_failed)&order=created_at.desc&limit=500");
  let legacyQuarantined = 0;
  let superseded = 0;
  const v10Rows = [];

  for (const row of rows || []) {
    if (!isV10(row)) {
      await suppress(row, "legacy_quarantined", "Legacy V9 pending decision quarantined before V10 workers start.");
      legacyQuarantined += 1;
    } else {
      v10Rows.push(row);
    }
  }

  const latest = new Map();
  for (const row of v10Rows) {
    const key = `${row.page_id}:${row.sender_id}`;
    if (!latest.has(key)) {
      latest.set(key, row);
      continue;
    }
    await suppress(row, "superseded", "A newer customer event exists in the same conversation.");
    superseded += 1;
  }

  const deliveryCutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  const stuckDelivery = await core(`v9_decisions?select=id,status,input_snapshot,output&status=eq.live_delivery_processing&updated_at=lt.${encodeURIComponent(deliveryCutoff)}&limit=100`);
  let deliveryRecovered = 0;
  for (const row of stuckDelivery || []) {
    if (!isV10(row)) continue;
    await core(`v9_decisions?id=eq.${row.id}&status=eq.live_delivery_processing`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "live_delivery_failed",
        output: { ...(row.output || {}), live_delivery_error: "DELIVERY_LEASE_EXPIRED", transport_locked: false },
        updated_at: new Date().toISOString(),
      },
    });
    deliveryRecovered += 1;
  }

  return { scanned: rows?.length || 0, legacyQuarantined, superseded, deliveryRecovered };
}

async function heartbeat(status, details = {}, error = null) {
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: "QUEUE_HYGIENE",
      details: { ...details, business_decision_authority: "none" },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function tick() {
  if (!CORE_BASE || !CORE_KEY || running) return;
  running = true;
  try {
    const details = await cleanup();
    await heartbeat("healthy", details);
  } catch (error) {
    await heartbeat("degraded", {}, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!CORE_BASE || !CORE_KEY) {
  console.warn("[AIGUKA V10 janitor] Core configuration missing; disabled");
} else {
  console.log("[AIGUKA V10 janitor] queue hygiene started; no business decision authority");
  await tick();
}
