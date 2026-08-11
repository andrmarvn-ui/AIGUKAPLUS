import { loadActiveMetaConnection } from "../../meta-token-store.js";

export const MESSAGE_GATEWAY_VERSION = "v10_message_gateway_v1_atomic_dispatch";
export const DISPATCH_OWNERS = Object.freeze({
  LIVE: "aiguka_live",
  FOLLOWUP: "aiguka_followup",
});

function cleanPath(value) {
  return String(value || "").replace(/^\//, "");
}

export function createMessageGateway({
  coreRequest,
  fetchImpl = globalThis.fetch,
  loadConnection = loadActiveMetaConnection,
  graphVersion = process.env.META_GRAPH_VERSION || "v23.0",
} = {}) {
  if (typeof coreRequest !== "function") throw new Error("MESSAGE_GATEWAY_CORE_REQUEST_REQUIRED");
  if (typeof fetchImpl !== "function") throw new Error("MESSAGE_GATEWAY_FETCH_REQUIRED");

  let tokenCache = { expiresAt: 0, values: new Map() };

  async function graph(path, token, options = {}) {
    const url = new URL(`https://graph.facebook.com/${graphVersion}/${cleanPath(path)}`);
    url.searchParams.set("access_token", token);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
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
      throw error;
    }
    return data;
  }

  async function pageTokens(force = false) {
    if (!force && tokenCache.expiresAt > Date.now()) return tokenCache.values;
    const connection = await loadConnection();
    if (!connection?.accessToken) throw new Error("META_OAUTH_CONNECTION_NOT_READY");
    const values = new Map();
    let next = "me/accounts?fields=id,name,access_token,tasks&limit=200";
    let pages = 0;
    while (next && pages++ < 10) {
      const data = await graph(next, connection.accessToken);
      for (const page of data.data || []) {
        if (page.id && page.access_token) {
          values.set(String(page.id), { token: page.access_token, name: page.name, tasks: page.tasks || [] });
        }
      }
      next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${graphVersion}/`, "") : "";
    }
    tokenCache = { expiresAt: Date.now() + 5 * 60_000, values };
    return values;
  }

  async function pageToken(pageId) {
    const values = await pageTokens();
    return values.get(String(pageId))?.token || "";
  }

  async function send(pageId, senderId, message) {
    const token = await pageToken(pageId);
    if (!token) throw new Error(`META_PAGE_TOKEN_NOT_FOUND:${pageId}`);
    return graph("me/messages", token, {
      method: "POST",
      body: {
        messaging_type: "RESPONSE",
        recipient: { id: String(senderId) },
        message,
      },
    });
  }

  async function claimDispatch({ pageId, senderId, owner, dedupeKey, priority, leaseSeconds = 90 }) {
    const rows = await coreRequest("rpc/v10_claim_message_dispatch", {
      method: "POST",
      timeout: 10_000,
      body: {
        p_page_id: String(pageId),
        p_sender_id: String(senderId),
        p_owner: String(owner),
        p_dedupe_key: String(dedupeKey),
        p_priority: Number(priority || 0),
        p_lease_seconds: Math.max(15, Math.min(300, Number(leaseSeconds || 90))),
      },
    });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async function releaseDispatch({ pageId, senderId, owner, dedupeKey, result = "released" }) {
    const rows = await coreRequest("rpc/v10_release_message_dispatch", {
      method: "POST",
      timeout: 10_000,
      body: {
        p_page_id: String(pageId),
        p_sender_id: String(senderId),
        p_owner: String(owner),
        p_dedupe_key: String(dedupeKey),
        p_result: String(result).slice(0, 120),
      },
    });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  return Object.freeze({
    version: MESSAGE_GATEWAY_VERSION,
    warmPageTokens: pageTokens,
    claimDispatch,
    releaseDispatch,
    sendText: (pageId, senderId, text) => send(pageId, senderId, { text: String(text) }),
    sendImage: (pageId, senderId, imageUrl) => send(pageId, senderId, {
      attachment: { type: "image", payload: { url: String(imageUrl), is_reusable: true } },
    }),
    sendCarousel: (pageId, senderId, elements) => send(pageId, senderId, {
      attachment: { type: "template", payload: { template_type: "generic", elements } },
    }),
  });
}

