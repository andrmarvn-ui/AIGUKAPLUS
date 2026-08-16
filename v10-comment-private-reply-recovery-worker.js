import { commentPrivateReplyEligibility } from "./v9/core/comment-private-reply.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-comment-private-reply-recovery";
const VERSION = "v10_comment_private_reply_recovery_v2_oldest_frontier_first";
const POLL_MS = Math.max(5_000, Number(process.env.AIGUKA_V10_COMMENT_RECOVERY_POLL_MS || 15_000));
const LOOKBACK_HOURS = Math.max(1, Math.min(72, Number(process.env.AIGUKA_V10_COMMENT_RECOVERY_HOURS || 24)));
const SCAN_LIMIT = Math.max(20, Math.min(500, Number(process.env.AIGUKA_V10_COMMENT_RECOVERY_LIMIT || 200)));

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
    signal: AbortSignal.timeout(options.timeout || 20_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
  return data;
}

async function runtime() {
  const rows = await core("v9_runtime_config?select=mode,response_sla_seconds&id=eq.1&limit=1", { timeout: 10_000 });
  return rows?.[0] || { mode: "OFF", response_sla_seconds: 45 };
}

async function conversationState(event) {
  const rows = await core(
    "v9_conversation_state?select=last_source_event_id,human_takeover,human_takeover_until"
      + "&page_id=eq." + encodeURIComponent(event.page_id)
      + "&sender_id=eq." + encodeURIComponent(event.customer_id)
      + "&limit=1",
    { timeout: 10_000 },
  );
  return rows?.[0] || null;
}

async function alreadyHandled(event) {
  const [decisions, jobs] = await Promise.all([
    core(
      "v9_decisions?select=id,status&source_event_id=eq." + encodeURIComponent(event.source_event_id)
        + "&limit=1",
      { timeout: 10_000 },
    ),
    core(
      "v9_jobs?select=id,status&source_event_id=eq." + encodeURIComponent(event.source_event_id)
        + "&job_type=eq.decision_shadow&limit=1",
      { timeout: 10_000 },
    ),
  ]);
  return Boolean(decisions?.length || jobs?.length);
}

async function ensureSla(event, responseSlaSeconds) {
  const receivedAt = Date.parse(event.received_at || event.occurred_at || "") || Date.now();
  const deadlineAt = new Date(receivedAt + Math.max(15, Number(responseSlaSeconds || 45)) * 1_000).toISOString();
  await core("v9_sla_events?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: {
      source_event_id: event.source_event_id,
      page_id: event.page_id,
      sender_id: event.customer_id,
      deadline_at: deadlineAt,
      status: "open",
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

async function enqueue(event, eligibility, responseSlaSeconds) {
  const now = new Date().toISOString();
  const rows = await core("v9_jobs?on_conflict=source_event_id,job_type", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: {
      source_event_id: event.source_event_id,
      event_id: event.id,
      job_type: "decision_shadow",
      dedupe_key: `${event.page_id}:${event.customer_id}:${event.source_event_id}`,
      page_id: event.page_id,
      sender_id: event.customer_id,
      status: "queued",
      run_after: now,
      payload: {
        source: "v10_comment_private_reply_recovery",
        delivery_mode: "comment_private_reply",
        comment_id: eligibility.commentId,
        public_reply_forbidden: true,
        frontier_safe: true,
      },
      attempts: 0,
      updated_at: now,
    },
  });
  if (rows?.[0]?.id) await ensureSla(event, responseSlaSeconds);
  return Boolean(rows?.[0]?.id);
}

async function recover(config) {
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60_000).toISOString();
  const events = await core(
    "v9_events?select=id,source_event_id,page_id,customer_id,message_text,payload,event_type,occurred_at,received_at"
      + "&event_type=eq.customer_comment"
      + "&received_at=gte." + encodeURIComponent(cutoff)
      + "&order=received_at.asc"
      + `&limit=${SCAN_LIMIT}`,
  );
  let eligible = 0;
  let enqueued = 0;
  let skippedFrontier = 0;
  let skippedHandled = 0;

  for (const event of events || []) {
    if (!event?.page_id || !event?.customer_id || !event?.source_event_id) continue;
    const eligibility = commentPrivateReplyEligibility({
      page_id: event.page_id,
      sender_id: event.customer_id,
      message_text: event.message_text,
      payload: event.payload,
    });
    if (!eligibility.eligible) continue;
    eligible += 1;

    const state = await conversationState(event);
    if (!state || String(state.last_source_event_id || "") !== String(event.source_event_id)) {
      skippedFrontier += 1;
      continue;
    }
    if (await alreadyHandled(event)) {
      skippedHandled += 1;
      continue;
    }
    if (await enqueue(event, eligibility, config.response_sla_seconds)) enqueued += 1;
  }

  return { scanned: events?.length || 0, eligible, enqueued, skippedFrontier, skippedHandled };
}

async function heartbeat(status, mode, details = {}, error = null) {
  if (status === "healthy" && Date.now() - lastHeartbeat < 30_000) return;
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode,
      details: {
        ...details,
        lookback_hours: LOOKBACK_HOURS,
        public_comment_reply_forbidden: true,
        delivery_mode: "comment_private_reply",
        customer_frontier_guard: true,
      },
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
  try {
    const config = await runtime();
    mode = String(config.mode || "OFF").toUpperCase();
    if (mode !== "ACTIVE") {
      await heartbeat("idle", mode, { recovery_enabled: false });
      return;
    }
    const result = await recover(config);
    await heartbeat("healthy", mode, { recovery_enabled: true, ...result });
  } catch (error) {
    await heartbeat("degraded", mode, { recovery_enabled: mode === "ACTIVE" }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), mode === "ACTIVE" ? POLL_MS : 30_000);
    timer.unref?.();
  }
}

if (!CORE_BASE || !CORE_KEY) {
  console.warn("[AIGUKA V10 comment private-reply recovery] Core credentials missing; disabled");
} else {
  console.log("[AIGUKA V10 comment private-reply recovery] actionable comments route to private Messenger only");
  tick().catch(() => {});
}

