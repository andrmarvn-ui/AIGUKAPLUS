import { buildConversationTurn } from "./v9/core/turn-builder.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v9-direct-core";
const VERSION = "v9_direct_core_worker_v1";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V9_CORE_POLL_MS || 5000));
const BATCH_SIZE = Math.max(1, Math.min(30, Number(process.env.AIGUKA_V9_CORE_BATCH || 10)));
let running = false;
let timer;
let lastHeartbeat = 0;

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

async function runtime() {
  const rows = await core("v9_runtime_config?select=mode,ingest_mode,debounce_seconds,response_sla_seconds,external_bot_mode,external_bot_policy&id=eq.1&limit=1", { timeout: 10000 });
  return rows?.[0] || { mode: "OFF", ingest_mode: "OFF" };
}

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const stale = await core(`v9_jobs?select=id,attempts&job_type=eq.decision_shadow&status=eq.processing&locked_at=lt.${encodeURIComponent(cutoff)}&limit=50`);
  for (const job of stale || []) {
    const attempts = Number(job.attempts || 0);
    await core(`v9_jobs?id=eq.${job.id}&status=eq.processing`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: attempts >= 5 ? "dead_letter" : "queued",
        locked_by: null,
        locked_at: null,
        run_after: new Date(Date.now() + Math.min(300000, Math.max(30000, attempts * 30000))).toISOString(),
        last_error: "stale_direct_core_claim_recovered",
        updated_at: new Date().toISOString(),
      },
    });
  }
  return stale?.length || 0;
}

async function claimJobs() {
  return core("rpc/v9_claim_jobs", {
    method: "POST",
    body: { p_worker: NAME, p_job_type: "decision_shadow", p_limit: BATCH_SIZE },
  });
}

function customerFromRow(row) {
  if (!row) return null;
  const profile = row.profile && typeof row.profile === "object" ? row.profile : {};
  return {
    display_name: row.display_name || null,
    gender: row.gender || null,
    gender_source: profile.gender_source || null,
    preferred_salutation: row.preferred_salutation || null,
    phone: null,
    zalo: null,
    last_product_key: profile.last_product_key || null,
    last_intent_type: profile.last_intent_type || null,
  };
}

async function conversation(job) {
  const [events, states, customers] = await Promise.all([
    core(`v9_events?select=source_event_id,source_system,actor_type,actor_evidence,event_type,message_text,attachments,referral,occurred_at&page_id=eq.${encodeURIComponent(job.page_id)}&customer_id=eq.${encodeURIComponent(job.sender_id)}&order=occurred_at.desc&limit=30`),
    core(`v9_conversation_state?select=human_takeover,human_takeover_until,contact_status,phone,zalo&page_id=eq.${encodeURIComponent(job.page_id)}&sender_id=eq.${encodeURIComponent(job.sender_id)}&limit=1`),
    core(`v9_customers?select=display_name,gender,preferred_salutation,profile&page_id=eq.${encodeURIComponent(job.page_id)}&customer_id=eq.${encodeURIComponent(job.sender_id)}&limit=1`),
  ]);
  return {
    events: [...(events || [])].reverse(),
    state: states?.[0] || {},
    customer: customerFromRow(customers?.[0] || null),
  };
}

async function saveTurn(job, turn) {
  if (!turn?.valid || !turn.customerMessages?.length) return null;
  const first = turn.customerMessages[0];
  const last = turn.customerMessages.at(-1);
  const rows = await core("v9_turns?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      source_event_id: job.source_event_id,
      page_id: job.page_id,
      sender_id: job.sender_id,
      started_at: first?.occurredAt || new Date().toISOString(),
      ended_at: last?.occurredAt || new Date().toISOString(),
      customer_event_ids: turn.customerMessages.map((item) => item.sourceEventId),
      combined_text: turn.combinedText || null,
      contact_detection: turn.contact || {},
      sales_signals: turn.salesSignals || {},
      response_evidence: turn.responseEvidence || {},
      action: turn.action,
      status: turn.action === "needs_ai_decision" ? "context_ready" : "suppressed",
      updated_at: new Date().toISOString(),
    },
  });
  return rows?.[0] || null;
}

async function saveDecision(job, turnRow, turn, customer, state, config) {
  const contextReady = turn?.action === "needs_ai_decision";
  await core("v9_decisions?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      source_event_id: job.source_event_id,
      turn_id: turnRow?.id || null,
      page_id: job.page_id,
      sender_id: job.sender_id,
      mode: "SHADOW",
      status: contextReady ? "shadow_context_ready" : "shadow_suppressed",
      goal: "capture_phone_or_zalo",
      action: turn?.action || "no_customer_turn",
      confidence: contextReady ? 0.7 : 1,
      input_snapshot: {
        page_id: job.page_id,
        turn: turn || { valid: false, action: "no_customer_turn" },
        customer,
        state,
        response_sla_seconds: config.response_sla_seconds,
        external_bot_mode: config.external_bot_mode,
        external_bot_policy: config.external_bot_policy,
      },
      output: {
        should_send: false,
        transport_locked: true,
        should_request_contact: Boolean(turn?.shouldRequestContact),
        reason: contextReady
          ? "Context ready for V9 AI shadow; transport remains disabled."
          : `Suppressed by ${turn?.action || "no_customer_turn"}.`,
      },
      updated_at: new Date().toISOString(),
    },
  });
}

async function complete(job) {
  await core(`v9_jobs?id=eq.${job.id}&status=eq.processing&locked_by=eq.${encodeURIComponent(NAME)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "completed",
      completed_at: new Date().toISOString(),
      locked_by: null,
      locked_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    },
  });
}

async function fail(job, error) {
  const attempts = Number(job.attempts || 0);
  await core(`v9_jobs?id=eq.${job.id}&locked_by=eq.${encodeURIComponent(NAME)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: attempts >= 5 ? "dead_letter" : "queued",
      run_after: new Date(Date.now() + Math.min(300000, Math.max(30000, attempts * 30000))).toISOString(),
      locked_by: null,
      locked_at: null,
      last_error: String(error?.message || error).slice(0, 800),
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

async function processJob(job, config) {
  const { events, state, customer } = await conversation(job);
  const turn = buildConversationTurn(events, {
    maxGapSeconds: Math.max(90, Number(config.debounce_seconds || 20) * 3),
    coexistenceMode: config.external_bot_mode || "AICAKE_ACTIVE",
    state,
  });
  const hasContact = Boolean(state.phone || state.zalo || customer?.phone || customer?.zalo || turn?.contact?.contactCaptured);
  if (hasContact && turn?.valid) {
    turn.action = "contact_captured";
    turn.shouldRequestContact = false;
  }
  const turnRow = await saveTurn(job, turn);
  await saveDecision(job, turnRow, turn, customer, state, config);
  await complete(job);
}

async function breachSla() {
  const now = new Date().toISOString();
  const rows = await core(`v9_sla_events?select=id&status=eq.open&deadline_at=lte.${encodeURIComponent(now)}&limit=100`);
  for (const row of rows || []) {
    await core(`v9_sla_events?id=eq.${row.id}&status=eq.open`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { status: "breached", updated_at: now },
    });
  }
  return rows?.length || 0;
}

async function heartbeat(status, mode, details = {}, error = null) {
  if (status === "healthy" && Date.now() - lastHeartbeat < 30000) return;
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
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
  if (!CORE_BASE || !CORE_KEY || running) return;
  running = true;
  let mode = "OFF";
  let completed = 0;
  let failed = 0;
  try {
    const config = await runtime();
    mode = String(config.mode || "OFF").toUpperCase();
    const ingestMode = String(config.ingest_mode || "OFF").toUpperCase();
    if (mode === "OFF" || ingestMode === "OFF") {
      await heartbeat("idle", mode, { ingest_mode: ingestMode });
      return;
    }
    if (mode !== "SHADOW") throw new Error(`V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE:${mode}`);
    if (ingestMode !== "DIRECT_CORE") throw new Error(`V9_INGEST_MODE_NOT_ALLOWED:${ingestMode}`);

    const recovered = await recoverStaleJobs();
    const jobs = await claimJobs();
    for (const job of jobs || []) {
      try {
        await processJob(job, config);
        completed += 1;
      } catch (error) {
        failed += 1;
        await fail(job, error);
      }
    }
    const breached = await breachSla();
    await heartbeat(failed ? "degraded" : "healthy", mode, {
      ingest_mode: ingestMode,
      jobs_claimed: jobs?.length || 0,
      jobs_completed: completed,
      jobs_failed: failed,
      stale_jobs_recovered: recovered,
      sla_breached: breached,
      external_bot_mode: config.external_bot_mode,
      external_bot_policy: config.external_bot_policy,
      legacy_reads: 0,
      outbound_enabled: false,
    }, failed ? `${failed} direct Core job(s) failed` : null);
  } catch (error) {
    await heartbeat("degraded", mode, { legacy_reads: 0, outbound_enabled: false }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), mode === "OFF" ? 30000 : POLL_MS);
    timer.unref?.();
  }
}

if (!CORE_BASE || !CORE_KEY) {
  console.warn("[AIGUKA V9 direct Core] isolated Core configuration missing; disabled");
} else {
  console.log("[AIGUKA V9 direct Core] started; legacy reads=0; outbound locked");
  tick().catch(() => {});
}
