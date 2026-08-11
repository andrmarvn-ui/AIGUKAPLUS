import { normalizeVietnamese } from "./v10/core/advisory-engine.js";
import { MEDIA_DEDUPE_WINDOW_MS, mediaClaimDisposition, mediaRequestedAfterDelivery, mediaScopeIdempotencyKey, mediaScopeMatchesAssetRefs } from "./v10/core/media-dedupe.js";
import { createPancakeConversationSnapshotCache } from "./v10/core/pancake-conversation-snapshot.js";
import { buildObservedPageReplyEvent, customerSlaSourceIds, observedPageReplyDisposition, observedPageReplyStatePatch } from "./v10/core/page-reply-evidence.js";
import { prepareCarouselAssets } from "./v10/core/carousel-media.js";
import { prioritizeOutboundDecisions } from "./v10/core/outbound-priority.js";
import { humanTakeoverActive, resolveChannelAuthority } from "./v10/core/constitution.js";
import { createMessageGateway, DISPATCH_OWNERS } from "./v10/core/message-gateway.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-outbound";
const VERSION = "v10_outbound_single_gateway_v16_page_reply_evidence";
const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_V10_OUTBOUND_POLL_MS || 3000));
const MAX_DECISION_AGE_MS = Math.max(15 * 60_000, Number(process.env.AIGUKA_V10_LIVE_MAX_AGE_MS || 2 * 60 * 60_000));
const MAX_MEDIA_ASSETS = Math.max(10, Math.min(20, Number(process.env.AIGUKA_V10_MAX_MEDIA_ASSETS || 20)));
const CANDIDATE_SCAN_LIMIT = Math.max(20, Math.min(200, Number(process.env.AIGUKA_V10_OUTBOUND_SCAN_LIMIT || 100)));
const DELIVERY_BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.AIGUKA_V10_OUTBOUND_BATCH || 10)));
let running = false;
let timer;
let lastHeartbeat = 0;
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
const gateway = createMessageGateway({ coreRequest: core });

async function runtime() {
  const rows = await core("v9_runtime_config?select=mode,external_bot_mode,external_bot_policy,ingest_mode,response_sla_seconds,debounce_seconds&id=eq.1&limit=1", { timeout: 10000 });
  return rows?.[0] || { mode: "OFF", ingest_mode: "OFF" };
}

async function pageRow(pageId) {
  const rows = await core(`v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,is_active,settings&page_id=eq.${encodeURIComponent(pageId)}&limit=1`, { timeout: 10000 });
  return rows?.[0] || null;
}

async function stateRow(pageId, senderId) {
  const rows = await core(`v9_conversation_state?select=state,contact_status,phone,zalo,human_takeover,human_takeover_until,last_customer_event_at,last_page_event_at,response_deadline_at,last_source_event_id&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&limit=1`, { timeout: 10000 });
  return rows?.[0] || {};
}

async function resolveDecisionSla(decision, resolution, resolvedAt) {
  const now = new Date().toISOString();
  for (const sourceEventId of customerSlaSourceIds(decision)) {
    await core(
      `v9_sla_events?source_event_id=eq.${encodeURIComponent(sourceEventId)}&status=in.(open,breached)`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          status: "resolved",
          resolution,
          resolved_at: resolvedAt,
          updated_at: now,
        },
      },
    ).catch(() => {});
  }
}

async function persistObservedPageReply(decision, reply) {
  if (!reply?.sent_at) return;
  const nowMs = Date.now();
  const event = buildObservedPageReplyEvent(decision, reply, nowMs);
  await core("v9_events?on_conflict=source_system,source_event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: event,
  });
  const current = await stateRow(decision.page_id, decision.sender_id);
  await core(`v9_conversation_state?page_id=eq.${encodeURIComponent(decision.page_id)}&sender_id=eq.${encodeURIComponent(decision.sender_id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: observedPageReplyStatePatch(current, reply, nowMs),
  });
  const disposition = observedPageReplyDisposition(reply);
  await resolveDecisionSla(decision, disposition.resolution, event.occurred_at);
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
  if (!output.needs_slides && decision.action !== "reply_with_slides") {
    return { assets: [], catalog_keys: [], requested_catalog_keys: [], missing_catalog_keys: [], media_bundles: [] };
  }

  const content = await publishedKnowledge();
  const nodes = Array.isArray(content.catalog) ? content.catalog : [];
  const nodeByKey = new Map(nodes
    .map((node) => [String(node?.catalog_key || "").trim(), node])
    .filter(([key]) => Boolean(key)));
  const selectedProducts = (output.selected_products || []).map((value) => normalizeVietnamese(value));
  const requestedScopes = [];

  function addScope(key) {
    const clean = String(key || "").trim();
    if (clean && nodeByKey.has(clean) && !requestedScopes.includes(clean)) requestedScopes.push(clean);
  }

  for (const key of output.selected_catalog_keys || []) addScope(key);

  if (!requestedScopes.length && selectedProducts.length) {
    for (const node of nodes) {
      const text = nodeText(node);
      if (!selectedProducts.some((product) => product && (text.includes(product) || product.includes(normalizeVietnamese(node.catalog_key))))) continue;
      const root = String(node.root_key || "").trim();
      addScope(nodeByKey.has(root) ? root : node.catalog_key);
    }
  }

  function isWithinScope(node, scopeKey) {
    let currentKey = String(node?.catalog_key || "").trim();
    const visited = new Set();
    while (currentKey && !visited.has(currentKey)) {
      if (currentKey === scopeKey) return true;
      visited.add(currentKey);
      currentKey = String(nodeByKey.get(currentKey)?.parent_key || "").trim();
    }
    return false;
  }

  function ancestry(key) {
    const output = [];
    let cursor = String(key || "").trim();
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      output.push(cursor);
      visited.add(cursor);
      cursor = String(nodeByKey.get(cursor)?.parent_key || "").trim();
    }
    return output;
  }

  function productGroup(scopeKey) {
    const path = ancestry(scopeKey);
    if (path.includes("phong_tam")) return "phong_tam";
    if (path.includes("phong_bep")) return "phong_bep";
    if (path.includes("gach_ngoi") || path.includes("gach_da_op_lat")) return "gach_op_lat";
    if (path.includes("quat_tran") || path.some((key) => key.startsWith("quat_"))) return "quat_tran";
    return path.at(-1) || String(scopeKey || "other");
  }

  function productGroupLabel(groupKey) {
    if (groupKey === "phong_tam") return "Thiết bị phòng tắm";
    if (groupKey === "phong_bep") return "Thiết bị nhà bếp";
    if (groupKey === "gach_op_lat") return "Gạch ốp lát";
    if (groupKey === "quat_tran") return "Quạt trần";
    return String(nodeByKey.get(groupKey)?.display_name || groupKey || "Mẫu sản phẩm");
  }

  const scopes = requestedScopes.filter((scopeKey) => !requestedScopes.some((otherKey) => {
    if (otherKey === scopeKey) return false;
    return isWithinScope(nodeByKey.get(scopeKey), otherKey);
  }));

  const seen = new Set();
  const resolvedScopes = [];
  const bundleMap = new Map();

  for (const scopeKey of scopes) {
    const childGroups = [];
    for (const node of nodes.filter((candidate) => isWithinScope(candidate, scopeKey))) {
      const assets = [];
      for (const asset of Array.isArray(node.assets) ? node.assets : []) {
        const sourceUrl = validHttpUrl(asset.source_url);
        if (!sourceUrl || /drive\.google\.com\/drive\/folders\//i.test(sourceUrl) || seen.has(sourceUrl)) continue;
        seen.add(sourceUrl);
        assets.push({
          asset_id: asset.asset_id || null,
          catalog_key: scopeKey,
          source_catalog_key: node.catalog_key,
          title: asset.title || node.display_name || "Mẫu sản phẩm",
          source_url: sourceUrl,
          sort_order: Number(asset.sort_order || 0),
        });
      }
      assets.sort((a, b) => a.sort_order - b.sort_order);
      if (assets.length) childGroups.push({ catalog_key: node.catalog_key, assets });
    }

    const scopeAssets = roundRobinAssets(childGroups);
    if (!scopeAssets.length) continue;
    resolvedScopes.push(scopeKey);

    const groupKey = productGroup(scopeKey);
    if (!bundleMap.has(groupKey)) {
      bundleMap.set(groupKey, {
        bundle_key: "media:" + groupKey,
        group_key: groupKey,
        label: productGroupLabel(groupKey),
        catalog_keys: [],
        scope_groups: [],
      });
    }
    const bundle = bundleMap.get(groupKey);
    bundle.catalog_keys.push(scopeKey);
    bundle.scope_groups.push({ catalog_key: scopeKey, assets: scopeAssets });
  }

  const mediaBundles = [...bundleMap.values()].map((bundle) => {
    const assets = roundRobinAssets(bundle.scope_groups);
    return {
      bundle_key: bundle.bundle_key,
      group_key: bundle.group_key,
      label: bundle.label,
      catalog_keys: [...new Set(bundle.catalog_keys)],
      assets,
      asset_count: assets.length,
      max_assets: MAX_MEDIA_ASSETS,
    };
  }).filter((bundle) => bundle.assets.length);

  return {
    assets: mediaBundles.flatMap((bundle) => bundle.assets),
    catalog_keys: resolvedScopes,
    requested_catalog_keys: scopes,
    missing_catalog_keys: scopes.filter((scopeKey) => !resolvedScopes.includes(scopeKey)),
    media_bundles: mediaBundles,
  };
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


function mergeTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureLatestCustomerClusterJob(decision, state, config) {
  const sourceEventId = String(state?.last_source_event_id || "").trim();
  if (!sourceEventId) return { ensured: false, reason: "LATEST_SOURCE_EVENT_UNKNOWN" };

  const decisions = await core(
    "v9_decisions?select=id,status,source_event_id&source_event_id=eq." + encodeURIComponent(sourceEventId)
      + "&page_id=eq." + encodeURIComponent(decision.page_id)
      + "&sender_id=eq." + encodeURIComponent(decision.sender_id)
      + "&order=created_at.desc&limit=5"
  ).catch(() => []);
  const decisionExists = (decisions || []).some((row) => [
    "shadow_context_ready", "shadow_ai_processing", "shadow_ai_completed",
    "live_delivery_processing", "live_delivery_failed", "live_delivered", "live_delivered_partial",
  ].includes(String(row?.status || "")));
  if (decisionExists) return { ensured: true, source_event_id: sourceEventId, via: "decision" };

  const jobs = await core(
    "v9_jobs?select=id,status,source_event_id,run_after&source_event_id=eq." + encodeURIComponent(sourceEventId)
      + "&job_type=eq.decision_shadow&limit=1"
  ).catch(() => []);
  const activeJob = (jobs || []).find((row) => ["queued", "processing"].includes(String(row?.status || "")));
  if (activeJob) return { ensured: true, source_event_id: sourceEventId, via: "job", job_id: activeJob.id };

  const events = await core(
    "v9_events?select=id,source_event_id,received_at&page_id=eq." + encodeURIComponent(decision.page_id)
      + "&customer_id=eq." + encodeURIComponent(decision.sender_id)
      + "&source_event_id=eq." + encodeURIComponent(sourceEventId)
      + "&limit=1"
  ).catch(() => []);
  const event = events?.[0];
  if (!event?.id) return { ensured: false, source_event_id: sourceEventId, reason: "LATEST_EVENT_NOT_FOUND" };

  const debounceMs = Math.max(0, Number(config?.debounce_seconds || 20) * 1000);
  const dueAt = new Date(Math.max(Date.now(), mergeTime(event.received_at) + debounceMs)).toISOString();
  const rows = await core("v9_jobs?on_conflict=source_event_id,job_type", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      source_event_id: sourceEventId,
      event_id: event.id,
      job_type: "decision_shadow",
      dedupe_key: String(decision.page_id) + ":" + String(decision.sender_id) + ":" + sourceEventId,
      page_id: String(decision.page_id),
      sender_id: String(decision.sender_id),
      status: "queued",
      run_after: dueAt,
      payload: {
        source: "v10_outbound_merge_guarantee",
        merge_all_prior_unanswered_customer_messages: true,
        stale_decision_id: decision.id,
      },
      attempts: 0,
      locked_by: null,
      locked_at: null,
      completed_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    },
  }).catch(() => []);
  return {
    ensured: Boolean(rows?.[0]?.id),
    source_event_id: sourceEventId,
    via: "requeued",
    job_id: rows?.[0]?.id || null,
    run_after: dueAt,
  };
}

// AIGUKA_V10_CUSTOMER_CLUSTER_MERGE_AUTHORITY_V1


function sovereignOutboundCustomerCluster(decision) {
  const messages = decision?.input_snapshot?.conversation?.messages || [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  return normalizeVietnamese(messages.slice(boundary + 1)
    .filter((message) => message?.role === "customer")
    .map((message) => [message.text, message?.postback?.effective_payload, message?.postback?.payload].filter(Boolean).join(" "))
    .join(" "));
}

function sovereignOutboundRepeatRequested(decision) {
  return /\b(gui lai|nhac lai|noi lai|lap lai|gui them|gui tiep|gui nua|xem lai|xem them|xem tiep|xem nua|mau khac|anh khac|hinh khac|catalog khac|them mau|them anh|them hinh|can them mau|muon them mau|mau nua|anh nua|hinh nua|con mau|con anh|con hinh|con loai|con cai)\b/.test(sovereignOutboundCustomerCluster(decision));
}

async function sovereignRecentDuplicate(decision, text) {
  if (sovereignOutboundRepeatRequested(decision)) return null;
  const normalized = normalizeVietnamese(text || "");
  if (!normalized) return null;
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = await core(
    "v9_decisions?select=id,status,output,created_at&page_id=eq." + encodeURIComponent(decision.page_id)
      + "&sender_id=eq." + encodeURIComponent(decision.sender_id)
      + "&id=neq." + encodeURIComponent(decision.id)
      + "&status=in.(live_delivered,live_delivered_partial)"
      + "&created_at=gte." + encodeURIComponent(since)
      + "&order=created_at.desc&limit=20"
  ).catch(() => []);
  return (rows || []).find((row) => normalizeVietnamese(row?.output?.final_reply || "") === normalized) || null;
}

// AIGUKA_V10_OUTBOUND_SOVEREIGN_INTEGRITY_V1


const livePageReplySnapshotCache = createPancakeConversationSnapshotCache({
  timeoutMs: 3500,
  ttlMs: Math.max(1000, Number(process.env.AIGUKA_PANCAKE_PAGE_SNAPSHOT_TTL_MS || 5000)),
  maxPages: 4,
});

function livePageReplyTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function livePageReplyText(value) {
  return normalizeVietnamese(String(value || "")).replace(/\s+/g, " ").trim();
}

function livePageReplyConversationMatches(row, senderId) {
  const target = String(senderId || "").trim();
  if (!target || !row || typeof row !== "object") return false;
  const values = [
    row.sender_id,
    row.customer_id,
    row.psid,
    row.from_id,
    row.from?.id,
    row.user?.id,
    row.customer?.id,
    row.page_customer?.psid,
    row.customers?.[0]?.fb_id,
  ].map((value) => String(value || "").trim());
  const id = String(row.id || row.conversation_id || row.thread_id || "").trim();
  return values.includes(target) || id === target || id.endsWith("_" + target);
}

function livePageReplySender(row) {
  return row?.last_sent_by || row?.last_message?.from || row?.last_message?.sender || null;
}

function livePageReplySource(row) {
  const sender = livePageReplySender(row) || {};
  const appId = String(sender.app_id || sender.application_id || sender.bot_id || "").trim();
  const configuredAicake = new Set(
    String(process.env.PANCAKE_AICAKE_APP_IDS || "556376998159104")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const raw = livePageReplyText(JSON.stringify(sender));
  if ((appId && configuredAicake.has(appId)) || /\b(aicake|ai cake|botcake|bot cake)\b/.test(raw)) return "aicake";
  if (/\b(automation|automated|auto reply|auto_reply|flow)\b/.test(raw)) return "page_automation";
  if (sender.admin_name || sender.uid || sender.admin_id) return "human_admin";
  return "page";
}

function livePageReplyLatestCustomerText(decision) {
  const messages = decision?.input_snapshot?.conversation?.messages || [];
  const latest = [...messages].reverse().find((message) => message?.role === "customer");
  return livePageReplyText(latest?.text || "");
}

function supportLatestCustomerHasAttachment(decision) {
  const messages = decision?.input_snapshot?.conversation?.messages || [];
  const latest = [...messages].reverse().find((message) => message?.role === "customer");
  return Array.isArray(latest?.attachments) && latest.attachments.length > 0;
}

function supportReplyRequestsContact(reply) {
  const text = livePageReplyText(reply?.message_text || "");
  return /\b(sdt|so dien thoai|dien thoai|zalo|de lai so|xin so|lien he)\b/.test(text);
}


function supportSalutationFromAI(decision) {
  let text = normalizeVietnamese(String(decision?.output?.final_reply || ""));
  text = text.replace(/\banh\s*\/\s*chi\b/g, " ").replace(/\banh\s+chi\b/g, " ");
  const hasAnh = /(^|\s|[,.!?;:])anh(?=\s|[,.!?;:]|$)/.test(text);
  const hasChi = /(^|\s|[,.!?;:])chi(?=\s|[,.!?;:]|$)/.test(text);
  if (hasAnh === hasChi) return null;
  return { value: hasAnh ? "anh" : "chị", source: "ai_reply" };
}

function supportSalutationFromCustomer(customer) {
  const preferred = normalizeVietnamese(String(customer?.preferred_salutation || "")).trim();
  if (preferred === "anh") return { value: "anh", source: "preferred_salutation" };
  if (preferred === "chi") return { value: "chị", source: "preferred_salutation" };
  const gender = normalizeVietnamese(String(customer?.gender || "")).trim();
  if (["male", "nam", "man"].includes(gender)) return { value: "anh", source: "meta_gender" };
  if (["female", "nu", "woman"].includes(gender)) return { value: "chị", source: "meta_gender" };
  return null;
}

async function supportCustomerIdentity(pageId, senderId) {
  const rows = await core(
    "v9_customers?select=display_name,gender,preferred_salutation&page_id=eq." + encodeURIComponent(pageId)
      + "&customer_id=eq." + encodeURIComponent(senderId)
      + "&limit=1",
    { timeout: 8000 },
  ).catch(() => []);
  return rows?.[0] || {};
}

function supportResolveSalutation(customer, decision) {
  return supportSalutationFromCustomer(customer)
    || supportSalutationFromAI(decision)
    || { value: null, source: "neutral_omission" };
}

// Keep carousel copy intentionally neutral. This is safer than guessing gender and
// works across every product group without making the support message feel templated.
function supportCarouselSubtitle() {
  return "Một vài mẫu bán chạy để tham khảo trước";
}

function supportSlideCaption(gate, decision) {
  const recentContactRequest = supportReplyRequestsContact(gate?.livePageReply)
    || String(decision?.output?.contact_state || "").toLowerCase() === "missing_recently_requested";

  // Universal support CTA: useful for every catalog/product and avoids gender mistakes.
  // Do not repeat the contact request when the customer already has contact info or
  // AICAKE/page has just asked for it.
  if (gate?.contactKnown || recentContactRequest) {
    return "Em gửi một số mẫu bán chạy để tham khảo trước ạ.";
  }
  return "Em gửi một số mẫu bán chạy để tham khảo trước; nếu cần đúng mẫu và báo giá chính xác, cho em xin SĐT/Zalo nhé.";
}

// AIGUKA_V10_SUPPORT_SALUTATION_V2_NEUTRAL_CTA
function supportCompactImageReply(gate) {
  let text = String(gate?.text || "").replace(/\s+/g, " ").trim();
  if (gate?.contactKnown || supportReplyRequestsContact(gate?.livePageReply)) {
    text = stripRepeatedContactRequest(text);
  }
  if (!text) return "";
  const sentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || text;
  return sentence.slice(0, 260).trim();
}

async function livePageReplyEvidence(decision, customerAt) {
  const pageId = String(decision?.page_id || "").trim();
  const senderId = String(decision?.sender_id || "").trim();
  const token = String(process.env.PANCAKE_PAGE_ACCESS_TOKEN || "").trim();
  if (!pageId || !senderId || !token || !customerAt) {
    return { check_unavailable: true, evidence: "pancake_live_snapshot_not_configured" };
  }

  const latestCustomerText = livePageReplyLatestCustomerText(decision);
  const snapshot = await livePageReplySnapshotCache.load(pageId, token);
  const snapshotHealthy = (snapshot?.attempts || []).some((attempt) => Number(attempt?.status || 0) >= 200 && Number(attempt?.status || 0) < 300);
  if (!snapshotHealthy) {
    return {
      check_unavailable: true,
      evidence: "pancake_live_snapshot_unavailable",
      snapshot_loaded_at: snapshot?.loaded_at || null,
      snapshot_attempts: snapshot?.attempts || [],
    };
  }
  const row = (snapshot?.rows || []).find((item) => livePageReplyConversationMatches(item, senderId));
  if (!row) {
    return {
      no_reply_observed: true,
      evidence: "pancake_live_snapshot_checked_no_conversation_reply",
      snapshot_loaded_at: snapshot?.loaded_at || null,
      snapshot_attempts: snapshot?.attempts || [],
    };
  }

  const updatedAtValue = row.updated_at || row.last_message?.created_at || row.last_message_at || null;
  const updatedAt = livePageReplyTime(updatedAtValue);
  const pancakeCustomerAt = livePageReplyTime(row.last_customer_message_at || row.last_customer_at || "");
  const effectiveCustomerAt = Math.max(customerAt, pancakeCustomerAt || 0);
  const snippet = String(row.snippet || row.last_message?.message || row.last_message?.text || "").trim();
  const normalizedSnippet = livePageReplyText(snippet);
  const sender = livePageReplySender(row);

  if (!sender || !updatedAt || updatedAt <= effectiveCustomerAt + 500) {
    return {
      no_reply_observed: true,
      evidence: "pancake_live_snapshot_checked_customer_still_latest",
      snapshot_loaded_at: snapshot?.loaded_at || null,
      snapshot_attempts: snapshot?.attempts || [],
    };
  }
  if (latestCustomerText && normalizedSnippet && normalizedSnippet === latestCustomerText) {
    return {
      no_reply_observed: true,
      evidence: "pancake_live_snapshot_checked_customer_text_latest",
      snapshot_loaded_at: snapshot?.loaded_at || null,
      snapshot_attempts: snapshot?.attempts || [],
    };
  }

  const actorName = String(sender.admin_name || sender.name || sender.actor_name || "").trim();
  const actorAppId = String(sender.app_id || sender.application_id || sender.bot_id || "").trim();
  return {
    source_system: livePageReplySource(row),
    sent_at: new Date(updatedAt).toISOString(),
    actor_name: actorName || null,
    actor_app_id: actorAppId || null,
    message_text: snippet.slice(0, 600) || null,
    conversation_id: String(row.id || row.conversation_id || "").trim() || null,
    evidence: "pancake_live_shared_page_snapshot",
    no_reply_observed: false,
    check_unavailable: false,
    snapshot_loaded_at: snapshot?.loaded_at || null,
    snapshot_attempts: snapshot?.attempts || [],
  };
}

// AIGUKA_V10_LIVE_PAGE_REPLY_GUARD_V2_SUPPORT

async function finalGate(decision, config) {
  const page = await pageRow(decision.page_id);
  const authority = resolveChannelAuthority({ runtime: config, page, channel: "live" });
  if (!authority.allowed) return authority;
  const supportMode = authority.mode === "SUPPORT";

  const cutover = supportMode
    ? (page?.settings?.support_cutover_at || page?.settings?.active_cutover_at)
    : page?.settings?.active_cutover_at;
  if (!cutover || !isAfterOrEqual(decision.created_at, cutover)) return { allowed: false, reason: "PRE_CUTOVER_DECISION" };
  if (Date.now() - Date.parse(decision.created_at) > MAX_DECISION_AGE_MS) return { allowed: false, reason: "DECISION_TOO_OLD" };

  const conversation = decision?.input_snapshot?.conversation || {};
  if (conversation?.safety?.opt_out) return { allowed: false, reason: "OPT_OUT" };
  const snapshotPageReplyAfterLatestCustomer = pageReplyAfterLatestCustomerInOrder(conversation?.messages || []);
  const output = decision.output || {};
  const supportSlideEligible = supportMode && (output.needs_slides === true || decision.action === "reply_with_slides");
  const supportImageEligible = supportMode
    && !supportSlideEligible
    && page?.settings?.support_image_reply_enabled === true
    && supportLatestCustomerHasAttachment(decision);
  const supportFallbackRequested = supportMode && output.operational_support_fallback === true;
  const supportFallbackWaitMs = Math.max(
    60000,
    Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_SECONDS || 90) * 1000,
    (Number(config.response_sla_seconds || 45) + 30) * 1000,
  );
  // AICake text can satisfy a text fallback, but never a pending media duty.
  const supportTextFallbackEligible = !supportSlideEligible
    && !supportImageEligible
    && supportFallbackRequested
    && page?.settings?.support_operational_fallback_enabled === true
    && Date.now() - latestCustomerAt(decision) >= supportFallbackWaitMs;
  if (supportMode && !supportSlideEligible && !supportImageEligible && !supportTextFallbackEligible) {
    return { allowed: false, reason: "SUPPORT_MEDIA_ONLY" };
  }

  let text = String(output.final_reply || "").trim();
  if ((!text && !supportSlideEligible) || decision.action === "suppress") return { allowed: false, reason: "NO_SEND_ACTION" };
  if (Number(decision.confidence || output.confidence || 0) < 0.45) return { allowed: false, reason: "CONFIDENCE_TOO_LOW" };

  const state = await stateRow(decision.page_id, decision.sender_id);
  const supportCustomer = supportMode ? await supportCustomerIdentity(decision.page_id, decision.sender_id) : {};
  const supportSalutationInfo = supportMode ? supportResolveSalutation(supportCustomer, decision) : { value: null, source: null };
  if (humanTakeoverActive(state)) return { allowed: false, reason: "HUMAN_TAKEOVER" };

  const customerAt = latestCustomerAt(decision);
  const liveCustomerAt = Date.parse(state.last_customer_event_at || "");
  if (customerAt > 0 && Number.isFinite(liveCustomerAt) && liveCustomerAt > customerAt + 250) {
    const merge = await ensureLatestCustomerClusterJob(decision, state, config);
    return { allowed: false, reason: "CUSTOMER_CLUSTER_ADVANCED_WAIT_MERGE", merge };
  }

  const pageAt = Date.parse(state.last_page_event_at || "");
  const pageClearlyAfterCustomer = customerAt > 0 && Number.isFinite(pageAt) && pageAt > customerAt + 1000;
  const pageOrderedAfterCustomer = customerAt > 0 && Number.isFinite(pageAt) && pageAt >= customerAt && snapshotPageReplyAfterLatestCustomer;
  const pageAlreadyReplied = pageClearlyAfterCustomer || pageOrderedAfterCustomer;
  const livePageReplyProbe = await livePageReplyEvidence(decision, customerAt).catch((error) => ({
    check_unavailable: true,
    evidence: "pancake_live_snapshot_error",
    error: String(error?.message || error).slice(0, 300),
  }));
  const livePageReply = livePageReplyProbe?.no_reply_observed || livePageReplyProbe?.check_unavailable
    ? null
    : livePageReplyProbe;

  if (supportTextFallbackEligible) {
    if (livePageReply) {
      return { allowed: false, reason: "SUPPORT_PRIMARY_REPLIED_BEFORE_FALLBACK", live_page_reply: livePageReply };
    }
    if (pageAlreadyReplied) {
      return { allowed: false, reason: "SUPPORT_PAGE_REPLIED_BEFORE_FALLBACK", live_page_reply: livePageReply };
    }
    if (livePageReplyProbe?.check_unavailable) {
      const forceAfterMs = Math.max(
        supportFallbackWaitMs + 60000,
        Number(process.env.AIGUKA_V10_SUPPORT_FALLBACK_FORCE_SECONDS || 300) * 1000,
      );
      if (Date.now() - customerAt < forceAfterMs) {
        return { allowed: false, retryable: true, reason: "SUPPORT_FALLBACK_PANCAKE_CHECK_RETRY" };
      }
    }
  }

  if (livePageReply) {
    if (!supportMode || livePageReply.source_system === "human_admin") {
      return { allowed: false, reason: "LIVE_PAGE_ALREADY_REPLIED", live_page_reply: livePageReply };
    }
  }
  if (pageAlreadyReplied) {
    if (!supportMode) return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };
    if (!livePageReply) return { allowed: false, reason: "SUPPORT_PAGE_REPLY_UNCLASSIFIED" };
  }

  const contactKnown = Boolean(state.phone || state.zalo || ["captured", "verified"].includes(String(state.contact_status || "").toLowerCase()));
  if (contactKnown && output.should_request_contact) {
    text = stripRepeatedContactRequest(text) || "Dạ em đã nhận nội dung và tiếp tục hỗ trợ tại Messenger ạ.";
  }

  if (!supportMode) {
    const duplicate = await sovereignRecentDuplicate(decision, text);
    if (duplicate) return { allowed: false, reason: "EXACT_DUPLICATE_RECENT_REPLY", duplicate_decision_id: duplicate.id };
  }
  return {
    allowed: true,
    page,
    state,
    text,
    contactKnown,
    supportMode,
    supportSlideEligible,
    supportImageEligible,
    supportTextFallbackEligible,
    supportFallbackGuardDegraded: Boolean(supportTextFallbackEligible && livePageReplyProbe?.check_unavailable),
    livePageReply,
    supportSalutation: supportSalutationInfo.value,
    supportSalutationSource: supportSalutationInfo.source,
    supportCustomerName: supportCustomer?.display_name || null,
  };
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


function v10DriveFileId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const queryId = String(url.searchParams.get("id") || "").trim();
    if (queryId) return queryId;
    const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})/);
    return match?.[1] || "";
  } catch {
    const match = text.match(/(?:[?&]id=|\/file\/d\/)([A-Za-z0-9_-]{10,200})/);
    return match?.[1] || "";
  }
}

function v10MessengerImageUrl(value) {
  const sourceUrl = String(value || "").trim();
  const fileId = v10DriveFileId(sourceUrl);
  if (!fileId) return sourceUrl;
  const configured = String(process.env.AIGUKA_DRIVE_IMAGE_PROXY_BASE || "").trim().replace(/\/$/, "");
  const supabase = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const endpoint = configured || (supabase ? supabase + "/functions/v1/aiguka-drive-image-proxy" : "");
  return endpoint ? endpoint + "?file_id=" + encodeURIComponent(fileId) : sourceUrl;
}

async function sendCarousel(pageId, recipientId, assets, salutation = null, groupLabel = null) {
  if (!assets.length) return null;
  const storageAssets = await prepareCarouselAssets(assets.slice(0, 10), {
    fetchImpl: fetch,
    timeoutMs: 15000,
    lookupStorageAssets: async (fileIds) => knowledge(
      "v8_drive_assets?drive_file_id=in.(" + fileIds.join(",") + ")&is_active=eq.true&is_image=eq.true&select=drive_file_id,storage_url,storage_status,delivery_url,delivery_status"
    ),
  });
  const elements = storageAssets.map((asset, index) => ({
    title: String(asset.title || `Mẫu ${index + 1}`).slice(0, 80),
    image_url: v10MessengerImageUrl(asset.source_url),
    default_action: {
      type: "web_url",
      url: asset.source_url,
      webview_height_ratio: "full",
    },
    subtitle: groupLabel ? String(groupLabel + " · " + supportCarouselSubtitle()).slice(0, 80) : supportCarouselSubtitle(),
  }));
  return gateway.sendCarousel(pageId, recipientId, elements);
}

async function patchDecision(decision, status, details = {}) {
  await core(`v9_decisions?id=eq.${decision.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { status, output: { ...(decision.output || {}), ...details }, updated_at: new Date().toISOString() },
  });
}


function mediaDedupeBundles(media = {}) {
  if (Array.isArray(media.media_bundles) && media.media_bundles.length) return media.media_bundles;
  if (!Array.isArray(media.assets) || !media.assets.length) return [];
  return [{
    bundle_key: "media:mixed_compat",
    group_key: "mixed_compat",
    label: "Mẫu sản phẩm",
    catalog_keys: media.catalog_keys || [],
    assets: media.assets,
    asset_count: media.assets.length,
  }];
}

async function recentDeliveredMediaScope(decision, group, nowMs = Date.now()) {
  const since = new Date(nowMs - MEDIA_DEDUPE_WINDOW_MS).toISOString();
  const rows = await core(
    "v9_delivery_bundles?select=id,decision_id,idempotency_key,asset_refs,status,created_at,updated_at"
      + "&page_id=eq." + encodeURIComponent(decision.page_id)
      + "&sender_id=eq." + encodeURIComponent(decision.sender_id)
      + "&status=eq.sent"
      + "&updated_at=gte." + encodeURIComponent(since)
      + "&order=updated_at.desc&limit=40"
  );
  for (const row of rows || []) {
    if (!mediaScopeMatchesAssetRefs(group, row.asset_refs || [])) continue;
    const deliveredAttempts = await attempts(row.id);
    const carouselSent = (deliveredAttempts || []).some((attempt) =>
      attempt.status === "sent" && String(attempt.transport || "").includes("meta_messenger_carousel")
    );
    if (carouselSent) return row;
  }
  return null;
}

async function claimMediaScope(decision, group, nowMs = Date.now()) {
  const phraseRepeatRequested = sovereignOutboundRepeatRequested(decision);
  const delivered = phraseRepeatRequested ? null : await recentDeliveredMediaScope(decision, group, nowMs);
  const customerReaskedAfterDelivery = Boolean(delivered) && mediaRequestedAfterDelivery(
    decision?.input_snapshot?.conversation?.messages || [],
    delivered.updated_at || delivered.created_at,
    { decisionAction: decision.action },
  );
  const repeatRequested = phraseRepeatRequested || customerReaskedAfterDelivery;
  const idempotencyKey = mediaScopeIdempotencyKey({
    pageId: decision.page_id,
    senderId: decision.sender_id,
    group,
    decisionId: decision.id,
    repeatRequested,
  });
  const now = new Date(nowMs).toISOString();

  if (!repeatRequested && delivered) {
      const memorial = await core("v9_delivery_bundles?on_conflict=idempotency_key", {
        method: "POST",
        prefer: "resolution=ignore-duplicates,return=representation",
        body: {
          decision_id: delivered.decision_id || decision.id,
          page_id: decision.page_id,
          sender_id: decision.sender_id,
          text_body: null,
          asset_refs: group.assets || [],
          status: "sent",
          idempotency_key: idempotencyKey,
          updated_at: delivered.updated_at || delivered.created_at || now,
        },
      });
      return {
        allowed: false,
        reason: "DUPLICATE_MEDIA_SCOPE_24H",
        bundle: memorial?.[0] || delivered,
        duplicate_bundle_id: delivered.id,
        idempotency_key: idempotencyKey,
      };
  }

  const inserted = await core("v9_delivery_bundles?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: {
      decision_id: decision.id,
      page_id: decision.page_id,
      sender_id: decision.sender_id,
      text_body: null,
      asset_refs: group.assets || [],
      status: "staged",
      idempotency_key: idempotencyKey,
      updated_at: now,
    },
  });
  if (inserted?.[0]) {
    return {
      allowed: true,
      reason: customerReaskedAfterDelivery
        ? "CUSTOMER_MEDIA_REASK_AFTER_DELIVERY"
        : (repeatRequested ? "EXPLICIT_REPEAT_REQUEST" : "NEW_MEDIA_SCOPE"),
      bundle: inserted[0],
      idempotency_key: idempotencyKey,
    };
  }

  const rows = await core(
    "v9_delivery_bundles?select=id,decision_id,status,idempotency_key,asset_refs,created_at,updated_at"
      + "&idempotency_key=eq." + encodeURIComponent(idempotencyKey)
      + "&limit=1"
  );
  const existing = rows?.[0] || null;
  const disposition = mediaClaimDisposition(existing, { decisionId: decision.id, nowMs });
  if (!disposition.allowed) {
    return { ...disposition, bundle: existing, idempotency_key: idempotencyKey, duplicate_bundle_id: existing?.id || null };
  }
  if (!disposition.takeover) {
    return { ...disposition, bundle: existing, idempotency_key: idempotencyKey };
  }

  const recovered = await core(
    "v9_delivery_bundles?id=eq." + encodeURIComponent(existing.id)
      + "&status=eq." + encodeURIComponent(existing.status)
      + "&updated_at=eq." + encodeURIComponent(existing.updated_at),
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        decision_id: decision.id,
        asset_refs: group.assets || [],
        status: "staged",
        updated_at: now,
      },
    },
  );
  if (recovered?.[0]) {
    return { allowed: true, reason: disposition.reason, bundle: recovered[0], idempotency_key: idempotencyKey };
  }
  return { allowed: false, reason: "MEDIA_SCOPE_CLAIM_RACE_LOST", bundle: existing, idempotency_key: idempotencyKey };
}

async function prepareMediaDedupe(decision, media) {
  const groups = mediaDedupeBundles(media);
  const claims = [];
  for (const group of groups) claims.push({ group, ...(await claimMediaScope(decision, group)) });
  return {
    groups,
    claims,
    by_bundle_key: new Map(claims.map((claim) => [String(claim.group.bundle_key || claim.group.group_key || ""), claim])),
    allowed_count: claims.filter((claim) => claim.allowed).length,
    suppressed_count: claims.filter((claim) => !claim.allowed).length,
  };
}

// AIGUKA_V10_MEDIA_SCOPE_DEDUPE_V1

async function processDecision(decision, config) {
  const gate = await finalGate(decision, config);
  if (!gate.allowed && gate.retryable) {
    return { sent: 0, suppressed: 0, failed: 0, retryable: 1 };
  }
  if (!gate.allowed) {
    if (gate.live_page_reply) await persistObservedPageReply(decision, gate.live_page_reply).catch(() => {});
    const claimed = await claim(decision);
    if (claimed) await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason, merge_job_ensured: Boolean(gate.merge?.ensured), merge_source_event_id: gate.merge?.source_event_id || null, merge_job_id: gate.merge?.job_id || null, live_page_reply_source: gate.live_page_reply?.source_system || null, live_page_reply_at: gate.live_page_reply?.sent_at || null, live_page_reply_actor_name: gate.live_page_reply?.actor_name || null, live_page_reply_actor_app_id: gate.live_page_reply?.actor_app_id || null, live_page_reply_text: gate.live_page_reply?.message_text || null, live_page_reply_evidence: gate.live_page_reply?.evidence || null });
    return { sent: 0, suppressed: 1, failed: 0 };
  }

  const claimed = await claim(decision);
  if (!claimed) return { sent: 0, suppressed: 0, failed: 0 };

  let media = { assets: [], catalog_keys: [] };
  let mediaWarning = null;
  try {
    media = await resolveAssets(claimed);
    if ((claimed.output?.needs_slides || claimed.action === "reply_with_slides") && !media.assets.length) mediaWarning = "NO_PUBLISHED_ASSET_MATCH";
    if (Array.isArray(media.missing_catalog_keys) && media.missing_catalog_keys.length) {
      mediaWarning = "MEDIA_SCOPE_INCOMPLETE:" + media.missing_catalog_keys.join(",");
    }
  } catch (error) {
    mediaWarning = String(error?.message || error).slice(0, 500);
  }

  if (gate.supportMode && gate.supportSlideEligible && !media.assets.length) {
    await patchDecision(claimed, "live_suppressed", {
      should_send: false,
      transport_locked: true,
      live_suppression_reason: "SUPPORT_NO_PUBLISHED_ASSET",
      support_mode: true,
      support_primary_bot: "AICAKE",
    });
    return { sent: 0, suppressed: 1, failed: 0 };
  }

  const deliveryText = gate.supportMode
    ? (gate.supportSlideEligible ? supportSlideCaption(gate, claimed) : (gate.supportTextFallbackEligible ? gate.text : supportCompactImageReply(gate)))
    : gate.text;
  if (!deliveryText) {
    await patchDecision(claimed, "live_suppressed", {
      should_send: false,
      transport_locked: true,
      live_suppression_reason: "SUPPORT_NO_USEFUL_TEXT",
      support_mode: Boolean(gate.supportMode),
    });
    return { sent: 0, suppressed: 1, failed: 0 };
  }

  let mediaDedupe;
  try {
    mediaDedupe = await prepareMediaDedupe(claimed, media);
  } catch (error) {
    await patchDecision(claimed, "live_delivery_failed", {
      should_send: true,
      transport_locked: false,
      live_delivery_error: "MEDIA_DEDUPE_CLAIM_FAILED:" + String(error?.message || error).slice(0, 700),
      media_dedupe_fail_closed: true,
    }).catch(() => {});
    return { sent: 0, suppressed: 0, failed: 1 };
  }

  if (gate.supportMode && gate.supportSlideEligible && mediaDedupe.groups.length && mediaDedupe.allowed_count === 0) {
    await patchDecision(claimed, "live_suppressed", {
      should_send: false,
      transport_locked: true,
      live_suppression_reason: "DUPLICATE_MEDIA_SCOPE_24H",
      media_dedupe_window_hours: 24,
      media_dedupe_claims: mediaDedupe.claims.map((item) => ({
        bundle_key: item.group.bundle_key,
        catalog_keys: item.group.catalog_keys || [],
        reason: item.reason,
        duplicate_bundle_id: item.duplicate_bundle_id || item.bundle?.id || null,
      })),
      support_mode: true,
      support_primary_bot: "AICAKE",
    });
    return { sent: 0, suppressed: 1, failed: 0 };
  }

  const bundle = await bundleFor(claimed, deliveryText, media.assets);
  const existing = await attempts(bundle.id);
  let nextAttempt = Math.max(0, ...(existing || []).map((item) => Number(item.attempt_no || 0))) + 1;
  const textAlreadySent = (existing || []).some((item) => item.transport === "meta_messenger_text" && item.status === "sent");
  const dispatchKey = `live:${claimed.id}`;
  const dispatchLease = await gateway.claimDispatch({
    pageId: claimed.page_id,
    senderId: claimed.sender_id,
    owner: DISPATCH_OWNERS.LIVE,
    dedupeKey: dispatchKey,
    priority: 100,
    leaseSeconds: 120,
  });
  if (!dispatchLease?.granted) {
    await patchDecision(claimed, "live_delivery_failed", {
      should_send: true,
      transport_locked: false,
      live_delivery_error: `DISPATCH_LEASE_BUSY:${dispatchLease?.current_owner || "unknown"}`,
      dispatch_lease_owner: dispatchLease?.current_owner || null,
      dispatch_retryable: true,
    });
    return { sent: 0, suppressed: 0, failed: 0, retryable: 1 };
  }
  let dispatchResult = "failed";

  try {
    let textResult = null;
    if (!textAlreadySent) {
      textResult = await gateway.sendText(claimed.page_id, claimed.sender_id, deliveryText);
      await recordAttempt(bundle.id, nextAttempt++, "meta_messenger_text", "sent", textResult);
    }

    const mediaBundles = Array.isArray(media.media_bundles) && media.media_bundles.length
      ? media.media_bundles
      : (media.assets.length ? [{
          bundle_key: "media:mixed_compat",
          group_key: "mixed_compat",
          label: "Mẫu sản phẩm",
          catalog_keys: media.catalog_keys || [],
          assets: media.assets,
          asset_count: media.assets.length,
        }] : []);

    for (const group of mediaBundles) {
      const claimKey = String(group.bundle_key || group.group_key || "");
      const mediaClaim = mediaDedupe.by_bundle_key.get(claimKey);
      if (!mediaClaim?.allowed || !mediaClaim.bundle?.id) continue;

      const mediaExisting = await attempts(mediaClaim.bundle.id);
      let mediaAttemptNo = Math.max(0, ...(mediaExisting || []).map((item) => Number(item.attempt_no || 0))) + 1;
      let mediaGroupFailed = false;
      const batches = [];
      for (let index = 0; index < group.assets.length; index += 10) batches.push(group.assets.slice(index, index + 10));
      const safeGroup = String(group.group_key || "product").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "product";
      for (let index = 0; index < batches.length; index += 1) {
        const transport = "meta_messenger_carousel_" + safeGroup + "_" + String(index + 1);
        const alreadySent = (mediaExisting || []).some((item) => item.transport === transport && item.status === "sent");
        if (alreadySent) continue;
        try {
          const result = await sendCarousel(claimed.page_id, claimed.sender_id, batches[index], gate.supportSalutation, group.label);
          if (result) await recordAttempt(mediaClaim.bundle.id, mediaAttemptNo++, transport, "sent", result);
        } catch (error) {
          mediaGroupFailed = true;
          mediaWarning = String(error?.message || error).slice(0, 500);
          await recordAttempt(mediaClaim.bundle.id, mediaAttemptNo++, transport, "failed", {}, error);
        }
      }
      await core("v9_delivery_bundles?id=eq." + encodeURIComponent(mediaClaim.bundle.id), {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: mediaGroupFailed ? "failed" : "sent", updated_at: new Date().toISOString() },
      });
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
      media_catalog_keys_requested: media.requested_catalog_keys || claimed.output?.selected_catalog_keys || [],
      media_catalog_keys_missing: media.missing_catalog_keys || [],
      media_scope_complete: !(media.missing_catalog_keys || []).length,
      media_asset_count: media.assets.length,
      media_group_count: Array.isArray(media.media_bundles) ? media.media_bundles.length : 0,
      media_bundle_policy: "one_product_group_per_bundle",
      media_dedupe_window_hours: 24,
      media_dedupe_suppressed_count: mediaDedupe.suppressed_count,
      media_dedupe_claims: mediaDedupe.claims.map((item) => ({ bundle_key: item.group.bundle_key, catalog_keys: item.group.catalog_keys || [], allowed: item.allowed, reason: item.reason, claim_bundle_id: item.bundle?.id || null })),
      media_bundles_resolved: (media.media_bundles || []).map((item) => ({ bundle_key: item.bundle_key, group_key: item.group_key, label: item.label, catalog_keys: item.catalog_keys, asset_count: item.asset_count })),
      contact_request_sanitized: Boolean(gate.contactKnown && claimed.output?.should_request_contact),
      support_mode: Boolean(gate.supportMode),
      support_primary_bot: gate.supportMode ? "AICAKE" : null,
      support_operational_fallback_delivered: Boolean(gate.supportTextFallbackEligible),
      support_fallback_guard_degraded: Boolean(gate.supportFallbackGuardDegraded),
      support_live_reply_source: gate.livePageReply?.source_system || null,
      support_salutation: gate.supportSalutation || null,
      support_salutation_source: gate.supportSalutationSource || null,
      support_customer_name: gate.supportCustomerName || null,
      support_caption_policy: "universal_neutral_contact_cta_v2",
    });
    const deliveredAt = new Date().toISOString();
    await core(`v9_conversation_state?page_id=eq.${encodeURIComponent(claimed.page_id)}&sender_id=eq.${encodeURIComponent(claimed.sender_id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { state: "BOT_REPLIED", last_page_event_at: deliveredAt, response_deadline_at: null, updated_at: deliveredAt },
    }).catch(() => {});
    await resolveDecisionSla(claimed, "aiguka_replied", deliveredAt);
    dispatchResult = partial ? "live_delivered_partial" : "live_delivered";
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
    dispatchResult = "live_delivery_failed";
    return { sent: 0, suppressed: 0, failed: 1 };
  } finally {
    await gateway.releaseDispatch({
      pageId: claimed.page_id,
      senderId: claimed.sender_id,
      owner: DISPATCH_OWNERS.LIVE,
      dedupeKey: dispatchKey,
      result: dispatchResult,
    }).catch(() => {});
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
    await gateway.warmPageTokens();
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
      media_assets_max_per_group: MAX_MEDIA_ASSETS,
      media_bundle_policy: "one_product_group_per_bundle",
      observed_page_reply_persistence: true,
      sla_resolution_on_reply: true,
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

// AIGUKA_V10_BALANCED_PRODUCT_SCOPE_MEDIA_V1

// AIGUKA_V10_GROUPED_MEDIA_BUNDLES_V1

// AIGUKA_V10_MEDIA_DELIVERY_PROXY_V1
