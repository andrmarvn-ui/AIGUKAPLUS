import { loadActiveMetaConnection } from "./meta-token-store.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const NAME = "aiguka-v10-followup";
const VERSION = "v10_followup_day_evening_v1";
const POLL_MS = Math.max(5000, Number(process.env.AIGUKA_V10_FOLLOWUP_POLL_MS || 10000));
const MAX_RETRIES = Math.max(1, Math.min(5, Number(process.env.AIGUKA_V10_FOLLOWUP_MAX_RETRIES || 3)));

let running = false;
let timer;
let tokenCache = { expiresAt: 0, values: new Map() };

function configured() {
  return Boolean(CORE_BASE && CORE_KEY);
}

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
    signal: AbortSignal.timeout(options.timeout || 30000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
  return data;
}

async function graph(path, token, options = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || 30000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `META_HTTP_${response.status}`);
    error.code = data?.error?.code || null;
    error.subcode = data?.error?.error_subcode || null;
    throw error;
  }
  return data;
}

async function configRow() {
  const rows = await core("v10_followup_config?select=*&id=eq.1&limit=1", { timeout: 10000 });
  return rows?.[0] || null;
}

async function runtimeRow() {
  const rows = await core("v9_runtime_config?select=mode,ingest_mode,external_bot_mode,external_bot_policy&id=eq.1&limit=1", { timeout: 10000 });
  return rows?.[0] || {};
}

async function pageRow(pageId) {
  const rows = await core(`v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,is_active,settings&page_id=eq.${encodeURIComponent(pageId)}&limit=1`, { timeout: 10000 });
  return rows?.[0] || null;
}

async function stateRow(pageId, senderId) {
  const rows = await core(`v9_conversation_state?select=state,contact_status,phone,zalo,human_takeover,human_takeover_until,last_customer_event_at,last_page_event_at&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&limit=1`, { timeout: 10000 });
  return rows?.[0] || {};
}

async function logRow(decisionId) {
  const rows = await core(`v10_followup_log?select=*&decision_id=eq.${encodeURIComponent(decisionId)}&limit=1`, { timeout: 10000 });
  return rows?.[0] || null;
}

async function pageTokens(force = false) {
  if (!force && tokenCache.expiresAt > Date.now()) return tokenCache.values;
  const connection = await loadActiveMetaConnection();
  if (!connection?.accessToken) throw new Error("META_OAUTH_CONNECTION_NOT_READY");
  const values = new Map();
  let next = "me/accounts?fields=id,name,access_token,tasks&limit=200";
  let pages = 0;
  while (next && pages++ < 10) {
    const data = await graph(next, connection.accessToken);
    for (const page of data.data || []) {
      if (page.id && page.access_token) values.set(String(page.id), page.access_token);
    }
    next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${GRAPH_VERSION}/`, "") : "";
  }
  tokenCache = { expiresAt: Date.now() + 5 * 60_000, values };
  return values;
}

async function pageToken(pageId) {
  const values = await pageTokens();
  return values.get(String(pageId)) || "";
}

async function enqueueDue(force = false) {
  return core("rpc/v10_enqueue_due_followups", {
    method: "POST",
    timeout: 45000,
    body: { p_limit: null, p_force: force },
  });
}

function parseTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function contactKnown(state = {}) {
  return Boolean(
    String(state.phone || "").trim()
    || String(state.zalo || "").trim()
    || ["captured", "verified", "known"].includes(String(state.contact_status || "").toLowerCase())
  );
}

function isRuntimeActive(runtime = {}) {
  return String(runtime.mode || "").toUpperCase() === "ACTIVE"
    && String(runtime.ingest_mode || "").toUpperCase() === "DIRECT_CORE"
    && String(runtime.external_bot_mode || "").toUpperCase() === "AICAKE_DISABLED"
    && String(runtime.external_bot_policy || "").toUpperCase() === "AIGUKA_PRIMARY";
}

async function claim(decision) {
  const rows = await core(`v9_decisions?id=eq.${decision.id}&status=eq.${encodeURIComponent(decision.status)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "followup_delivery_processing", updated_at: new Date().toISOString() },
  });
  return rows?.[0] || null;
}

async function patchDecision(decision, status, output = {}) {
  await core(`v9_decisions?id=eq.${decision.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status,
      output: { ...(decision.output || {}), ...output },
      updated_at: new Date().toISOString(),
    },
  });
}

async function patchLog(logId, body) {
  if (!logId) return;
  await core(`v10_followup_log?id=eq.${logId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { ...body, updated_at: new Date().toISOString() },
  });
}

async function suppress(decision, log, reason) {
  await patchDecision(decision, "followup_suppressed", {
    should_send: false,
    transport_locked: true,
    followup_suppression_reason: reason,
  });
  await patchLog(log?.id, { status: "suppressed", skip_reason: reason });
  return { sent: 0, suppressed: 1, failed: 0 };
}

async function sendText(pageId, senderId, text) {
  const token = await pageToken(pageId);
  if (!token) throw new Error(`PAGE_ACCESS_TOKEN_NOT_FOUND:${pageId}`);
  return graph(`${pageId}/messages`, token, {
    method: "POST",
    body: {
      recipient: { id: String(senderId) },
      messaging_type: "RESPONSE",
      message: { text },
    },
  });
}

async function processDecision(decision, config, runtime) {
  const retryAt = parseTime(decision?.output?.retry_not_before);
  if (retryAt && retryAt > Date.now()) return { sent: 0, suppressed: 0, failed: 0 };

  const claimed = await claim(decision);
  if (!claimed) return { sent: 0, suppressed: 0, failed: 0 };
  const log = await logRow(claimed.id);
  const followup = claimed.input_snapshot?.follow_up || claimed.output?.follow_up || {};

  if (!config?.enabled || !config?.delivery_enabled) return suppress(claimed, log, "FOLLOWUP_DISABLED");
  if (!isRuntimeActive(runtime)) return suppress(claimed, log, "RUNTIME_NOT_ACTIVE");

  const page = await pageRow(claimed.page_id);
  if (!page?.is_active || String(page.operating_mode || "").toUpperCase() !== "ACTIVE") return suppress(claimed, log, "PAGE_NOT_ACTIVE");
  if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_DISABLED") return suppress(claimed, log, "PAGE_EXTERNAL_BOT_ACTIVE");

  const state = await stateRow(claimed.page_id, claimed.sender_id);
  const takeoverUntil = parseTime(state.human_takeover_until);
  if (state.human_takeover && (!takeoverUntil || takeoverUntil > Date.now())) return suppress(claimed, log, "HUMAN_TAKEOVER");
  if (contactKnown(state)) return suppress(claimed, log, "CONTACT_ALREADY_KNOWN");

  const anchorPageAt = parseTime(followup.anchor_page_at || log?.anchor_page_at);
  const customerAt = parseTime(state.last_customer_event_at);
  const pageAt = parseTime(state.last_page_event_at);
  if (!anchorPageAt || !customerAt) return suppress(claimed, log, "FOLLOWUP_ANCHOR_INVALID");
  if (customerAt > anchorPageAt + 1000) return suppress(claimed, log, "CUSTOMER_REPLIED_AFTER_ANCHOR");
  if (pageAt > anchorPageAt + 1000) return suppress(claimed, log, "PAGE_OR_SALE_REPLIED_AFTER_ANCHOR");
  if (Date.now() - customerAt > Number(config.max_age_hours || 20) * 60 * 60_000) return suppress(claimed, log, "META_WINDOW_TOO_OLD");

  const output = claimed.output || {};
  const text = String(output.final_reply || "").replace(/\s+/g, " ").trim().slice(0, 640);
  if (claimed.action === "suppress" || !text) return suppress(claimed, log, "AI_SUPPRESSED");
  if (Number(claimed.confidence || output.confidence || 0) < 0.45) return suppress(claimed, log, "AI_CONFIDENCE_TOO_LOW");
  if (config.text_only && (output.needs_slides || claimed.action === "reply_with_slides")) return suppress(claimed, log, "TEXT_ONLY_MEDIA_DECISION");

  try {
    const result = await sendText(claimed.page_id, claimed.sender_id, text);
    const deliveredAt = new Date().toISOString();
    await patchDecision(claimed, "live_delivered", {
      should_send: true,
      transport_locked: false,
      delivered_at: deliveredAt,
      provider_message_id: result?.message_id || null,
      followup_delivery: true,
      followup_period: followup.period || log?.period || null,
    });
    await patchLog(log?.id, {
      status: "sent",
      attempts: Number(log?.attempts || 0) + 1,
      final_reply: text,
      provider_message_id: result?.message_id || null,
      sent_at: deliveredAt,
      last_error: null,
      next_retry_at: null,
    });
    await core(`v9_conversation_state?page_id=eq.${encodeURIComponent(claimed.page_id)}&sender_id=eq.${encodeURIComponent(claimed.sender_id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { state: "BOT_REPLIED", last_page_event_at: deliveredAt, updated_at: deliveredAt },
    }).catch(() => {});
    await core("v10_followup_config?id=eq.1", {
      method: "PATCH",
      prefer: "return=minimal",
      body: { last_delivery_at: deliveredAt, updated_at: deliveredAt },
    }).catch(() => {});
    return { sent: 1, suppressed: 0, failed: 0 };
  } catch (error) {
    const attempts = Number(log?.attempts || 0) + 1;
    const retry = attempts < MAX_RETRIES;
    const retryAtIso = new Date(Date.now() + Math.min(15 * 60_000, 60_000 * (2 ** Math.max(0, attempts - 1)))).toISOString();
    await patchDecision(claimed, retry ? "followup_delivery_retry" : "followup_delivery_error", {
      should_send: true,
      transport_locked: true,
      retry_not_before: retry ? retryAtIso : null,
      followup_delivery_error: String(error?.message || error).slice(0, 800),
    }).catch(() => {});
    await patchLog(log?.id, {
      status: retry ? "retry" : "failed",
      attempts,
      last_error: String(error?.message || error).slice(0, 800),
      next_retry_at: retry ? retryAtIso : null,
    }).catch(() => {});
    return { sent: 0, suppressed: 0, failed: 1 };
  }
}

async function heartbeat(status, config, details = {}, error = null) {
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: config?.enabled && config?.delivery_enabled ? "ACTIVE" : "OFF",
      details: {
        ...details,
        separate_from_live_reply: true,
        daytime_wait_minutes: Number(config?.day_wait_minutes || 240),
        evening_wait_minutes: Number(config?.evening_wait_minutes || 120),
        scan_interval_minutes: Number(config?.scan_interval_minutes || 15),
        one_per_conversation_cycle: true,
        ai_decision_required: true,
        text_only: config?.text_only !== false,
      },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function tick() {
  if (!configured() || running) return;
  running = true;
  let config = null;
  let scan = null;
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  try {
    config = await configRow();
    if (!config) throw new Error("FOLLOWUP_CONFIG_MISSING");
    const runtime = await runtimeRow();

    if (config.enabled) scan = await enqueueDue(false);
    if (config.enabled && config.delivery_enabled && isRuntimeActive(runtime)) {
      await pageTokens();
      const rows = await core("v9_decisions?select=id,page_id,sender_id,status,goal,action,confidence,input_snapshot,output,created_at,updated_at&goal=eq.follow_up_reengagement&status=in.(followup_ai_completed,followup_delivery_retry)&order=created_at.asc&limit=10");
      for (const decision of rows || []) {
        const result = await processDecision(decision, config, runtime);
        sent += result.sent;
        suppressed += result.suppressed;
        failed += result.failed;
      }
      await heartbeat(failed ? "degraded" : "healthy", config, {
        scan,
        candidates: rows?.length || 0,
        sent,
        suppressed,
        failed,
      }, failed ? `${failed} follow-up delivery(s) failed` : null);
    } else {
      await heartbeat("idle", config, { scan, sent, suppressed, failed, delivery_enabled: false });
    }
  } catch (error) {
    await heartbeat("degraded", config || {}, { scan, sent, suppressed, failed }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!configured()) {
  console.warn("[AIGUKA V10 follow-up] Core credentials missing; worker disabled");
} else {
  console.log("[AIGUKA V10 follow-up] daytime/evening re-engagement worker started");
  tick().catch(() => {});
}
