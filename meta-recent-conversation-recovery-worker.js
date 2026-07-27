import { loadActiveMetaConnection } from "./meta-token-store.js";

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
).replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const WORKER_NAME = "aiguka-meta-recent-conversation-recovery";
const WORKER_VERSION = "direct_meta_history_recovery_v1";
const PAGE_IDS = String(
  process.env.AIGUKA_META_RECOVERY_PAGE_IDS || "985632314640803,104810069068200",
).split(",").map((x) => x.trim()).filter(Boolean);
const POLL_MS = Math.max(60_000, Number(process.env.AIGUKA_META_RECOVERY_POLL_MS || 60_000));
const LOOKBACK_MS = Math.max(30 * 60_000, Number(process.env.AIGUKA_META_RECOVERY_LOOKBACK_MS || 3 * 60 * 60_000));
const MAX_CONVERSATIONS_PER_PAGE = Math.min(25, Math.max(5, Number(process.env.AIGUKA_META_RECOVERY_CONVERSATIONS || 20)));
const MAX_UPSERTS_PER_SCAN = Math.min(20, Math.max(3, Number(process.env.AIGUKA_META_RECOVERY_UPSERTS || 10)));
const HEARTBEAT_MS = 5 * 60_000;

let running = false;
let timer = null;
let nextDelay = 30_000;
let lastHeartbeatAt = 0;
let oauthCache = { expiresAt: 0, userToken: "", pageTokens: new Map() };
const conversationCursor = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && PAGE_IDS.length);
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 15_000),
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

const rpc = (name, body = {}) => supabaseRequest(`/rest/v1/rpc/${name}`, {
  method: "POST",
  body,
  timeout: 20_000,
});

async function graph(path, token, query = {}) {
  const url = /^https?:\/\//i.test(String(path))
    ? new URL(String(path))
    : new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `META_HTTP_${response.status}`);
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

async function loadPageTokens(force = false) {
  if (!force && oauthCache.expiresAt > Date.now() && oauthCache.pageTokens.size) {
    return oauthCache.pageTokens;
  }
  const connection = await loadActiveMetaConnection();
  const userToken = String(connection?.accessToken || process.env.META_ACCESS_TOKEN || "");
  if (!userToken) throw new Error("META_OAUTH_CONNECTION_NOT_AVAILABLE");

  const pageTokens = new Map();
  let next = "me/accounts?fields=id,name,access_token,tasks&limit=200";
  for (let page = 0; next && page < 5; page += 1) {
    const result = await graph(next, userToken);
    for (const item of result.data || []) {
      if (item.id && item.access_token) {
        pageTokens.set(String(item.id), {
          token: String(item.access_token),
          name: item.name || null,
        });
      }
    }
    next = result?.paging?.next || "";
  }
  oauthCache = {
    expiresAt: Date.now() + 10 * 60_000,
    userToken,
    pageTokens,
  };
  return pageTokens;
}

function participantFor(conversation, pageId) {
  return (conversation?.participants?.data || []).find(
    (item) => String(item.id || "") !== String(pageId),
  ) || null;
}

async function fetchRecentMessages(conversationId, token) {
  const fields = "id,message,created_time,from,to,attachments";
  try {
    const result = await graph(`${conversationId}/messages`, token, {
      fields,
      limit: 25,
    });
    return result.data || [];
  } catch (error) {
    if (Number(error?.code) !== 100 || !/message|field/i.test(String(error?.message || ""))) {
      throw error;
    }
    const result = await graph(`${conversationId}/messages`, token, {
      fields: "id,created_time,from,to,attachments",
      limit: 25,
    });
    return result.data || [];
  }
}

async function recoverPage(pageId, pageInfo) {
  const token = pageInfo?.token;
  if (!token) return { page_id: pageId, scanned: 0, recovered: 0, skipped: 0 };

  const result = await graph(`${pageId}/conversations`, token, {
    platform: "messenger",
    fields: "id,updated_time,participants",
    limit: MAX_CONVERSATIONS_PER_PAGE,
  });
  const cutoff = Date.now() - LOOKBACK_MS;
  let scanned = 0;
  let recovered = 0;
  let skipped = 0;

  for (const conversation of result.data || []) {
    if (recovered >= MAX_UPSERTS_PER_SCAN) break;
    const updatedAt = Date.parse(conversation.updated_time || "") || 0;
    if (!updatedAt || updatedAt < cutoff) continue;
    scanned += 1;

    const participant = participantFor(conversation, pageId);
    const senderId = String(participant?.id || "");
    if (!conversation.id || !senderId) {
      skipped += 1;
      continue;
    }

    const cursorKey = `${pageId}:${conversation.id}`;
    if (conversationCursor.get(cursorKey) === conversation.updated_time) {
      skipped += 1;
      continue;
    }

    const messages = await fetchRecentMessages(conversation.id, token);
    if (!messages.length) {
      conversationCursor.set(cursorKey, conversation.updated_time);
      skipped += 1;
      continue;
    }

    await rpc("v8_admin_upsert_history", {
      p_page_id: String(pageId),
      p_sender_id: senderId,
      p_conversation_id: String(conversation.id),
      p_messages: messages,
      p_participant_name: participant?.name || null,
    });
    conversationCursor.set(cursorKey, conversation.updated_time);
    recovered += 1;
    await sleep(250);
  }

  return { page_id: pageId, scanned, recovered, skipped };
}

async function heartbeat(status, lastError, details = {}) {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
  await supabaseRequest("/rest/v1/v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_type: "meta_history_recovery",
      worker_version: WORKER_VERSION,
      status,
      capabilities: {
        direct_meta_conversations: true,
        pancake_independent: true,
        message_id_deduplication: true,
        recent_window_minutes: Math.round(LOOKBACK_MS / 60_000),
        poll_ms: POLL_MS,
        ...details,
      },
      last_error: lastError ? String(lastError).slice(0, 700) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    timeout: 8_000,
  });
  lastHeartbeatAt = now;
}

function schedule(delay) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => scan().catch(() => {}), delay);
  timer.unref?.();
}

async function scan() {
  if (!configured() || running) {
    schedule(nextDelay);
    return;
  }
  running = true;
  const started = Date.now();
  try {
    const pageTokens = await loadPageTokens();
    const results = [];
    for (const pageId of PAGE_IDS) {
      let pageInfo = pageTokens.get(pageId);
      if (!pageInfo) {
        oauthCache.expiresAt = 0;
        pageInfo = (await loadPageTokens(true)).get(pageId);
      }
      results.push(await recoverPage(pageId, pageInfo));
      await sleep(500);
    }
    const recovered = results.reduce((sum, item) => sum + item.recovered, 0);
    nextDelay = POLL_MS;
    if (recovered) {
      console.log(`[AIGUKA Meta recovery] recovered ${recovered} recent conversation(s)`, results);
    }
    await heartbeat("healthy", null, {
      last_scan_duration_ms: Date.now() - started,
      recovered_last_scan: recovered,
      pages: results,
    }).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nextDelay = Math.min(10 * 60_000, Math.max(POLL_MS * 2, nextDelay * 2));
    console.error(`[AIGUKA Meta recovery] ${message}; retry in ${Math.round(nextDelay / 1000)}s`);
    await heartbeat("degraded", message, {
      last_scan_duration_ms: Date.now() - started,
    }).catch(() => {});
  } finally {
    running = false;
    schedule(nextDelay);
  }
}

if (!configured()) {
  console.warn("[AIGUKA Meta recovery] Supabase configuration missing; worker disabled");
} else {
  schedule(nextDelay);
  console.log(`[AIGUKA Meta recovery] Direct Meta scanner started; poll=${POLL_MS}ms lookback=${Math.round(LOOKBACK_MS / 60_000)}m`);
}
