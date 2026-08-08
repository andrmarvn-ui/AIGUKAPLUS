const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-queue-janitor";
const VERSION = "v10_queue_hygiene_v2";
const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_V10_JANITOR_POLL_MS || 2000));
const CAPACITY_GUARD_MS = Math.max(5 * 60_000, Number(process.env.AIGUKA_V10_CAPACITY_GUARD_MS || 30 * 60_000));
const V10 = "v10_ai_sovereign_advisory";
let running = false;
let timer;
let lastCapacityGuardAt = 0;

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
  const now = new Date().toISOString();
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
        rehydrated_at: action === "legacy_rehydrating" ? now : row?.output?.rehydrated_at || null,
        architecture: row?.output?.architecture || row?.input_snapshot?.architecture || null,
      },
      ...(action === "legacy_rehydrating" ? { created_at: now } : {}),
      updated_at: now,
    },
  });
}

async function requeueLegacySource(row) {
  if (!row.source_event_id) return false;
  const now = new Date().toISOString();
  const jobs = await core(`v9_jobs?select=id,status&source_event_id=eq.${encodeURIComponent(row.source_event_id)}&job_type=eq.decision_shadow&limit=1`);
  const job = jobs?.[0];
  if (!job?.id) return false;
  const updated = await core(`v9_jobs?id=eq.${job.id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "queued",
      run_after: now,
      attempts: 0,
      locked_by: null,
      locked_at: null,
      completed_at: null,
      last_error: "V10_REHYDRATE_LEGACY_PENDING",
      result: {
        rehydrated_by: NAME,
        legacy_decision_id: row.id,
        reason: "Rebuild the latest pending conversation with the V10 full-conversation assembler.",
      },
      updated_at: now,
    },
  });
  return Boolean(updated?.length);
}

async function cleanup() {
  const rows = await core("v9_decisions?select=id,source_event_id,page_id,sender_id,status,action,input_snapshot,output,created_at,updated_at&status=in.(shadow_context_ready,shadow_ai_processing,shadow_ai_completed,live_delivery_failed)&order=created_at.desc&limit=500");
  let legacyRehydrated = 0;
  let legacyQuarantined = 0;
  let superseded = 0;
  const latestByConversation = new Map();

  for (const row of rows || []) {
    const key = `${row.page_id}:${row.sender_id}`;
    if (latestByConversation.has(key)) {
      await suppress(row, "superseded", "A newer pending customer event exists in the same conversation and will carry the full history.");
      superseded += 1;
      continue;
    }
    latestByConversation.set(key, row);

    if (!isV10(row)) {
      const requeued = await requeueLegacySource(row);
      await suppress(
        row,
        requeued ? "legacy_rehydrating" : "legacy_quarantined",
        requeued
          ? "Latest V9 pending decision requeued so V10 can rebuild the complete conversation."
          : "Legacy V9 pending decision quarantined because no durable source job was found.",
      );
      if (requeued) legacyRehydrated += 1;
      else legacyQuarantined += 1;
    }
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

  return {
    scanned: rows?.length || 0,
    legacyRehydrated,
    legacyQuarantined,
    superseded,
    deliveryRecovered,
  };
}

async function maybeCapacityGuard() {
  const now = Date.now();
  if (now - lastCapacityGuardAt < CAPACITY_GUARD_MS) return null;
  lastCapacityGuardAt = now;
  try {
    return await core("rpc/v10_capacity_guard_tick", {
      method: "POST",
      prefer: "return=representation",
      body: {},
      timeout: 20000,
    });
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 500) };
  }
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
    const capacityGuard = await maybeCapacityGuard();
    await heartbeat("healthy", { ...details, capacity_guard: capacityGuard });
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
  console.log("[AIGUKA V10 janitor] queue hygiene, V9 pending rehydration and Core capacity guard started; no business decision authority");
  await tick();
}
