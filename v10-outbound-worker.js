import { loadActiveMetaConnection } from "./meta-token-store.js";
import { normalizeVietnamese } from "./v10/core/advisory-engine.js";
import { prepareCarouselAssets } from "./v10/core/carousel-media.js";
import { prioritizeOutboundDecisions } from "./v10/core/outbound-priority.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const NAME = "aiguka-v10-outbound";
const VERSION = "v10_outbound_safety_only_v2_sla_priority";
const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_V10_OUTBOUND_POLL_MS || 3000));
const MAX_DECISION_AGE_MS = Math.max(15 * 60_000, Number(process.env.AIGUKA_V10_LIVE_MAX_AGE_MS || 2 * 60 * 60_000));
const MAX_MEDIA_ASSETS = Math.max(10, Math.min(20, Number(process.env.AIGUKA_V10_MAX_MEDIA_ASSETS || 20)));
const CANDIDATE_SCAN_LIMIT = Math.max(20, Math.min(200, Number(process.env.AIGUKA_V10_OUTBOUND_SCAN_LIMIT || 100)));
const DELIVERY_BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.AIGUKA_V10_OUTBOUND_BATCH || 10)));
let running = false;
let timer;
let lastHeartbeat = 0;
let tokenCache = { expiresAt: 0, values: new Map() };
let knowledgeCache = { expiresAt: 0, content: null };

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
    signal: AbortSignal.timeout(options.timeout || 25000),
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
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
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

async function runtime() {
  const rows = await core("v9_runtime_config?select=mode,external_bot_mode,external_bot_policy,ingest_mode,response_sla_seconds&id=eq.1&limit=1", { timeout: 10000 });
  return rows?.[0] || { mode: "OFF", ingest_mode: "OFF" };
}

async function pageRow(pageId) {
  const rows = await core(`v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,is_active,settings&page_id=eq.${encodeURIComponent(pageId)}&limit=1`, { timeout: 10000 });
  return rows?.[0] || null;
}

async function stateRow(pageId, senderId) {
  const rows = await core(`v9_conversation_state?select=state,contact_status,phone,zalo,human_takeover,human_takeover_until,last_customer_event_at,last_page_event_at&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&limit=1`, { timeout: 10000 });
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
  const configs = await knowledge("ai_runtime_config?select=published_snapshot_id,cache_ttl_seconds,mode&id=eq.1&limit=1", { timeout: 10000 });
  const config = configs?.[0];
  if (!config?.published_snapshot_id || config.mode === "OFF") throw new Error("V10_KNOWLEDGE_NOT_PUBLISHED");
  const rows = await knowledge(`ai_published_snapshots?select=content&id=eq.${encodeURIComponent(config.published_snapshot_id)}&status=eq.published&limit=1`, { timeout: 15000 });
  const content = rows?.[0]?.content || {};
  const ttl = Math.max(30000, Math.min(10 * 60_000, Number(config.cache_ttl_seconds || 300) * 1000));
  knowledgeCache = { content, expiresAt: Date.now() + ttl };
  return content;
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function nodeText(node = {}) {
  return normalizeVietnamese([node.catalog_key, node.display_name, ...(Array.isArray(node.aliases) ? node.aliases : [])].filter(Boolean).join(" "));
}

function roundRobinAssets(groups) {
  const output = [];
  let cursor = 0;
  while (output.length < MAX_MEDIA_ASSETS) {
    let added = false;
    for (const group of groups) {
      if (cursor < group.assets.length) {
        output.push(group.assets[cursor]);
        added = true;
        if (output.length >= MAX_MEDIA_ASSETS) break;
      }
    }
    if (!added) break;
    cursor += 1;
  }
  return output;
}

async function resolveAssets(decision) {
  const output = decision.output || {};
  if (!output.needs_slides && decision.action !== "reply_with_slides") return { assets: [], catalog_keys: [] };
  const content = await publishedKnowledge();
  const nodes = Array.isArray(content.catalog) ? content.catalog : [];
  const selectedCatalogKeys = new Set((output.selected_catalog_keys || []).map(String));
  const selectedProducts = (output.selected_products || []).map((value) => normalizeVietnamese(value));
  const candidates = nodes.filter((node) => {
    if (selectedCatalogKeys.has(String(node.catalog_key))) return true;
    const text = nodeText(node);
    return selectedProducts.some((product) => product && (text.includes(product) || product.includes(normalizeVietnamese(node.catalog_key))));
  });

  const seen = new Set();
  const groups = [];
  for (const node of candidates) {
    const assets = [];
    for (const asset of Array.isArray(node.assets) ? node.assets : []) {
      const sourceUrl = validHttpUrl(asset.source_url);
      if (!sourceUrl || seen.has(sourceUrl)) continue;
      seen.add(sourceUrl);
      assets.push({
        asset_id: asset.asset_id || null,
        catalog_key: node.catalog_key,
        title: asset.title || node.display_name || "Mẫu sản phẩm",
        source_url: sourceUrl,
        sort_order: Number(asset.sort_order || 0),
      });
    }
    assets.sort((a, b) => a.sort_order - b.sort_order);
    if (assets.length) groups.push({ catalog_key: node.catalog_key, assets });
  }
  return { assets: roundRobinAssets(groups), catalog_keys: groups.map((group) => group.catalog_key) };
}

function isAfterOrEqual(a, b) {
  const left = Date.parse(a || "");
  const right = Date.parse(b || "");
  return Number.isFinite(left) && Number.isFinite(right) && left >= right;
}

function stripRepeatedContactRequest(value) {
  return String(value || "")
    .replace(/[^.!?\n]*(?:sdt|số điện thoại|zalo)[^.!?\n]*[.!?]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function latestCustomerAt(decision) {
  const messages = decision?.input_snapshot?.conversation?.messages || [];
  return Math.max(0, ...messages.filter((message) => message.role === "customer").map((message) => Date.parse(message.occurred_at || "")).filter(Number.isFinite));
}

function pageReplyAfterLatestCustomerInOrder(messages = []) {
  let latestCustomerIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role === "customer") {
      latestCustomerIndex = index;
      break;
    }
  }
  if (latestCustomerIndex < 0) return false;
  return messages.slice(latestCustomerIndex + 1).some(function (message) {
    return message && ["human", "bot", "automation", "page"].includes(message.role);
  });
}

// AIGUKA_V10_OUTBOUND_REPLY_ORDER_V1

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

  const conversation = decision?.input_snapshot?.conversation || {};
  if (conversation?.safety?.opt_out) return { allowed: false, reason: "OPT_OUT" };
  const snapshotPageReplyAfterLatestCustomer = pageReplyAfterLatestCustomerInOrder(conversation?.messages || []);
  const output = decision.output || {};
  let text = String(output.final_reply || "").trim();
  if (!text || decision.action === "suppress") return { allowed: false, reason: "NO_SEND_ACTION" };
  if (Number(decision.confidence || output.confidence || 0) < 0.45) return { allowed: false, reason: "CONFIDENCE_TOO_LOW" };

  const state = await stateRow(decision.page_id, decision.sender_id);
  const takeoverUntil = Date.parse(state.human_takeover_until || "");
  if (state.human_takeover && (!Number.isFinite(takeoverUntil) || takeoverUntil > Date.now())) return { allowed: false, reason: "HUMAN_TAKEOVER" };
  const customerAt = latestCustomerAt(decision);
  const pageAt = Date.parse(state.last_page_event_at || "");
  const pageClearlyAfterCustomer = customerAt > 0 && Number.isFinite(pageAt) && pageAt > customerAt + 1000;
  const pageOrderedAfterCustomer = customerAt > 0 && Number.isFinite(pageAt) && pageAt >= customerAt && snapshotPageReplyAfterLatestCustomer;
  if (pageClearlyAfterCustomer || pageOrderedAfterCustomer) return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };

  const contactKnown = Boolean(state.phone || state.zalo || ["captured", "verified"].includes(String(state.contact_status || "").toLowerCase()));
  if (contactKnown && output.should_request_contact) {
    text = stripRepeatedContactRequest(text) || "Dạ em đã nhận nội dung của anh/chị và tiếp tục tư vấn tại Messenger ạ.";
  }
  return { allowed: true, page, state, text, contactKnown };
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
      idempotency_key: `v10-decision:${decision.id}`,
      updated_at: new Date().toISOString(),
    },
  });
  return rows?.[0];
}

async function attempts(bundleId) {
  return core(`v9_delivery_attempts?select=attempt_no,transport,status,provider_message_id&bundle_id=eq.${bundleId}&order=attempt_no.asc`);
}

async function recordAttempt(bundleId, attemptNo, transport, status, result = {}, error = null) {
  const now = new Date().toISOString();
  await core("v9_delivery_attempts?on_conflict=bundle_id,attempt_no", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      bundle_id: bundleId,
      attempt_no: attemptNo,
      transport,
      status,
      provider_message_id: result?.message_id || result?.messageId || null,
      provider_response: result && typeof result === "object" ? result : null,
      error_code: error?.code || null,
      error_message: error ? String(error.message || error).slice(0, 500) : null,
      started_at: now,
      completed_at: now,
    },
  });
}

async function sendText(pageId, recipientId, text) {
  const token = await pageToken(pageId);
  if (!token) throw new Error(`META_PAGE_TOKEN_NOT_FOUND:${pageId}`);
  return graph("me/messages", token, { method: "POST", body: { messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { text } } });
}

async function sendCarousel(pageId, recipientId, assets) {
  if (!assets.length) return null;
  const token = await pageToken(pageId);
  if (!token) throw new Error(`META_PAGE_TOKEN_NOT_FOUND:${pageId}`);
  const elements = assets.slice(0, 10).map((asset, index) => ({
    title: String(asset.title || `Mẫu ${index + 1}`).slice(0, 80),
    image_url: asset.source_url,
    default_action: {
      type: "web_url",
      url: asset.source_url,
      webview_height_ratio: "full",
    },
    subtitle: "Một vài mẫu bán chạy để anh/chị tham khảo trước",
  }));
  return graph("me/messages", token, {
    method: "POST",
    body: {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { attachment: { type: "template", payload: { template_type: "generic", elements } } },
    },
  });
}

async function patchDecision(decision, status, details = {}) {
  await core(`v9_decisions?id=eq.${decision.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { status, output: { ...(decision.output || {}), ...details }, updated_at: new Date().toISOString() },
  });
}

async function processDecision(decision, config) {
  const gate = await finalGate(decision, config);
  if (!gate.allowed) {
    const claimed = await claim(decision);
    if (claimed) await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason });
    return { sent: 0, suppressed: 1, failed: 0 };
  }

  const claimed = await claim(decision);
  if (!claimed) return { sent: 0, suppressed: 0, failed: 0 };

  let media = { assets: [], catalog_keys: [] };
  let mediaWarning = null;
  try {
    media = await resolveAssets(claimed);
    if ((claimed.output?.needs_slides || claimed.action === "reply_with_slides") && !media.assets.length) mediaWarning = "NO_PUBLISHED_ASSET_MATCH";
  } catch (error) {
    mediaWarning = String(error?.message || error).slice(0, 500);
  }

  const bundle = await bundleFor(claimed, gate.text, media.assets);
  const existing = await attempts(bundle.id);
  let nextAttempt = Math.max(0, ...(existing || []).map((item) => Number(item.attempt_no || 0))) + 1;
  const textAlreadySent = (existing || []).some((item) => item.transport === "meta_messenger_text" && item.status === "sent");

  try {
    let textResult = null;
    if (!textAlreadySent) {
      textResult = await sendText(claimed.page_id, claimed.sender_id, gate.text);
      await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_text", "sent", textResult);
    }

    const batches = [];
    for (let index = 0; index < media.assets.length; index += 10) batches.push(media.assets.slice(index, index + 10));
    for (let index = 0; index < batches.length; index += 1) {
      const transport = `meta_messenger_carousel_${index + 1}`;
      const alreadySent = (existing || []).some((item) => item.transport === transport && item.status === "sent");
      if (alreadySent) continue;
      try {
        const result = await sendCarousel(claimed.page_id, claimed.sender_id, batches[index]);
        if (result) await recordAttempt(bundle.id, nextAttempt++, transport, "sent", result);
      } catch (error) {
        mediaWarning = String(error?.message || error).slice(0, 500);
        await recordAttempt(bundle.id, nextAttempt++, transport, "failed", {}, error);
      }
    }

    const partial = Boolean(mediaWarning);
    await core(`v9_delivery_bundles?id=eq.${bundle.id}`, { method: "PATCH", prefer: "return=minimal", body: { status: partial ? "partial" : "sent", updated_at: new Date().toISOString() } });
    await patchDecision(claimed, partial ? "live_delivered_partial" : "live_delivered", {
      should_send: true,
      transport_locked: false,
      delivery_bundle_id: bundle.id,
      provider_message_id: textResult?.message_id || null,
      delivered_at: new Date().toISOString(),
      media_warning: mediaWarning,
      media_catalog_keys_resolved: media.catalog_keys,
      media_asset_count: media.assets.length,
      contact_request_sanitized: Boolean(gate.contactKnown && claimed.output?.should_request_contact),
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
      live_delivery_error: String(error?.message || error).slice(0, 800),
    }).catch(() => {});
    return { sent: 0, suppressed: 0, failed: 1 };
  }
}

async function heartbeat(status, mode, details = {}, error = null) {
  if (status === "healthy" && Date.now() - lastHeartbeat < 20000) return;
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode,
      details: { ...details, hard_gates: ["opt_out", "human_takeover", "verified_page_reply", "dedupe", "meta_transport"], business_rules_authority: "none" },
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
      await heartbeat("idle", mode, { outbound_enabled: false });
      return;
    }
    await pageTokens();
    const candidates = await core(`v9_decisions?select=id,page_id,sender_id,source_event_id,status,action,confidence,output,input_snapshot,created_at,updated_at&status=in.(shadow_ai_completed,live_delivery_failed)&order=created_at.desc&limit=${CANDIDATE_SCAN_LIMIT}`);
    const priority = prioritizeOutboundDecisions(candidates, {
      nowMs: Date.now(),
      responseSlaSeconds: Number(config.response_sla_seconds || 45),
    });
    const rows = priority.rows.slice(0, DELIVERY_BATCH_SIZE);
    for (const decision of rows || []) {
      const result = await processDecision(decision, config);
      sent += result.sent;
      suppressed += result.suppressed;
      failed += result.failed;
    }
    await heartbeat(failed ? "degraded" : "healthy", mode, {
      outbound_enabled: true,
      candidates: rows.length,
      candidates_scanned: candidates?.length || 0,
      fresh_sla_candidates: priority.fresh_count,
      recovery_backlog_candidates: priority.recovery_count,
      outbound_priority: "fresh_sla_first_then_recent_recovery",
      delivery_batch_size: DELIVERY_BATCH_SIZE,
      candidate_scan_limit: CANDIDATE_SCAN_LIMIT,
      sent,
      suppressed,
      failed,
      idempotent: true,
      balanced_media_max: MAX_MEDIA_ASSETS,
    }, failed ? `${failed} live delivery(s) failed` : null);
  } catch (error) {
    await heartbeat("degraded", mode, { outbound_enabled: mode === "ACTIVE", sent, suppressed, failed }, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), mode === "ACTIVE" ? POLL_MS : 15000);
    timer.unref?.();
  }
}

if (!configured()) {
  console.warn("[AIGUKA V10 outbound] Core/Knowledge credentials missing; disabled");
} else {
  console.log("[AIGUKA V10 outbound] safety-only final gate started; AI business decision is not rewritten");
  tick().catch(() => {});
}
