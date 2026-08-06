import { loadActiveMetaConnection } from "./meta-token-store.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const NAME = "aiguka-v10-followup";
const VERSION = "v10_followup_v8_event_v2";
const POLL_MS = Math.max(5000, Number(process.env.AIGUKA_V10_FOLLOWUP_POLL_MS || 10000));
const MAX_RETRIES = Math.max(1, Math.min(5, Number(process.env.AIGUKA_V10_FOLLOWUP_MAX_RETRIES || 3)));
const PANCAKE_GUARD_REFRESH_MS = Math.max(5 * 60_000, Number(process.env.AIGUKA_V10_PANCAKE_GUARD_REFRESH_MS || 15 * 60_000));

let running = false;
let timer;
let lastHeartbeat = 0;
let lastGuardRefresh = 0;
let tokenCache = { expiresAt: 0, values: new Map() };

function configured() {
  return Boolean(CORE_BASE && CORE_KEY);
}

async function request(base, key, path, options = {}) {
  if (!base || !key) throw new Error("DATABASE_CONNECTION_NOT_READY");
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
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
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`);
  return data;
}

const core = (path, options = {}) => request(CORE_BASE, CORE_KEY, path, options);
const knowledge = (path, options = {}) => request(KNOWLEDGE_BASE, KNOWLEDGE_KEY, path, options);

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

async function previousFollowupLog(anchorDecisionId, followupNo) {
  if (Number(followupNo || 1) <= 1) return null;
  const rows = await core(`v10_followup_log?select=*&anchor_decision_id=eq.${encodeURIComponent(anchorDecisionId)}&followup_no=eq.${Number(followupNo) - 1}&status=in.(sent,sent_partial)&order=sent_at.desc&limit=1`, { timeout: 10000 });
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

function parseTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
}

function tagLabels(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : item?.text || item?.name || item?.label || "").map(String).filter(Boolean);
}

function hasContactTag(labels) {
  return labels.some((label) => /(^|\b)(sdt|so dien thoai|dien thoai|zalo)(\b|$)/i.test(normalized(label)));
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

function localMinutes(timezone = "Asia/Bangkok", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour || 0) * 60 + Number(values.minute || 0);
}

function clockMinutes(value, fallback) {
  const text = String(value || fallback || "00:00").slice(0, 5);
  const [hour, minute] = text.split(":").map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
}

function insideWindow(config, date = new Date()) {
  const now = localMinutes(config?.timezone || "Asia/Bangkok", date);
  const start = clockMinutes(config?.window_start, "08:00");
  const end = clockMinutes(config?.window_end, "22:30");
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

function scanDue(config) {
  const last = parseTime(config?.last_scan_at);
  return !last || Date.now() - last >= Number(config?.scan_interval_minutes || 180) * 60_000;
}

async function pancakeIdentity(pageId, senderId) {
  if (!KNOWLEDGE_BASE || !KNOWLEDGE_KEY) return { has: false, labels: [], updatedAt: null, checked: false };
  const path = `lt_conversation_identities?select=page_id,sender_id,customer_id,pancake_tags,updated_at&page_id=eq.${encodeURIComponent(pageId)}&or=(sender_id.eq.${encodeURIComponent(senderId)},customer_id.eq.${encodeURIComponent(senderId)})&order=updated_at.desc&limit=1`;
  const rows = await knowledge(path, { timeout: 12000 }).catch(() => []);
  let row = rows?.[0] || null;
  if (!row) {
    const fallback = await knowledge(`v8_pancake_conversation_cache?select=page_id,customer_id,staff_tags,synced_at&page_id=eq.${encodeURIComponent(pageId)}&customer_id=eq.${encodeURIComponent(senderId)}&order=synced_at.desc&limit=1`, { timeout: 12000 }).catch(() => []);
    row = fallback?.[0] || null;
  }
  const labels = tagLabels(row?.pancake_tags || row?.staff_tags || []);
  return { has: hasContactTag(labels), labels, updatedAt: row?.updated_at || row?.synced_at || null, checked: true };
}

async function saveGuard(pageId, senderId, guard) {
  await core("v10_followup_contact_guard?on_conflict=page_id,sender_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      page_id: String(pageId),
      sender_id: String(senderId),
      has_contact_tag: Boolean(guard.has),
      tag_labels: guard.labels || [],
      source_updated_at: guard.updatedAt || null,
      checked_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

async function refreshPancakeGuards(config) {
  if (!config?.use_pancake_contact_tags || !KNOWLEDGE_BASE || !KNOWLEDGE_KEY) return { checked: 0, tagged: 0, enabled: false };
  if (Date.now() - lastGuardRefresh < PANCAKE_GUARD_REFRESH_MS && !scanDue(config)) return { checked: 0, tagged: 0, cached: true };
  const since = new Date(Date.now() - Number(config.max_age_hours || 20) * 60 * 60_000).toISOString();
  const rows = await core(`v9_conversation_state?select=page_id,sender_id,last_customer_event_at&last_customer_event_at=gte.${encodeURIComponent(since)}&order=last_customer_event_at.desc&limit=${Math.min(100, Math.max(20, Number(config.max_per_run || 20) * 3))}`, { timeout: 15000 });
  let checked = 0;
  let tagged = 0;
  const queue = [...(rows || [])];
  const workers = Array.from({ length: Math.min(5, queue.length || 1) }, async () => {
    while (queue.length) {
      const row = queue.shift();
      const guard = await pancakeIdentity(row.page_id, row.sender_id);
      if (guard.checked) checked += 1;
      if (guard.has) tagged += 1;
      await saveGuard(row.page_id, row.sender_id, guard);
    }
  });
  await Promise.all(workers);
  lastGuardRefresh = Date.now();
  return { checked, tagged, enabled: true };
}

async function enqueueDue(force = false) {
  return core("rpc/v10_enqueue_due_followups", { method: "POST", timeout: 45000, body: { p_limit: null, p_force: force } });
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
    body: { status, output: { ...(decision.output || {}), ...output }, updated_at: new Date().toISOString() },
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
  await patchDecision(decision, "followup_suppressed", { should_send: false, transport_locked: true, followup_suppression_reason: reason });
  await patchLog(log?.id, { status: "suppressed", skip_reason: reason });
  return { sent: 0, suppressed: 1, failed: 0, partial: 0 };
}

async function sendText(pageId, senderId, text) {
  const token = await pageToken(pageId);
  if (!token) throw new Error(`PAGE_ACCESS_TOKEN_NOT_FOUND:${pageId}`);
  return graph(`${pageId}/messages`, token, { method: "POST", body: { recipient: { id: String(senderId) }, messaging_type: "RESPONSE", message: { text } } });
}

function validImageUrls(value) {
  const rows = Array.isArray(value) ? value : [];
  const unique = [];
  const seen = new Set();
  for (const item of rows) {
    try {
      const url = new URL(String(item || "").trim());
      if (!["http:", "https:"].includes(url.protocol) || seen.has(url.toString())) continue;
      seen.add(url.toString());
      unique.push(url.toString());
    } catch {}
  }
  return unique.slice(0, 10);
}

async function sendImage(pageId, senderId, imageUrl) {
  const token = await pageToken(pageId);
  if (!token) throw new Error(`PAGE_ACCESS_TOKEN_NOT_FOUND:${pageId}`);
  return graph(`${pageId}/messages`, token, {
    method: "POST",
    body: { recipient: { id: String(senderId) }, messaging_type: "RESPONSE", message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } } },
  });
}

async function processDecision(decision, config, runtime) {
  const retryAt = parseTime(decision?.output?.retry_not_before);
  if (retryAt && retryAt > Date.now()) return { sent: 0, suppressed: 0, failed: 0, partial: 0 };
  if (!insideWindow(config)) return { sent: 0, suppressed: 0, failed: 0, partial: 0 };

  const claimed = await claim(decision);
  if (!claimed) return { sent: 0, suppressed: 0, failed: 0, partial: 0 };
  const log = await logRow(claimed.id);
  const followup = claimed.input_snapshot?.follow_up || claimed.output?.follow_up || {};
  const followupNo = Number(log?.followup_no || followup.followup_no || 1);

  if (!config?.enabled || !config?.delivery_enabled) return suppress(claimed, log, "FOLLOWUP_DISABLED");
  if (!isRuntimeActive(runtime)) return suppress(claimed, log, "RUNTIME_NOT_ACTIVE");

  const page = await pageRow(claimed.page_id);
  if (!page?.is_active || String(page.operating_mode || "").toUpperCase() !== "ACTIVE") return suppress(claimed, log, "PAGE_NOT_ACTIVE");
  if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_DISABLED") return suppress(claimed, log, "PAGE_EXTERNAL_BOT_ACTIVE");

  const state = await stateRow(claimed.page_id, claimed.sender_id);
  const takeoverUntil = parseTime(state.human_takeover_until);
  if (state.human_takeover && (!takeoverUntil || takeoverUntil > Date.now())) return suppress(claimed, log, "HUMAN_TAKEOVER");
  if (contactKnown(state)) return suppress(claimed, log, "CONTACT_ALREADY_KNOWN");

  if (config.use_pancake_contact_tags) {
    const guard = await pancakeIdentity(claimed.page_id, claimed.sender_id);
    await saveGuard(claimed.page_id, claimed.sender_id, guard);
    if (guard.has) return suppress(claimed, log, "PANCAKE_CONTACT_TAG_FOUND");
  }

  const anchorPageAt = parseTime(followup.anchor_page_at || log?.anchor_page_at);
  const customerAt = parseTime(state.last_customer_event_at);
  const pageAt = parseTime(state.last_page_event_at);
  if (!anchorPageAt || !customerAt) return suppress(claimed, log, "FOLLOWUP_ANCHOR_INVALID");
  if (customerAt > anchorPageAt + 1000) return suppress(claimed, log, "CUSTOMER_REPLIED_AFTER_ANCHOR");

  const previous = await previousFollowupLog(log?.anchor_decision_id || followup.anchor_decision_id, followupNo);
  const allowedPageAt = followupNo <= 1 ? anchorPageAt : parseTime(previous?.sent_at);
  if (followupNo > 1 && !allowedPageAt) return suppress(claimed, log, "PREVIOUS_FOLLOWUP_NOT_SENT");
  if (pageAt > allowedPageAt + 2500) return suppress(claimed, log, "PAGE_OR_SALE_REPLIED_AFTER_LAST_FOLLOWUP");
  if (Date.now() - customerAt > Number(config.max_age_hours || 20) * 60 * 60_000) return suppress(claimed, log, "META_WINDOW_TOO_OLD");

  const output = claimed.output || {};
  const text = String(output.final_reply || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (claimed.action === "suppress" || !text) return suppress(claimed, log, "AI_SUPPRESSED");
  if (Number(claimed.confidence || output.confidence || 0) < 0.45) return suppress(claimed, log, "AI_CONFIDENCE_TOO_LOW");
  if (config.mode !== "event" && (output.needs_slides || claimed.action === "reply_with_slides")) return suppress(claimed, log, "DEFAULT_V8_UNPLANNED_MEDIA");

  const configuredImages = config.mode === "event" ? validImageUrls(output.event_image_urls || log?.image_urls || []) : [];
  const deliveredImages = new Set(validImageUrls(output.delivered_image_urls || []));
  const pendingImages = configuredImages.filter((url) => !deliveredImages.has(url));
  const textAlreadySent = Boolean(log?.provider_message_id || output.provider_message_id);
  const deliveredAt = new Date().toISOString();
  let textResult = null;
  let imageError = null;

  try {
    if (!textAlreadySent) {
      textResult = await sendText(claimed.page_id, claimed.sender_id, text);
      await patchLog(log?.id, { status: pendingImages.length ? "delivery_processing" : "sent", attempts: Number(log?.attempts || 0) + 1,
        final_reply: text, provider_message_id: textResult?.message_id || null, sent_at: deliveredAt, last_error: null, next_retry_at: null });
      claimed.output = { ...(claimed.output || {}), provider_message_id: textResult?.message_id || null };
    }

    for (const imageUrl of pendingImages) {
      try {
        await sendImage(claimed.page_id, claimed.sender_id, imageUrl);
        deliveredImages.add(imageUrl);
        await patchDecision(claimed, "followup_delivery_processing", { delivered_image_urls: [...deliveredImages], provider_message_id: textResult?.message_id || output.provider_message_id || log?.provider_message_id || null });
      } catch (error) {
        imageError = error;
        break;
      }
    }

    if (imageError) {
      const attempts = Number(log?.attempts || 0) + 1;
      const retry = attempts < MAX_RETRIES;
      const retryAtIso = new Date(Date.now() + Math.min(15 * 60_000, 60_000 * (2 ** Math.max(0, attempts - 1)))).toISOString();
      await patchDecision(claimed, retry ? "followup_delivery_retry" : "live_delivered", {
        should_send: true,
        transport_locked: retry,
        retry_not_before: retry ? retryAtIso : null,
        delivered_at: deliveredAt,
        provider_message_id: textResult?.message_id || output.provider_message_id || log?.provider_message_id || null,
        delivered_image_urls: [...deliveredImages],
        followup_delivery: true,
        followup_no: followupNo,
        event_media_partial: true,
        followup_delivery_error: String(imageError?.message || imageError).slice(0, 800),
      });
      await patchLog(log?.id, { status: retry ? "retry" : "sent_partial", attempts, sent_at: deliveredAt,
        last_error: String(imageError?.message || imageError).slice(0, 800), next_retry_at: retry ? retryAtIso : null });
      return { sent: retry ? 0 : 1, suppressed: 0, failed: retry ? 1 : 0, partial: 1 };
    }

    await patchDecision(claimed, "live_delivered", {
      should_send: true,
      transport_locked: false,
      delivered_at: deliveredAt,
      provider_message_id: textResult?.message_id || output.provider_message_id || log?.provider_message_id || null,
      delivered_image_urls: [...deliveredImages],
      followup_delivery: true,
      followup_no: followupNo,
      followup_mode: config.mode,
      event_image_count: configuredImages.length,
    });
    await patchLog(log?.id, { status: "sent", attempts: Math.max(1, Number(log?.attempts || 0)), final_reply: text,
      provider_message_id: textResult?.message_id || output.provider_message_id || log?.provider_message_id || null,
      sent_at: deliveredAt, last_error: null, next_retry_at: null });
    await core(`v9_conversation_state?page_id=eq.${encodeURIComponent(claimed.page_id)}&sender_id=eq.${encodeURIComponent(claimed.sender_id)}`, {
      method: "PATCH", prefer: "return=minimal", body: { state: "BOT_REPLIED", last_page_event_at: deliveredAt, updated_at: deliveredAt },
    }).catch(() => {});
    await core("v10_followup_config?id=eq.1", { method: "PATCH", prefer: "return=minimal", body: { last_delivery_at: deliveredAt, updated_at: deliveredAt } }).catch(() => {});
    return { sent: 1, suppressed: 0, failed: 0, partial: 0 };
  } catch (error) {
    const attempts = Number(log?.attempts || 0) + 1;
    const retry = attempts < MAX_RETRIES;
    const retryAtIso = new Date(Date.now() + Math.min(15 * 60_000, 60_000 * (2 ** Math.max(0, attempts - 1)))).toISOString();
    await patchDecision(claimed, retry ? "followup_delivery_retry" : "followup_delivery_error", {
      should_send: true, transport_locked: true, retry_not_before: retry ? retryAtIso : null,
      followup_delivery_error: String(error?.message || error).slice(0, 800), delivered_image_urls: [...deliveredImages],
    }).catch(() => {});
    await patchLog(log?.id, { status: retry ? "retry" : "failed", attempts,
      last_error: String(error?.message || error).slice(0, 800), next_retry_at: retry ? retryAtIso : null }).catch(() => {});
    return { sent: 0, suppressed: 0, failed: 1, partial: 0 };
  }
}

async function heartbeat(status, config, details = {}, error = null) {
  if (status === "healthy" && Date.now() - lastHeartbeat < 20000) return;
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME, worker_version: VERSION, status,
      mode: config?.enabled && config?.delivery_enabled ? "ACTIVE" : "OFF",
      details: {
        ...details,
        followup_mode: config?.mode || "default_v8",
        separate_from_live_reply: true,
        scan_interval_minutes: Number(config?.scan_interval_minutes || 180),
        window_start: String(config?.window_start || "08:00"),
        window_end: String(config?.window_end || "22:30"),
        first_wait_range_minutes: [Number(config?.first_wait_min_minutes || 180), Number(config?.first_wait_max_minutes || 240)],
        repeat_wait_minutes: Number(config?.repeat_wait_minutes || 360),
        max_followups_per_cycle: Number(config?.max_followups_per_cycle || 2),
        max_age_hours: Number(config?.max_age_hours || 20),
        pancake_contact_guard: config?.use_pancake_contact_tags !== false,
        ai_decision_required: config?.mode !== "event",
        event_images_enabled: config?.mode === "event",
      },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
  });
  lastHeartbeat = Date.now();
}

async function tick() {
  if (!configured() || running) return;
  running = true;
  let config = null;
  let scan = null;
  let guards = null;
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  let partial = 0;
  try {
    config = await configRow();
    if (!config) throw new Error("FOLLOWUP_CONFIG_MISSING");
    const runtime = await runtimeRow();

    if (config.enabled && insideWindow(config) && scanDue(config)) {
      guards = await refreshPancakeGuards(config);
      scan = await enqueueDue(false);
    }

    if (config.enabled && config.delivery_enabled && isRuntimeActive(runtime) && insideWindow(config)) {
      await pageTokens();
      const rows = await core("v9_decisions?select=id,page_id,sender_id,status,goal,action,confidence,input_snapshot,output,created_at,updated_at&goal=eq.follow_up_reengagement&status=in.(followup_ai_completed,followup_delivery_retry)&order=created_at.asc&limit=20");
      for (const decision of rows || []) {
        const result = await processDecision(decision, config, runtime);
        sent += result.sent;
        suppressed += result.suppressed;
        failed += result.failed;
        partial += result.partial;
      }
      await heartbeat(failed ? "degraded" : "healthy", config, { scan, guards, candidates: rows?.length || 0, sent, suppressed, failed, partial }, failed ? `${failed} follow-up delivery failure(s)` : null);
    } else {
      await heartbeat("idle", config, { scan, guards, reason: !insideWindow(config) ? "OUTSIDE_FOLLOWUP_WINDOW" : "FOLLOWUP_OR_RUNTIME_DISABLED" });
    }
  } catch (error) {
    await heartbeat("degraded", config || {}, { scan, guards, sent, suppressed, failed, partial }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!configured()) {
  console.warn("[AIGUKA V10 follow-up] Core credentials missing; disabled");
} else {
  console.log(`[AIGUKA V10 follow-up] ${VERSION} started: V8 default + Event mode, 2 touches/20h, Pancake contact guard`);
  tick().catch(() => {});
}
