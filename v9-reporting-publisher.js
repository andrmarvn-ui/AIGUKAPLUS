import { buildReportingEnvelope, assertReportingPayloadPrivacy } from "./v9/core/reporting-contract.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v9-reporting-publisher";
const VERSION = "v9_reporting_publisher_v1";
const POLL_MS = Math.max(5000, Number(process.env.AIGUKA_V9_REPORTING_PUBLISH_MS || 15000));
const BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.AIGUKA_V9_REPORTING_PUBLISH_BATCH || 30)));
const HASH_SECRET = String(process.env.AIGUKA_REPORTING_HASH_SECRET || "");
let running = false;
let timer;

const SOURCES = [
  {
    name: "pages",
    eventType: "page_dimension",
    table: "v9_pages",
    keyField: "page_id",
    timeField: "updated_at",
    select: "page_id,page_name,timezone,operating_mode,coexistence_mode,canary_percent,is_active,created_at,updated_at",
  },
  {
    name: "customers",
    eventType: "customer_dimension",
    table: "v9_customers",
    keyField: "id",
    timeField: "updated_at",
    select: "id,page_id,customer_id,display_name,gender,preferred_salutation,first_seen_at,last_seen_at,created_at,updated_at",
  },
  {
    name: "messages",
    eventType: "message_fact",
    table: "v9_events",
    keyField: "id",
    timeField: "created_at",
    select: "id,source_system,source_event_id,page_id,customer_id,actor_type,event_type,message_text,attachments,referral,occurred_at,created_at",
  },
  {
    name: "contacts",
    eventType: "contact_fact",
    table: "v9_contacts",
    keyField: "id",
    timeField: "created_at",
    select: "id,page_id,customer_id,contact_type,contact_value,normalized_value,source_event_id,confidence,captured_at,created_at",
  },
  {
    name: "decisions",
    eventType: "ai_decision_fact",
    table: "v9_decisions",
    keyField: "id",
    timeField: "updated_at",
    select: "id,source_event_id,page_id,sender_id,mode,status,action,confidence,knowledge_version,output,risk_flags,latency_ms,created_at,updated_at",
  },
  {
    name: "deliveries",
    eventType: "delivery_fact",
    table: "v9_delivery_bundles",
    keyField: "id",
    timeField: "updated_at",
    select: "id,decision_id,page_id,sender_id,text_body,asset_refs,status,created_at,updated_at",
  },
  {
    name: "sla",
    eventType: "sla_fact",
    table: "v9_sla_events",
    keyField: "id",
    timeField: "updated_at",
    select: "id,source_event_id,page_id,sender_id,deadline_at,status,resolution,resolved_at,created_at,updated_at",
  },
];

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

function cursorName(source) {
  return `${NAME}:${source.name}`;
}

async function readCursor(source) {
  const rows = await core(`v9_worker_cursors?select=cursor_created_at,cursor_id&worker_name=eq.${encodeURIComponent(cursorName(source))}&limit=1`);
  return rows?.[0] || { cursor_created_at: "1970-01-01T00:00:00.000Z", cursor_id: "" };
}

function rowKey(source, row) {
  return String(row?.[source.keyField] || "");
}

function isAfter(source, row, cursor) {
  const rowTime = Date.parse(String(row[source.timeField] || row.created_at || 0));
  const cursorTime = Date.parse(String(cursor.cursor_created_at || 0));
  return rowTime > cursorTime || (rowTime === cursorTime && rowKey(source, row) > String(cursor.cursor_id || ""));
}

async function sourceRows(source, cursor) {
  const time = encodeURIComponent(cursor.cursor_created_at || "1970-01-01T00:00:00.000Z");
  const limit = Math.max(BATCH_SIZE * 3, 50);
  const rows = await core(`${source.table}?select=${source.select}&${source.timeField}=gte.${time}&order=${source.timeField}.asc,${source.keyField}.asc&limit=${limit}`);
  return (rows || []).filter((row) => isAfter(source, row, cursor)).slice(0, BATCH_SIZE);
}

async function saveCursor(source, row) {
  await core("v9_worker_cursors?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: cursorName(source),
      cursor_created_at: row[source.timeField] || row.created_at,
      cursor_id: rowKey(source, row),
      updated_at: new Date().toISOString(),
    },
  });
}

async function publish(envelope) {
  assertReportingPayloadPrivacy(envelope.payload);
  await core("v9_reporting_outbox?on_conflict=event_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: {
      event_key: envelope.event_key,
      event_type: envelope.event_type,
      occurred_at: envelope.occurred_at,
      payload: envelope.payload,
      status: "pending",
      run_after: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function processSource(source) {
  const cursor = await readCursor(source);
  const rows = await sourceRows(source, cursor);
  for (const row of rows) {
    const envelope = buildReportingEnvelope(source.eventType, row, { contactHashSecret: HASH_SECRET });
    await publish(envelope);
    await saveCursor(source, row);
  }
  return rows.length;
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
      details,
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function tick() {
  if (!CORE_BASE || !CORE_KEY || running) return;
  running = true;
  const counts = {};
  try {
    for (const source of SOURCES) counts[source.name] = await processSource(source);
    await heartbeat("healthy", { published: counts, privacy_safe: true });
  } catch (error) {
    await heartbeat("degraded", { published: counts, privacy_safe: true }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!CORE_BASE || !CORE_KEY) {
  console.warn("[AIGUKA V9 reporting publisher] isolated Core configuration missing; disabled");
} else {
  console.log("[AIGUKA V9 reporting publisher] started; async outbox only");
  tick().catch(() => {});
}
