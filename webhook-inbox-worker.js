const SUPABASE_URL = String(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
).replace(/\/$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const WORKER_NAME = "aiguka-webhook-inbox-worker";
const WORKER_VERSION = "durable_inbox_v1";
const IDLE_POLL_MS = Math.max(2_000, Number(process.env.AIGUKA_WEBHOOK_INBOX_IDLE_MS || 3_000));
const BUSY_POLL_MS = Math.max(250, Number(process.env.AIGUKA_WEBHOOK_INBOX_BUSY_MS || 500));
const BATCH_SIZE = Math.min(3, Math.max(1, Number(process.env.AIGUKA_WEBHOOK_INBOX_BATCH || 1)));
const HEARTBEAT_MS = 5 * 60_000;

let running = false;
let timer = null;
let lastHeartbeatAt = 0;
let consecutiveErrors = 0;

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || data?.hint || `SUPABASE_HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const rpc = (name, body, timeout = 30_000) => request(`/rest/v1/rpc/${name}`, {
  method: "POST",
  body,
  timeout,
});

async function insertMetaEvent(event) {
  await request("/rest/v1/v8_meta_events?on_conflict=page_id%2Cmessage_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: [event],
    timeout: 60_000,
  });
}

async function processFeedChange(payload) {
  const pageId = String(payload.page_id || "");
  const change = payload.change || {};
  const value = change.value || {};
  const field = String(change.field || "");
  const item = String(value.item || "");
  const verb = String(value.verb || "");
  const commentId = String(value.comment_id || (item === "comment" ? value.post_id || "" : ""));

  if (field !== "feed" || item !== "comment" || !commentId) return;

  if (verb === "remove" || verb === "hide") {
    await request(`/rest/v1/v8_comment_events?page_id=eq.${encodeURIComponent(pageId)}&comment_id=eq.${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        lead_status: "removed",
        private_reply_status: "cancelled",
        updated_at: new Date().toISOString(),
      },
    });
    return;
  }
  if (verb !== "add" && verb !== "edited") return;

  const rawCreated = Number(value.created_time || Date.now());
  const eventTime = new Date(rawCreated < 10_000_000_000 ? rawCreated * 1000 : rawCreated).toISOString();
  await rpc("v8_register_comment_event", {
    p_page_id: pageId,
    p_comment_id: commentId,
    p_parent_id: value.parent_id == null ? null : String(value.parent_id),
    p_post_id: value.post_id == null ? null : String(value.post_id),
    p_sender_id: value.from?.id == null ? null : String(value.from.id),
    p_sender_name: value.from?.name == null ? null : String(value.from.name),
    p_message_text: value.message == null ? null : String(value.message),
    p_event_time: eventTime,
    p_verb: verb,
    p_item_type: item,
    p_raw_payload: { field, value },
  }, 45_000);
}

async function processMarketingOptin(payload) {
  const x = payload.marketing_optin || {};
  if (!x.page_id || !x.sender_id) return;
  await rpc("v8_record_marketing_optin", {
    p_page_id: String(x.page_id),
    p_sender_id: String(x.sender_id),
    p_optin: x.optin || {},
    p_event_time: x.event_time || new Date().toISOString(),
    p_raw_payload: x.raw_payload || {},
  }, 30_000);
}

async function processItem(item) {
  const payload = item.payload || {};
  const kind = String(payload.kind || "meta_event");
  if (kind === "meta_event") {
    if (!payload.event) throw new Error("WEBHOOK_INBOX_EVENT_MISSING");
    await insertMetaEvent(payload.event);
    if (payload.marketing_optin) await processMarketingOptin(payload);
    return;
  }
  if (kind === "feed_change") {
    await processFeedChange(payload);
    return;
  }
  throw new Error(`WEBHOOK_INBOX_KIND_UNSUPPORTED:${kind}`);
}

async function finish(id, success, error = null) {
  return rpc("v8_finish_webhook_inbox", {
    p_id: id,
    p_success: Boolean(success),
    p_error: error ? String(error).slice(0, 1000) : null,
  }, 20_000);
}

async function heartbeat(status, lastError, details = {}) {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
  await request("/rest/v1/v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    timeout: 8_000,
    body: {
      worker_name: WORKER_NAME,
      worker_type: "webhook_inbox",
      worker_version: WORKER_VERSION,
      status,
      capabilities: {
        durable_inbox: true,
        message_id_deduplication: true,
        retry_max_attempts: 20,
        batch_size: BATCH_SIZE,
        ...details,
      },
      last_error: lastError ? String(lastError).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  lastHeartbeatAt = now;
}

function schedule(delay) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => tick().catch(() => {}), delay);
  timer.unref?.();
}

async function tick() {
  if (!configured() || running) {
    schedule(IDLE_POLL_MS);
    return;
  }
  running = true;
  let claimed = [];
  let processed = 0;
  let failed = 0;
  try {
    claimed = await rpc("v8_claim_webhook_inbox_batch", {
      p_worker_name: WORKER_NAME,
      p_limit: BATCH_SIZE,
    }, 15_000) || [];

    for (const item of claimed) {
      try {
        await processItem(item);
        await finish(item.id, true);
        processed += 1;
        consecutiveErrors = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed += 1;
        consecutiveErrors += 1;
        await finish(item.id, false, message).catch(() => {});
        console.error(`[AIGUKA webhook inbox] ${item.id}: ${message}`);
        break;
      }
    }

    await heartbeat(failed ? "degraded" : "healthy", failed ? `${failed} item(s) failed` : null, {
      claimed_last_tick: claimed.length,
      processed_last_tick: processed,
      failed_last_tick: failed,
      consecutive_errors: consecutiveErrors,
    }).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    consecutiveErrors += 1;
    console.error(`[AIGUKA webhook inbox worker] ${message}`);
    await heartbeat("degraded", message, { consecutive_errors: consecutiveErrors }).catch(() => {});
  } finally {
    running = false;
    const pressureDelay = consecutiveErrors
      ? Math.min(120_000, Math.max(5_000, 2 ** Math.min(consecutiveErrors, 6) * 2_000))
      : null;
    schedule(pressureDelay || (claimed.length ? BUSY_POLL_MS : IDLE_POLL_MS));
  }
}

if (!configured()) {
  console.warn("[AIGUKA webhook inbox] Supabase configuration missing; worker disabled");
} else {
  schedule(1_000);
  console.log(`[AIGUKA webhook inbox] Durable processor started; batch=${BATCH_SIZE}`);
}
