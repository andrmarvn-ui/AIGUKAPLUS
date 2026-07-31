import { loadActiveMetaConnection } from "./meta-token-store.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const NAME = "aiguka-v9-live-outbound";
const VERSION = "v9_live_outbound_v1";
const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_V9_LIVE_OUTBOUND_POLL_MS || 3000));
const MAX_DECISION_AGE_MS = Math.max(60_000, Number(process.env.AIGUKA_V9_LIVE_MAX_AGE_MS || 15 * 60_000));

let running = false;
let timer;
let tokenCache = { expiresAt: 0, values: new Map() };
let knowledgeCache = { expiresAt: 0, content: null };
let lastHeartbeat = 0;

function configured() {
  return Boolean(CORE_BASE && CORE_KEY && KNOWLEDGE_BASE && KNOWLEDGE_KEY);
}

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
    signal: AbortSignal.timeout(options.timeout || 25_000),
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

function knowledge(path, options = {}) {
  return request(KNOWLEDGE_BASE, KNOWLEDGE_KEY, path, options);
}

async function graph(path, token, options = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `META_HTTP_${response.status}`);
    error.code = data?.error?.code || null;
    error.subcode = data?.error?.error_subcode || null;
    error.details = data?.error || data;
    throw error;
  }
  return data;
}

async function runtime() {
  const rows = await core("v9_runtime_config?select=mode,external_bot_mode,external_bot_policy,ingest_mode&id=eq.1&limit=1", { timeout: 10_000 });
  return rows?.[0] || { mode: "OFF", external_bot_mode: "UNKNOWN", external_bot_policy: "UNKNOWN" };
}

async function pageRow(pageId) {
  const rows = await core(`v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,is_active,settings&page_id=eq.${encodeURIComponent(pageId)}&limit=1`, { timeout: 10_000 });
  return rows?.[0] || null;
}

async function stateRow(pageId, senderId) {
  const rows = await core(`v9_conversation_state?select=state,contact_status,phone,zalo,human_takeover,human_takeover_until,last_customer_event_at,last_page_event_at&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&limit=1`, { timeout: 10_000 });
  return rows?.[0] || {};
}

async function pageTokens(force = false) {
  if (!force && tokenCache.expiresAt > Date.now()) return tokenCache.values;
  const values = new Map();
  const connection = await loadActiveMetaConnection();
  if (!connection?.accessToken) throw new Error("META_OAUTH_CONNECTION_NOT_READY");
  let next = "me/accounts?fields=id,name,access_token,tasks&limit=200";
  let pages = 0;
  while (next && pages++ < 10) {
    const data = await graph(next, connection.accessToken);
    for (const page of data.data || []) {
      if (page.id && page.access_token) values.set(String(page.id), { token: page.access_token, name: page.name, tasks: page.tasks || [] });
    }
    next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${GRAPH_VERSION}/`, "") : "";
  }
  tokenCache = { expiresAt: Date.now() + 5 * 60_000, values };
  return values;
}

async function pageToken(pageId) {
  const values = await pageTokens();
  return values.get(String(pageId))?.token || "";
}

async function publishedKnowledge() {
  if (knowledgeCache.content && knowledgeCache.expiresAt > Date.now()) return knowledgeCache.content;
  const configs = await knowledge("ai_runtime_config?select=published_snapshot_id,cache_ttl_seconds,mode&id=eq.1&limit=1", { timeout: 10_000 });
  const config = configs?.[0];
  if (!config?.published_snapshot_id || config.mode === "OFF") throw new Error("V9_KNOWLEDGE_NOT_PUBLISHED");
  const rows = await knowledge(`ai_published_snapshots?select=content&id=eq.${encodeURIComponent(config.published_snapshot_id)}&status=eq.published&limit=1`, { timeout: 15_000 });
  const content = rows?.[0]?.content || {};
  const ttl = Math.max(30_000, Math.min(10 * 60_000, Number(config.cache_ttl_seconds || 300) * 1000));
  knowledgeCache = { content, expiresAt: Date.now() + ttl };
  return content;
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

async function resolveAssets(decision) {
  const needsSlides = Boolean(decision?.output?.needs_slides || decision.action === "reply_with_slides");
  if (!needsSlides) return [];
  const selected = new Set(decision?.output?.selected_knowledge?.catalog_keys || []);
  const products = new Set((decision?.output?.products || []).map((value) => String(value).toLowerCase()));
  const content = await publishedKnowledge();
  const nodes = Array.isArray(content.catalog) ? content.catalog : [];
  const candidates = nodes.filter((node) => {
    if (selected.has(node.catalog_key)) return true;
    const text = [node.catalog_key, node.display_name, ...(node.aliases || [])].filter(Boolean).join(" ").toLowerCase();
    return [...products].some((product) => product && text.includes(product));
  });
  const assets = [];
  const seen = new Set();
  for (const node of candidates) {
    for (const asset of Array.isArray(node.assets) ? node.assets : []) {
      const sourceUrl = validHttpUrl(asset.source_url);
      if (!sourceUrl || seen.has(sourceUrl)) continue;
      seen.add(sourceUrl);
      assets.push({
        asset_id: asset.asset_id || null,
        catalog_key: node.catalog_key,
        title: node.display_name || "Mẫu sản phẩm",
        source_url: sourceUrl,
        sort_order: Number(asset.sort_order || 0),
      });
      if (assets.length >= 10) return assets;
    }
  }
  return assets;
}

function isAfterOrEqual(a, b) {
  const left = Date.parse(a || "");
  const right = Date.parse(b || "");
  return Number.isFinite(left) && Number.isFinite(right) && left >= right;
}

async function finalGate(decision, config) {
  if (String(config.mode || "").toUpperCase() !== "ACTIVE") return { allowed: false, reason: "RUNTIME_NOT_ACTIVE" };
  if (String(config.ingest_mode || "").toUpperCase() !== "DIRECT_CORE") return { allowed: false, reason: "INGEST_NOT_DIRECT_CORE" };
  if (String(config.external_bot_mode || "").toUpperCase() !== "AICAKE_DISABLED") return { allowed: false, reason: "EXTERNAL_BOT_NOT_DISABLED" };
  if (String(config.external_bot_policy || "").toUpperCase() !== "AIGUKA_PRIMARY") return { allowed: false, reason: "AIGUKA_NOT_PRIMARY" };

  const page = await pageRow(decision.page_id);
  if (!page?.is_active || String(page.operating_mode || "").toUpperCase() !== "ACTIVE") return { allowed: false, reason: "PAGE_NOT_ACTIVE" };
  if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_DISABLED") return { allowed: false, reason: "PAGE_EXTERNAL_BOT_NOT_DISABLED" };

  const cutover = page?.settings?.active_cutover_at;
  if (!cutover || !isAfterOrEqual(decision.created_at, cutover)) return { allowed: false, reason: "PRE_CUTOVER_DECISION" };
  if (Date.now() - Date.parse(decision.created_at) > MAX_DECISION_AGE_MS) return { allowed: false, reason: "DECISION_TOO_OLD" };

  const output = decision.output || {};
  const text = String(output.final_reply || "").trim();
  if (!text || ["suppress", "contact_captured"].includes(decision.action)) return { allowed: false, reason: "NO_SEND_ACTION" };
  if (Number(decision.confidence || output.confidence || 0) < 0.55) return { allowed: false, reason: "CONFIDENCE_TOO_LOW" };

  const state = await stateRow(decision.page_id, decision.sender_id);
  const takeoverUntil = Date.parse(state.human_takeover_until || "");
  if (state.human_takeover && (!Number.isFinite(takeoverUntil) || takeoverUntil > Date.now())) return { allowed: false, reason: "HUMAN_TAKEOVER" };
  if (state.phone || state.zalo || ["captured", "verified"].includes(String(state.contact_status || "").toLowerCase())) return { allowed: false, reason: "CONTACT_ALREADY_CAPTURED" };
  if (state.last_page_event_at && state.last_customer_event_at && isAfterOrEqual(state.last_page_event_at, state.last_customer_event_at)) {
    return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };
  }
  return { allowed: true, page, state, text };
}

async function claim(decision) {
  const rows = await core(`v9_decisions?id=eq.${decision.id}&status=eq.${encodeURIComponent(decision.status)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "live_delivery_processing", updated_at: new Date().toISOString() },
  });
  return rows?.[0] || null;
}

async function bundleFor(decision, text, assets) {
  const rows = await core("v9_delivery_bundles?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      decision_id: decision.id,
      page_id: decision.page_id,
      sender_id: decision.sender_id,
      text_body: text,
      asset_refs: assets,
      status: "staged",
      idempotency_key: `v9-decision:${decision.id}`,
      updated_at: new Date().toISOString(),
    },
  });
  return rows?.[0];
}

async function attempts(bundleId) {
  return core(`v9_delivery_attempts?select=attempt_no,transport,status,provider_message_id&bundle_id=eq.${bundleId}&order=attempt_no.asc`);
}

async function recordAttempt(bundleId, attemptNo, transport, status, result = {}, error = null) {
  await core("v9_delivery_attempts?on_conflict=bundle_id,attempt_no", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      bundle_id: bundleId,
      attempt_no: attemptNo,
      transport,
      status,
      provider_message_id: result?.message_id || null,
      provider_response: result && typeof result === "object" ? result : {},
      error_code: error?.code ? String(error.code) : null,
      error_message: error ? String(error.message || error).slice(0, 800) : null,
      completed_at: new Date().toISOString(),
    },
  });
}

async function sendText(pageId, senderId, text) {
  const token = await pageToken(pageId);
  if (!token) throw new Error(`PAGE_ACCESS_TOKEN_NOT_FOUND:${pageId}`);
  return graph(`${pageId}/messages`, token, {
    method: "POST",
    body: { recipient: { id: String(senderId) }, messaging_type: "RESPONSE", message: { text } },
  });
}

async function sendCarousel(pageId, senderId, assets) {
  const token = await pageToken(pageId);
  if (!token) throw new Error(`PAGE_ACCESS_TOKEN_NOT_FOUND:${pageId}`);
  const elements = assets.slice(0, 10).map((asset, index) => ({
    title: `${asset.title || "Mẫu sản phẩm"} ${index + 1}`.slice(0, 80),
    image_url: asset.source_url,
  }));
  if (!elements.length) return null;
  return graph(`${pageId}/messages`, token, {
    method: "POST",
    body: {
      recipient: { id: String(senderId) },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "template", payload: { template_type: "generic", elements } } },
    },
  });
}

async function patchDecision(decision, status, details = {}) {
  await core(`v9_decisions?id=eq.${decision.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status,
      output: { ...(decision.output || {}), ...details },
      updated_at: new Date().toISOString(),
    },
  });
}

async function processDecision(decision, config) {
  const claimed = await claim(decision);
  if (!claimed) return { sent: 0, suppressed: 0, failed: 0 };
  const gate = await finalGate(claimed, config);
  if (!gate.allowed) {
    await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason });
    return { sent: 0, suppressed: 1, failed: 0 };
  }

  const assets = await resolveAssets(claimed).catch(() => []);
  const bundle = await bundleFor(claimed, gate.text, assets);
  const existing = await attempts(bundle.id);
  let nextAttempt = Math.max(0, ...(existing || []).map((item) => Number(item.attempt_no || 0))) + 1;
  const textAlreadySent = (existing || []).some((item) => item.transport === "meta_messenger_text" && item.status === "sent");
  const slidesAlreadySent = (existing || []).some((item) => item.transport === "meta_messenger_carousel" && item.status === "sent");

  try {
    let textResult = null;
    if (!textAlreadySent) {
      textResult = await sendText(claimed.page_id, claimed.sender_id, gate.text);
      await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_text", "sent", textResult);
      await core(`v9_delivery_bundles?id=eq.${bundle.id}`, { method: "PATCH", prefer: "return=minimal", body: { status: assets.length ? "text_sent" : "sent", updated_at: new Date().toISOString() } });
    }

    let slideResult = null;
    let mediaWarning = null;
    if (assets.length && !slidesAlreadySent) {
      try {
        slideResult = await sendCarousel(claimed.page_id, claimed.sender_id, assets);
        if (slideResult) await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_carousel", "sent", slideResult);
      } catch (error) {
        mediaWarning = String(error.message || error).slice(0, 500);
        await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_carousel", "failed", {}, error);
      }
    } else if (Boolean(claimed?.output?.needs_slides || claimed.action === "reply_with_slides") && !assets.length) {
      mediaWarning = "NO_PUBLISHED_ASSET_MATCH";
    }

    const partial = Boolean(mediaWarning);
    await core(`v9_delivery_bundles?id=eq.${bundle.id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { status: partial ? "partial" : "sent", updated_at: new Date().toISOString() },
    });
    await patchDecision(claimed, partial ? "live_delivered_partial" : "live_delivered", {
      should_send: true,
      transport_locked: false,
      delivery_bundle_id: bundle.id,
      provider_message_id: textResult?.message_id || (existing || []).find((item) => item.transport === "meta_messenger_text" && item.status === "sent")?.provider_message_id || null,
      delivered_at: new Date().toISOString(),
      media_warning: mediaWarning,
    });
    await core(`v9_conversation_state?page_id=eq.${encodeURIComponent(claimed.page_id)}&sender_id=eq.${encodeURIComponent(claimed.sender_id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { state: "BOT_REPLIED", last_page_event_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }).catch(() => {});
    return { sent: 1, suppressed: 0, failed: 0 };
  } catch (error) {
    await recordAttempt(bundle.id, nextAttempt, "meta_messenger_text", "failed", {}, error).catch(() => {});
    await core(`v9_delivery_bundles?id=eq.${bundle.id}`, { method: "PATCH", prefer: "return=minimal", body: { status: "failed", updated_at: new Date().toISOString() } }).catch(() => {});
    await patchDecision(claimed, "live_delivery_failed", {
      should_send: true,
      transport_locked: false,
      delivery_bundle_id: bundle.id,
      live_delivery_error: String(error.message || error).slice(0, 800),
    }).catch(() => {});
    return { sent: 0, suppressed: 0, failed: 1 };
  }
}

async function heartbeat(status, mode, details = {}, error = null) {
  if (status === "healthy" && Date.now() - lastHeartbeat < 20_000) return;
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
  if (!configured() || running) return;
  running = true;
  let mode = "OFF";
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  try {
    const config = await runtime();
    mode = String(config.mode || "OFF").toUpperCase();
    if (mode !== "ACTIVE") {
      await heartbeat("idle", mode, { outbound_enabled: false, external_bot_mode: config.external_bot_mode, policy: config.external_bot_policy });
      return;
    }
    await pageTokens();
    const rows = await core("v9_decisions?select=id,page_id,sender_id,source_event_id,status,action,confidence,output,created_at,updated_at&status=in.(shadow_ai_completed,live_delivery_failed)&order=created_at.asc&limit=10");
    for (const decision of rows || []) {
      const result = await processDecision(decision, config);
      sent += result.sent;
      suppressed += result.suppressed;
      failed += result.failed;
    }
    await heartbeat(failed ? "degraded" : "healthy", mode, {
      outbound_enabled: true,
      external_bot_mode: config.external_bot_mode,
      policy: config.external_bot_policy,
      candidates: rows?.length || 0,
      sent,
      suppressed,
      failed,
      final_gate: true,
      idempotent: true,
      historical_replay: false,
    }, failed ? `${failed} live delivery(s) failed` : null);
  } catch (error) {
    await heartbeat("degraded", mode, { outbound_enabled: mode === "ACTIVE", sent, suppressed, failed }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), mode === "ACTIVE" ? POLL_MS : 15_000);
    timer.unref?.();
  }
}

if (!configured()) {
  console.warn("[AIGUKA V9 live outbound] Core/Knowledge credentials missing; disabled");
} else {
  console.log("[AIGUKA V9 live outbound] final-gated Messenger transport started; idle until runtime ACTIVE");
  tick().catch(() => {});
}
