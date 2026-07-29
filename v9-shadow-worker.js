import { normalizeV8MetaEvent } from "./v9/core/event-normalizer.js";
import { detectContact } from "./v9/core/contact-detector.js";
import { reduceConversationState } from "./v9/core/state-machine.js";

const BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v9-shadow";
const VERSION = "v9_foundation_shadow_v1";
const POLL_MS = Math.max(3_000, Number(process.env.AIGUKA_V9_POLL_MS || 5_000));
const MAX_BATCH = Math.min(50, Math.max(1, Number(process.env.AIGUKA_V9_BATCH_SIZE || 10)));
let timer;
let running = false;
let lastHeartbeat = 0;

async function rest(path, options = {}) {
  const response = await fetch(`${BASE}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 20_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `SUPABASE_HTTP_${response.status}`);
  return data;
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => tick().catch(() => {}), ms);
  timer.unref?.();
}

async function runtime() {
  const rows = await rest("v9_runtime_config?select=mode,debounce_seconds,response_sla_seconds,event_batch_size&id=eq.1&limit=1", { timeout: 8_000 });
  return rows?.[0] || { mode: "OFF", debounce_seconds: 20, response_sla_seconds: 90, event_batch_size: 10 };
}

async function cursor() {
  const rows = await rest(`v9_worker_cursors?select=cursor_created_at,cursor_id&worker_name=eq.${NAME}&limit=1`);
  return rows?.[0] || { cursor_created_at: new Date().toISOString(), cursor_id: null };
}

function afterCursor(row, value) {
  const a = Date.parse(row.created_at || 0);
  const b = Date.parse(value.cursor_created_at || 0);
  return a > b || (a === b && String(row.id) > String(value.cursor_id || ""));
}

async function sourceRows(value, limit) {
  const select = "id,page_id,sender_id,recipient_id,message_id,message_text,timestamp_ms,event_time,referral,attachments,raw_payload,created_at";
  const rows = await rest(`v8_meta_events?select=${select}&created_at=gte.${encodeURIComponent(value.cursor_created_at)}&order=created_at.asc,id.asc&limit=${Math.max(limit * 3, 30)}`);
  return (rows || []).filter((row) => afterCursor(row, value)).slice(0, limit);
}

async function saveCursor(row) {
  await rest("v9_worker_cursors?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: { worker_name: NAME, cursor_created_at: row.created_at, cursor_id: row.id, updated_at: new Date().toISOString() },
  });
}

async function insertEvent(event) {
  const rows = await rest("v9_events?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      source_system: event.sourceSystem,
      source_event_id: event.sourceEventId,
      page_id: event.pageId,
      sender_id: event.senderId,
      customer_id: event.customerId,
      recipient_id: event.recipientId,
      message_id: event.messageId,
      actor_type: event.actorType,
      actor_evidence: event.actorEvidence,
      event_type: event.eventType,
      message_text: event.text,
      attachments: event.attachments,
      referral: event.referral,
      occurred_at: event.occurredAt,
      received_at: event.receivedAt,
      payload: event.payload,
    },
  });
  return rows?.[0] || null;
}

async function readState(event) {
  const rows = await rest(`v9_conversation_state?select=*&page_id=eq.${encodeURIComponent(event.pageId)}&sender_id=eq.${encodeURIComponent(event.customerId)}&limit=1`);
  const row = rows?.[0];
  return row ? {
    state: row.state,
    version: row.version,
    contactStatus: row.contact_status,
    phone: row.phone,
    zalo: row.zalo,
    humanTakeover: row.human_takeover,
    lastCustomerEventAt: row.last_customer_event_at,
    lastPageEventAt: row.last_page_event_at,
    responseDeadlineAt: row.response_deadline_at,
  } : null;
}

async function saveState(event, next) {
  await rest("v9_conversation_state?on_conflict=page_id,sender_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      page_id: event.pageId,
      sender_id: event.customerId,
      state: next.state,
      version: next.version,
      contact_status: next.contactStatus || "missing",
      phone: next.phone || null,
      zalo: next.zalo || null,
      human_takeover: Boolean(next.humanTakeover),
      last_customer_event_at: next.lastCustomerEventAt || null,
      last_page_event_at: next.lastPageEventAt || null,
      response_deadline_at: next.responseDeadlineAt || null,
      last_source_event_id: event.sourceEventId,
      updated_at: next.updatedAt,
    },
  });
}

async function stageCustomerTurn(event, eventRow, contact, next, config) {
  if (!eventRow || event.actorType !== "customer") return;
  const now = new Date();
  const deadline = new Date(now.getTime() + Number(config.response_sla_seconds || 90) * 1000).toISOString();
  await Promise.all([
    rest("v9_shadow_observations?on_conflict=source_event_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        source_event_id: event.sourceEventId,
        page_id: event.pageId,
        sender_id: event.customerId,
        actor_type: event.actorType,
        event_type: event.eventType,
        contact_detection: contact,
        state_after: next.state,
        goal: "capture_phone_or_zalo",
        created_at: now.toISOString(),
      },
    }),
    rest("v9_sla_events?on_conflict=source_event_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        source_event_id: event.sourceEventId,
        page_id: event.pageId,
        sender_id: event.customerId,
        deadline_at: contact.contactCaptured ? now.toISOString() : deadline,
        status: contact.contactCaptured ? "resolved" : "open",
        resolution: contact.contactCaptured ? "contact_captured" : null,
        resolved_at: contact.contactCaptured ? now.toISOString() : null,
        updated_at: now.toISOString(),
      },
    }),
  ]);

  if (!contact.contactCaptured && ["customer_message", "customer_postback"].includes(event.eventType)) {
    await rest("v9_jobs?on_conflict=source_event_id,job_type", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: {
        source_event_id: event.sourceEventId,
        event_id: eventRow.id,
        job_type: "decision_shadow",
        page_id: event.pageId,
        sender_id: event.customerId,
        status: "queued",
        run_after: new Date(now.getTime() + Number(config.debounce_seconds || 20) * 1000).toISOString(),
        payload: { goal: "capture_phone_or_zalo", mode: "SHADOW" },
      },
    });
  }
}

async function ingest(row, config) {
  const event = normalizeV8MetaEvent(row);
  const eventRow = await insertEvent(event);
  if (!event.pageId || !event.customerId) return;
  const contact = event.actorType === "customer" ? detectContact(event.text) : detectContact("");
  const next = reduceConversationState(await readState(event), event, contact, {
    now: new Date(),
    slaSeconds: config.response_sla_seconds,
  });
  await saveState(event, next);
  await stageCustomerTurn(event, eventRow, contact, next, config);
}

async function dueJobs(config) {
  const now = new Date().toISOString();
  const jobs = await rest(`v9_jobs?select=*&status=eq.queued&run_after=lte.${encodeURIComponent(now)}&order=run_after.asc&limit=5`);
  let done = 0;
  for (const job of jobs || []) {
    try {
      await rest(`v9_jobs?id=eq.${job.id}&status=eq.queued`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: "processing", locked_by: NAME, locked_at: now, attempts: Number(job.attempts || 0) + 1, updated_at: now },
      });
      const [events, customers] = await Promise.all([
        rest(`v9_events?select=source_event_id,actor_type,event_type,message_text,occurred_at&page_id=eq.${encodeURIComponent(job.page_id)}&customer_id=eq.${encodeURIComponent(job.sender_id)}&order=occurred_at.desc&limit=12`),
        rest(`v8_customers?select=display_name,phone,zalo,gender,gender_source,preferred_salutation,last_product_key,last_intent_type&page_id=eq.${encodeURIComponent(job.page_id)}&sender_id=eq.${encodeURIComponent(job.sender_id)}&limit=1`).catch(() => []),
      ]);
      const customer = customers?.[0] || null;
      const hasContact = Boolean(customer?.phone || customer?.zalo);
      await rest("v9_decisions?on_conflict=source_event_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          source_event_id: job.source_event_id,
          page_id: job.page_id,
          sender_id: job.sender_id,
          mode: "SHADOW",
          status: "shadow_ready",
          goal: "capture_phone_or_zalo",
          action: hasContact ? "contact_already_captured" : "needs_ai_decision",
          confidence: hasContact ? 1 : 0,
          input_snapshot: { recent_events: [...(events || [])].reverse(), customer, response_sla_seconds: config.response_sla_seconds },
          output: { should_send: false, reason: "Shadow mode never sends customer messages." },
          updated_at: new Date().toISOString(),
        },
      });
      await rest(`v9_jobs?id=eq.${job.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      });
      done += 1;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      await rest(`v9_jobs?id=eq.${job.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          status: attempts >= 5 ? "dead_letter" : "queued",
          run_after: new Date(Date.now() + Math.min(300_000, attempts * 30_000)).toISOString(),
          last_error: String(error?.message || error).slice(0, 800),
          updated_at: new Date().toISOString(),
        },
      }).catch(() => {});
    }
  }
  return done;
}

async function breachSla() {
  const now = new Date().toISOString();
  const rows = await rest(`v9_sla_events?select=id&status=eq.open&deadline_at=lte.${encodeURIComponent(now)}&limit=50`);
  for (const row of rows || []) {
    await rest(`v9_sla_events?id=eq.${row.id}&status=eq.open`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { status: "breached", updated_at: now },
    });
  }
  return rows?.length || 0;
}

async function heartbeat(status, mode, details = {}, error = null) {
  if (status === "healthy" && Date.now() - lastHeartbeat < 30_000) return;
  await rest("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode,
      details,
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  lastHeartbeat = Date.now();
}

async function tick() {
  if (!BASE || !KEY || running) return schedule(30_000);
  running = true;
  let mode = "OFF";
  try {
    const config = await runtime();
    mode = String(config.mode || "OFF").toUpperCase();
    if (mode === "OFF") return await heartbeat("idle", mode);
    if (mode !== "SHADOW") throw new Error(`V9_MODE_NOT_ALLOWED_FOR_FOUNDATION:${mode}`);
    const value = await cursor();
    const rows = await sourceRows(value, Math.min(Number(config.event_batch_size || 10), MAX_BATCH));
    for (const row of rows) {
      await ingest(row, config);
      await saveCursor(row);
    }
    const [jobs, breached] = await Promise.all([dueJobs(config), breachSla()]);
    await heartbeat("healthy", mode, { processed: rows.length, jobs_completed: jobs, sla_breached: breached });
  } catch (error) {
    console.error("[AIGUKA V9 shadow]", error?.message || error);
    await heartbeat("degraded", mode, {}, error?.message || error).catch(() => {});
  } finally {
    running = false;
    schedule(mode === "OFF" ? 30_000 : POLL_MS);
  }
}

if (!BASE || !KEY) console.warn("[AIGUKA V9 shadow] Supabase configuration missing; worker disabled");
else {
  schedule(2_000);
  console.log(`[AIGUKA V9 shadow] ${VERSION} started; poll=${POLL_MS}ms`);
}
