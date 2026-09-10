const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const PORT = Number(process.env.PORT || 3000);
const POLL_MS = Math.max(15000, Number(process.env.AIGUKA_DRIVE_SYNC_POLL_MS || 30000));
const WORKER_NAME = "aiguka-drive-sync-request-worker";

let running = false;

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && PORT);
}

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 30000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `SUPABASE_${response.status}`);
  return data;
}

async function heartbeat(status = "healthy", lastError = null, details = {}) {
  await supabase("v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_type: "drive_sync",
      worker_version: "requested_mapping_sync_v1",
      status,
      capabilities: {
        requested_mapping_sync: true,
        recursive_drive_scan: true,
        exact_catalog_assets: true,
        ...details,
      },
      last_error: lastError ? String(lastError).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function claimRequestedMappings(limit = 3) {
  const rows = await supabase(
    `v8_slide_mapping?select=id,product_key,product_name,sync_requested_at&is_active=eq.true&sync_status=eq.requested&order=sync_requested_at.asc&limit=${limit}`,
  );
  const claimed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const updated = await supabase(
      `v8_slide_mapping?id=eq.${encodeURIComponent(row.id)}&sync_status=eq.requested`,
      {
        method: "PATCH",
        body: { sync_status: "syncing", sync_error: null, updated_at: new Date().toISOString() },
      },
    );
    if (Array.isArray(updated) && updated.length) claimed.push(updated[0]);
  }
  return claimed;
}

async function syncMapping(mapping) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/slide-manager/drive/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aiguka-internal-auth": process.env.AIGUKA_INTERNAL_HTTP_TOKEN || "",
    },
    body: JSON.stringify({ mapping_id: mapping.id }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok || data?.ok === false) {
    const message = data?.error || `LOCAL_DRIVE_SYNC_${response.status}`;
    await supabase(`v8_slide_mapping?id=eq.${encodeURIComponent(mapping.id)}`, {
      method: "PATCH",
      body: { sync_status: "error", sync_error: String(message).slice(0, 1000), updated_at: new Date().toISOString() },
    }).catch(() => {});
    throw new Error(message);
  }
  return data;
}

async function poll() {
  if (!configured() || running) return;
  running = true;
  let processed = 0;
  let failures = 0;
  try {
    const mappings = await claimRequestedMappings(3);
    for (const mapping of mappings) {
      try {
        await syncMapping(mapping);
        processed += 1;
      } catch (error) {
        failures += 1;
        console.error(`[AIGUKA Drive sync] ${mapping.product_key || mapping.id}:`, error.message);
      }
    }
    await heartbeat(failures ? "degraded" : "healthy", failures ? `${failures}/${mappings.length} mapping sync(s) failed` : null, {
      processed_last_poll: processed,
      failures_last_poll: failures,
    });
  } catch (error) {
    console.error("[AIGUKA Drive sync worker]", error.message);
    await heartbeat("degraded", error.message).catch(() => {});
  } finally {
    running = false;
  }
}

if (!configured()) {
  console.warn("[AIGUKA Drive sync] Supabase/PORT configuration missing; worker not started");
} else {
  setTimeout(() => { poll().catch(() => {}); }, 5000).unref?.();
  setInterval(() => { poll().catch(() => {}); }, POLL_MS).unref?.();
  console.log(`[AIGUKA Drive sync] Worker started; poll ${POLL_MS}ms`);
}
