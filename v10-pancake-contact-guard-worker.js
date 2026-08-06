const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const PANCAKE_TOKEN = String(process.env.PANCAKE_PAGE_ACCESS_TOKEN || "").trim();
const NAME = "aiguka-v10-pancake-contact-guard";
const VERSION = "v10_pancake_contact_guard_v1";
const INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.AIGUKA_V10_PANCAKE_TAG_SYNC_MS || 15 * 60_000));
const MAX_LOOKBACK_HOURS = Math.max(1, Math.min(23, Number(process.env.AIGUKA_V10_PANCAKE_TAG_LOOKBACK_HOURS || 20)));
const MAX_CONVERSATION_PAGES = Math.max(3, Math.min(30, Number(process.env.AIGUKA_V10_PANCAKE_CONVERSATION_PAGES || 15)));

let running = false;
let timer;

function configured() {
  return Boolean(CORE_BASE && CORE_KEY && KNOWLEDGE_BASE && KNOWLEDGE_KEY && PANCAKE_TOKEN);
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

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
}

function unique(values = []) {
  const map = new Map();
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : String(value?.text || value?.name || value?.label || value?.title || "").trim();
    if (!text) continue;
    const key = normalize(text);
    if (!map.has(key)) map.set(key, text);
  }
  return [...map.values()];
}

function hasContactTag(labels = []) {
  return labels.some((label) => /(^|\b)(sdt|so dien thoai|dien thoai|zalo)(\b|$)/i.test(normalize(label)));
}

function conversationId(row = {}) {
  return String(row.id || row.conversation_id || row.thread_id || "").trim();
}

function senderIds(row = {}) {
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
  ];
  const id = conversationId(row);
  const suffix = id.match(/_(\d{5,32})$/)?.[1];
  if (suffix) values.push(suffix);
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value) => /^\d{5,32}$/.test(value)))];
}

function collectTagLabels(node, out = [], depth = 0, underTagKey = false, seen = new WeakSet()) {
  if (node == null || depth > 10) return out;
  if (typeof node === "string" || typeof node === "number") {
    if (underTagKey) out.push(String(node));
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectTagLabels(item, out, depth + 1, underTagKey, seen);
    return out;
  }
  if (underTagKey) {
    for (const key of ["text", "name", "label", "title"]) {
      if (node[key] != null) out.push(String(node[key]));
    }
  }
  for (const [key, value] of Object.entries(node)) {
    const tagContext = underTagKey || /tag/i.test(key);
    collectTagLabels(value, out, depth + 1, tagContext, seen);
  }
  return out;
}

function tagsFor(row = {}) {
  const direct = [
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.staff_tags) ? row.staff_tags : []),
    ...(Array.isArray(row.conversation_tags) ? row.conversation_tags : []),
    ...(Array.isArray(row.customer_tags) ? row.customer_tags : []),
    ...(Array.isArray(row.tag_list) ? row.tag_list : []),
  ];
  return unique([...direct, ...collectTagLabels(row, [])]);
}

async function fetchPageConversations(pageId, targets) {
  const found = new Map();
  let last = "";
  const token = encodeURIComponent(PANCAKE_TOKEN);
  for (let pageNo = 0; pageNo < MAX_CONVERSATION_PAGES && found.size < targets.size; pageNo += 1) {
    let url = `https://pages.fm/api/public_api/v2/pages/${encodeURIComponent(pageId)}/conversations?page_access_token=${token}`;
    if (last) url += `&last_conversation_id=${encodeURIComponent(last)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || `PANCAKE_HTTP_${response.status}`);
    const rows = Array.isArray(data.conversations) ? data.conversations : Array.isArray(data.data) ? data.data : [];
    for (const row of rows) {
      for (const senderId of senderIds(row)) {
        if (targets.has(senderId) && !found.has(senderId)) found.set(senderId, row);
      }
    }
    const tail = rows[rows.length - 1];
    const next = conversationId(tail);
    if (!next || next === last || rows.length === 0) break;
    last = next;
  }
  return found;
}

async function upsertKnowledgeIdentity(pageId, senderId, row, labels) {
  const existing = await knowledge(`lt_conversation_identities?select=id,conversation_id&page_id=eq.${encodeURIComponent(pageId)}&or=(sender_id.eq.${encodeURIComponent(senderId)},customer_id.eq.${encodeURIComponent(senderId)})&order=updated_at.desc&limit=1`, { timeout: 12000 }).catch(() => []);
  const now = new Date().toISOString();
  const tags = labels.map((text) => ({ text, source: "pancake_live_followup" }));
  const raw = {
    source: "pancake_live_followup",
    conversation_id: conversationId(row),
    live_tag_sync_at: now,
    tag_labels: labels,
  };
  if (existing?.[0]?.id) {
    await knowledge(`lt_conversation_identities?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { pancake_tags: tags, identity_source: "pancake_live_followup", raw, updated_at: now },
    });
    return;
  }
  const convId = conversationId(row) || `${pageId}_${senderId}`;
  await knowledge("lt_conversation_identities?on_conflict=conversation_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      conversation_id: convId,
      page_id: String(pageId),
      sender_id: String(senderId),
      customer_id: String(senderId),
      source_channel: "pancake_live",
      pancake_tags: tags,
      identity_source: "pancake_live_followup",
      raw,
      updated_at: now,
    },
  });
}

async function upsertCoreGuard(pageId, senderId, labels, row) {
  const now = new Date().toISOString();
  await core("v10_followup_contact_guard?on_conflict=page_id,sender_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      page_id: String(pageId),
      sender_id: String(senderId),
      has_contact_tag: hasContactTag(labels),
      tag_labels: labels,
      source_updated_at: row?.updated_at || row?.last_customer_message_at || now,
      checked_at: now,
    },
  });
}

async function heartbeat(status, details = {}, error = null) {
  if (!CORE_BASE || !CORE_KEY) return;
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: configured() ? "ACTIVE" : "OFF",
      details: { ...details, source: "pages.fm live conversations", interval_minutes: Math.round(INTERVAL_MS / 60000), lookback_hours: MAX_LOOKBACK_HOURS },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

async function runSync() {
  if (!configured() || running) return;
  running = true;
  let candidates = 0;
  let matched = 0;
  let tagged = 0;
  let pages = 0;
  try {
    const since = new Date(Date.now() - MAX_LOOKBACK_HOURS * 60 * 60_000).toISOString();
    const states = await core(`v9_conversation_state?select=page_id,sender_id,last_customer_event_at&last_customer_event_at=gte.${encodeURIComponent(since)}&order=last_customer_event_at.desc&limit=200`, { timeout: 15000 });
    const byPage = new Map();
    for (const state of states || []) {
      if (!state.page_id || !state.sender_id) continue;
      if (!byPage.has(String(state.page_id))) byPage.set(String(state.page_id), new Set());
      byPage.get(String(state.page_id)).add(String(state.sender_id));
      candidates += 1;
    }
    for (const [pageId, targets] of byPage.entries()) {
      pages += 1;
      const found = await fetchPageConversations(pageId, targets);
      for (const [senderId, row] of found.entries()) {
        const labels = tagsFor(row);
        matched += 1;
        if (hasContactTag(labels)) tagged += 1;
        await Promise.all([
          upsertKnowledgeIdentity(pageId, senderId, row, labels),
          upsertCoreGuard(pageId, senderId, labels, row),
        ]);
      }
    }
    await heartbeat("healthy", { candidates, matched, tagged, pages });
  } catch (error) {
    await heartbeat("degraded", { candidates, matched, tagged, pages }, error?.message || error);
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => runSync().catch(() => {}), INTERVAL_MS);
    timer.unref?.();
  }
}

if (!configured()) {
  console.warn("[AIGUKA V10 Pancake guard] live Pancake/Core/Knowledge credentials missing; disabled");
  heartbeat("idle", { configured: false }, "PANCAKE_LIVE_TAG_GUARD_NOT_CONFIGURED").catch(() => {});
} else {
  console.log(`[AIGUKA V10 Pancake guard] ${VERSION} started`);
  runSync().catch(() => {});
}
