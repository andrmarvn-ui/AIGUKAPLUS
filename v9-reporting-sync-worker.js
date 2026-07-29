import crypto from "node:crypto";
import { assertReportingPayloadPrivacy } from "./v9/core/reporting-contract.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const REPORTING_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || "").replace(/\/$/, "");
const REPORTING_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v9-reporting-sync";
const VERSION = "v9_reporting_sync_v1";
const POLL_MS = Math.max(5000, Number(process.env.AIGUKA_V9_REPORTING_SYNC_MS || 15000));
const BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.AIGUKA_V9_REPORTING_SYNC_BATCH || 20)));
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

function core(path, options = {}) {
  return request(CORE_BASE, CORE_KEY, path, options);
}

function reporting(path, options = {}) {
  return request(REPORTING_BASE, REPORTING_KEY, path, options);
}

function checksum(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

const TARGETS = {
  page_dimension: { table: "dim_pages", conflict: "page_id" },
  customer_dimension: { table: "dim_customers", conflict: "page_id,customer_id" },
  message_fact: { table: "fact_messages", conflict: "source_event_id" },
  contact_fact: { table: "fact_contacts", conflict: "source_contact_id" },
  ai_decision_fact: { table: "fact_ai_decisions", conflict: "source_decision_id" },
  delivery_fact: { table: "fact_deliveries", conflict: "source_bundle_id" },
  sla_fact: { table: "fact_sla", conflict: "source_sla_id" },
};

async function recoverStaleClaims() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await core(`v9_reporting_outbox?status=eq.processing&locked_at=lt.${encodeURIComponent(cutoff)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "pending",
      locked_at: null,
      run_after: new Date().toISOString(),
      last_error: "stale_reporting_claim_recovered",
      updated_at: new Date().toISOString(),
    },
  });
}

async function dueRows() {
  const now = new Date().toISOString();
  return core(`v9_reporting_outbox?select=*&status=eq.pending&run_after=lte.${encodeURIComponent(now)}&order=run_after.asc,created_at.asc&limit=${BATCH_SIZE}`);
}

async function claim(row) {
  const rows = await core(`v9_reporting_outbox?id=eq.${row.id}&status=eq.pending`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "processing",
      attempts: Number(row.attempts || 0) + 1,
      locked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  return rows?.[0] || null;
}

async function recordIngest(row) {
  const payload = assertReportingPayloadPrivacy(row.payload || {});
  await reporting("reporting_ingest_events?on_conflict=event_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      event_key: row.event_key,
      source_type: row.event_type,
      occurred_at: row.occurred_at,
      payload,
      payload_checksum: checksum(payload),
      ingested_at: new Date().toISOString(),
    },
  });
  return payload;
}

async function materialize(row, payload) {
  const target = TARGETS[row.event_type];
  if (!target) throw new Error(`REPORTING_EVENT_TYPE_UNSUPPORTED:${row.event_type}`);
  await reporting(`${target.table}?on_conflict=${target.conflict}`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: payload,
  });
}

async function complete(row) {
  await core(`v9_reporting_outbox?id=eq.${row.id}&status=eq.processing`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "delivered",
      locked_at: null,
      delivered_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    },
  });
}

async function fail(row, error) {
  const attempts = Number(row.attempts || 0);
  const terminal = attempts >= 8;
  await core(`v9_reporting_outbox?id=eq.${row.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: terminal ? "dead_letter" : "pending",
      locked_at: null,
      run_after: new Date(Date.now() + Math.min(15 * 60 * 1000, Math.max(30000, attempts * 30000))).toISOString(),
      last_error: String(error?.message || error).slice(0, 800),
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

async function reportingHeartbeat(status, details = {}, error = null) {
  await reporting("reporting_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      details,
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function tick() {
  if (!CORE_BASE || !CORE_KEY || !REPORTING_BASE || !REPORTING_KEY || running) return;
  running = true;
  let delivered = 0;
  let failed = 0;
  try {
    await recoverStaleClaims();
    const rows = await dueRows();
    for (const candidate of rows || []) {
      const row = await claim(candidate);
      if (!row) continue;
      try {
        const payload = await recordIngest(row);
        await materialize(row, payload);
        await complete(row);
        delivered += 1;
      } catch (error) {
        failed += 1;
        await fail(row, error);
      }
    }
    await reportingHeartbeat(failed ? "degraded" : "healthy", {
      delivered_last_tick: delivered,
      failed_last_tick: failed,
      core_isolated: true,
    }, failed ? `${failed} reporting event(s) failed` : null);
  } catch (error) {
    await reportingHeartbeat("degraded", {
      delivered_last_tick: delivered,
      failed_last_tick: failed,
      core_isolated: true,
    }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!CORE_BASE || !CORE_KEY || !REPORTING_BASE || !REPORTING_KEY) {
  console.warn("[AIGUKA V9 reporting sync] Core or Reporting configuration missing; disabled");
} else {
  console.log("[AIGUKA V9 reporting sync] started; dashboard isolated from Core");
  tick().catch(() => {});
}
