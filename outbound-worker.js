import { loadActiveMetaConnection } from "./meta-token-store.js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const WORKER_NAME = process.env.AIGUKA_OUTBOUND_WORKER_NAME || "aiguka-railway-outbound";
const WORKER_VERSION = "production_v6_marketing_notifications"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1 AIGUKA_COMMENT_PRIVATE_REPLY_V1 AIGUKA_BINARY_IMAGE_UPLOAD_V1 AIGUKA_DRIVE_IMAGE_PROXY_V2 AIGUKA_MARKETING_NOTIFICATIONS_V1
const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_OUTBOUND_POLL_MS || 4000));
const VERIFY_MS = Math.max(60_000, Number(process.env.AIGUKA_PAGE_VERIFY_MS || 300_000));

let running = false;
let pageTokenCache = { expiresAt: 0, values: new Map() };

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `SUPABASE_HTTP_${response.status}`);
  return data;
}

async function rest(path, options = {}) {
  return request(`/rest/v1/${path}`, options);
}

async function rpc(name, args = {}) {
  return request(`/rest/v1/rpc/${name}`, { method: "POST", body: args });
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
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `META_HTTP_${response.status}`);
    error.code = data?.error?.code;
    error.subcode = data?.error?.error_subcode;
    error.details = data?.error || data;
    throw error;
  }
  return data;
}

async function heartbeat(status = "healthy", lastError = null) {
  if (!configured()) return;
  await rest("v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_type: "outbound",
      worker_version: WORKER_VERSION,
      status,
      capabilities: {
        retry: true,
        dedupe: true,
        final_gate: true,
        two_phase_authorization: true,
        meta_transport: true,
        text: true,
        image: true,
        image_proxy: true,
        carousel: true,
        marketing_notifications: true,
        marketing_optin_webhook: true,
        simulation_only: false,
        page_verification: true,
        conversation_history_preflight: true,
        message_echoes: true,
        comment_private_reply: true,
        feed_webhook: true,
      },
      last_error: lastError ? String(lastError).slice(0, 500) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function fetchPageTokens(force = false) {
  if (!force && pageTokenCache.expiresAt > Date.now()) return pageTokenCache.values;
  const pages = await rest("v8_pages?select=page_id,page_name,token_secret_name&is_active=eq.true");
  const values = new Map();

  for (const page of pages || []) {
    const envToken = page.token_secret_name ? process.env[page.token_secret_name] : "";
    if (envToken) values.set(String(page.page_id), { token: envToken, name: page.page_name, source: "railway_secret" });
  }

  try {
    const connection = await loadActiveMetaConnection();
    if (connection?.accessToken) {
      let next = `me/accounts?fields=id,name,access_token,tasks&limit=200`;
      let count = 0;
      while (next && count++ < 10) {
        const data = await graph(next, connection.accessToken);
        for (const page of data.data || []) {
          if (page.id && page.access_token) values.set(String(page.id), { token: page.access_token, name: page.name, source: "oauth_page_token", tasks: page.tasks || [] });
        }
        next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${GRAPH_VERSION}/`, "") : "";
      }
    }
  } catch (error) {
    console.error("[AIGUKA outbound] Could not refresh Page tokens:", error.message);
  }

  pageTokenCache = { expiresAt: Date.now() + 5 * 60_000, values };
  return values;
}

async function pageToken(pageId) {
  const tokens = await fetchPageTokens();
  return tokens.get(String(pageId))?.token || "";
}

async function verifyOnePage(page) {
  const token = await pageToken(page.page_id);
  const now = new Date().toISOString();
  if (!token) {
    await rest(`v8_pages?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { connection_status: "token_missing", webhook_status: "unknown", last_connection_error: "PAGE_ACCESS_TOKEN_NOT_FOUND", updated_at: now },
    });
    await rest(`v8_page_messaging_capabilities?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { pages_messaging_status: "unknown", notes: "Không tìm thấy Page Access Token", updated_at: now },
    });
    return { page_id: page.page_id, ok: false, reason: "PAGE_ACCESS_TOKEN_NOT_FOUND" };
  }

  try {
    await graph(`${page.page_id}/conversations`, token, { query: { fields: "id,updated_time", limit: 1 } });

    let subscribed = await graph(`${page.page_id}/subscribed_apps`, token, { query: { fields: "id,name,subscribed_fields" } });
    const appId = String(process.env.META_APP_ID || "");
    let app = (subscribed.data || []).find((item) => !appId || String(item.id) === appId);
    const requiredFields = ["messages", "message_echoes", "messaging_postbacks", "messaging_optins", "messaging_optouts", "message_deliveries", "message_reads", "messaging_referrals", "feed"];
    const existingFields = new Set(app?.subscribed_fields || []);
    const missing = requiredFields.filter((field) => !existingFields.has(field));

    if (!app || missing.length) {
      await graph(`${page.page_id}/subscribed_apps`, token, {
        method: "POST",
        query: { subscribed_fields: requiredFields.join(",") },
      });
      subscribed = await graph(`${page.page_id}/subscribed_apps`, token, { query: { fields: "id,name,subscribed_fields" } });
      app = (subscribed.data || []).find((item) => !appId || String(item.id) === appId) || (subscribed.data || [])[0];
    }

    const fields = app?.subscribed_fields || requiredFields;
    await rest(`v8_pages?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: {
        connection_status: "connected",
        webhook_status: "subscribed",
        subscribed_fields: fields,
        last_verified_at: now,
        last_connection_error: null,
        updated_at: now,
      },
    });
    await rest(`v8_page_messaging_capabilities?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: {
        pages_messaging_status: "active",
        notes: "Page token, conversations và subscribed_apps đã xác minh bởi Railway outbound worker",
        updated_at: now,
      },
    });
    return { page_id: page.page_id, ok: true, fields };
  } catch (error) {
    await rest(`v8_pages?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { connection_status: "error", webhook_status: "error", last_connection_error: String(error.message).slice(0, 500), updated_at: now },
    }).catch(() => {});
    await rest(`v8_page_messaging_capabilities?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { pages_messaging_status: "error", notes: String(error.message).slice(0, 500), updated_at: now },
    }).catch(() => {});
    return { page_id: page.page_id, ok: false, reason: error.message };
  }
}

async function verifyPages() {
  if (!configured()) return [];
  pageTokenCache.expiresAt = 0;
  const pages = await rest("v8_pages?select=page_id,page_name,token_secret_name&is_active=eq.true&order=page_name.asc");
  const results = [];
  for (const page of pages || []) results.push(await verifyOnePage(page));
  return results;
}

async function syncConversationHistoryBeforeSend(item) {
  const token = await pageToken(item.page_id);
  if (!token) return { ok: false, synced: false, reason: "PAGE_ACCESS_TOKEN_NOT_FOUND" };

  try {
    const conversations = await graph(`${item.page_id}/conversations`, token, {
      query: {
        user_id: String(item.sender_id),
        fields: "id,updated_time",
        limit: 1,
      },
      timeout: 12_000,
    });
    const conversation = (conversations?.data || [])[0];
    if (!conversation?.id) return { ok: true, synced: false, reason: "CONVERSATION_NOT_FOUND" };

    const detail = await graph(String(conversation.id), token, {
      query: {
        fields: "messages.limit(25){id,created_time,from,to,message,attachments}",
      },
      timeout: 12_000,
    });
    const messages = detail?.messages?.data || [];
    if (!messages.length) return { ok: true, synced: false, reason: "NO_HISTORY_MESSAGES" };

    const result = await rpc("v8_sync_conversation_history_preflight", {
      p_page_id: String(item.page_id),
      p_sender_id: String(item.sender_id),
      p_conversation_id: String(conversation.id),
      p_messages: messages,
    });
    return { ok: true, synced: true, conversation_id: conversation.id, ...result };
  } catch (error) {
    console.warn(`[AIGUKA outbound preflight] ${item.id}: ${error.message}`);
    return { ok: false, synced: false, reason: String(error.message).slice(0, 300) };
  }
}

function buildMetaMessage(item) {
  const payload = item.payload || {};
  if (payload.message && typeof payload.message === "object") return payload.message;
  if (item.message_type === "text") {
    const text = String(payload.text || "").trim();
    if (!text) throw new Error("EMPTY_TEXT_PAYLOAD");
    return { text };
  }
  if (["carousel", "generic_template", "template"].includes(item.message_type) || Array.isArray(payload.elements)) {
    const elements = Array.isArray(payload.elements) ? payload.elements.slice(0, 10) : [];
    if (!elements.length) throw new Error("EMPTY_CAROUSEL_PAYLOAD");
    return { attachment: { type: "template", payload: { template_type: "generic", elements } } };
  }
  if (item.message_type === "image") {
    const url = String(payload.url || payload.image_url || "").trim();
    if (!url) throw new Error("EMPTY_IMAGE_URL");
    return { attachment: { type: "image", payload: { url, is_reusable: true } } };
  }
  if (payload.attachment) return { attachment: payload.attachment };
  throw new Error(`UNSUPPORTED_MESSAGE_TYPE_${item.message_type}`);
}

// AIGUKA_BINARY_IMAGE_UPLOAD_V1
function extractDriveFileId(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    const queryId = url.searchParams.get("id");
    if (queryId) return queryId;
    const match = url.pathname.match(/\/d\/([^/]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function sniffImageType(buffer, headerType = "") {
  const declared = String(headerType || "").split(";")[0].trim().toLowerCase();
  if (declared.startsWith("image/")) return declared;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())) return "image/gif";
  return "";
}

function extensionForType(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "jpg";
}

async function fetchImageAsset(sourceUrl) {
  const fileId = extractDriveFileId(sourceUrl);
  const candidates = [String(sourceUrl || "").trim()];
  if (fileId) {
    candidates.unshift(
      `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
      `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`,
    );
  }

  const errors = [];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
        headers: { "user-agent": "AIGUKA/1.0" },
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = sniffImageType(buffer, response.headers.get("content-type"));
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      if (!contentType) throw new Error(`NOT_IMAGE_${response.headers.get("content-type") || "unknown"}`);
      if (buffer.length < 32) throw new Error("IMAGE_TOO_SMALL");
      const filename = `aiguka-${Date.now()}.${extensionForType(contentType)}`;
      return { blob: new Blob([buffer], { type: contentType }), filename };
    } catch (error) {
      errors.push(`${candidate}:${error.message}`);
    }
  }
  throw new Error(`IMAGE_FETCH_FAILED: ${errors.join(" | ").slice(0, 700)}`);
}

async function uploadMessengerAttachment(pageId, token, asset) {
  const uploadUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/message_attachments`);
  uploadUrl.searchParams.set("access_token", token);
  const form = new FormData();
  form.set("message", JSON.stringify({ attachment: { type: "image", payload: { is_reusable: true } } }));
  form.set("filedata", asset.blob, asset.filename);

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(45_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `META_ATTACHMENT_UPLOAD_HTTP_${response.status}`);
    error.code = data?.error?.code;
    error.details = data?.error || data;
    throw error;
  }
  if (!data?.attachment_id) throw new Error("META_ATTACHMENT_ID_MISSING");
  return String(data.attachment_id);
}

async function sendMeta(item) {
  const token = await pageToken(item.page_id);
  if (!token) throw new Error(`PAGE_ACCESS_TOKEN_NOT_FOUND_${item.page_id}`);
  const deliveryMode = String(item.payload?.delivery_mode || "");
  const commentId = String(item.payload?.comment_id || "").trim();

  let message;
  if (item.message_type === "image") {
    const payload = item.payload || {};
    const sourceUrl = String(payload.url || payload.image_url || "").trim();
    if (!sourceUrl) throw new Error("EMPTY_IMAGE_URL");
    const fileId = extractDriveFileId(sourceUrl);
    const deliveryUrl = fileId
      ? `${SUPABASE_URL}/functions/v1/aiguka-drive-image-proxy?file_id=${encodeURIComponent(fileId)}`
      : sourceUrl;
    message = { attachment: { type: "image", payload: { url: deliveryUrl, is_reusable: true } } };
  } else {
    message = buildMetaMessage(item);
  }

  if (deliveryMode === "comment_private_reply") {
    if (!commentId) throw new Error("COMMENT_PRIVATE_REPLY_ID_MISSING");
    return graph(`${item.page_id}/messages`, token, {
      method: "POST",
      body: { recipient: { comment_id: commentId }, message },
    });
  }

  const notificationToken = String(item.payload?.notification_messages_token || "").trim();
  if (deliveryMode === "notification_messages" || notificationToken) {
    if (!notificationToken) throw new Error("NOTIFICATION_MESSAGES_TOKEN_MISSING");
    return graph(`${item.page_id}/messages`, token, {
      method: "POST",
      body: {
        recipient: { notification_messages_token: notificationToken },
        message,
      },
    });
  }

  return graph(`${item.page_id}/messages`, token, {
    method: "POST",
    body: {
      recipient: { id: String(item.sender_id) },
      messaging_type: "RESPONSE",
      message,
    },
  });
}

async function processItem(item) {
  try {
    // Đồng bộ vài tin gần nhất ngay trước Final Gate. Nếu Sale/Admin vừa nhắn
    // nhưng webhook echo đến chậm hoặc bị thiếu, bản ghi lịch sử sẽ kích hoạt
    // manual_pause và hủy outbound đang ở trạng thái sending.
    const preflight = await syncConversationHistoryBeforeSend(item);
    if (!preflight?.ok) {
      // Không làm worker chết khi Conversations API lỗi tạm thời. Final Gate,
      // message_echoes và các trigger DB vẫn là các lớp bảo vệ còn lại.
      console.warn(`[AIGUKA outbound] History preflight unavailable for ${item.id}: ${preflight?.reason || "unknown"}`);
    }

    const authorization = await rpc("v8_authorize_outbound_send", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!authorization?.allowed) return;
    const confirmation = await rpc("v8_confirm_outbound_transport", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!confirmation?.allowed) return;
    const result = await sendMeta({ ...item, payload: confirmation.payload || item.payload, message_type: confirmation.message_type || item.message_type });
    await rpc("v8_complete_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_external_message_id: result.message_id || null });
  } catch (error) {
    const details = error?.details ? ` | ${JSON.stringify(error.details).slice(0, 650)}` : "";
    const diagnostic = `${String(error?.message || error)}${details}`.slice(0, 800);
    console.error(`[AIGUKA outbound] ${item.id}:`, diagnostic);
    await rpc("v8_fail_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_error: diagnostic, p_retry_seconds: 30 }).catch(() => {});
  }
}

async function poll() {
  if (!configured() || running) return;
  running = true;
  try {
    await heartbeat("healthy", null);
    const claimed = await rpc("v8_claim_outbound_batch", { p_worker_name: WORKER_NAME, p_batch_size: 10 });
    for (const item of Array.isArray(claimed) ? claimed : []) await processItem(item);
    await heartbeat("healthy", null);
  } catch (error) {
    console.error("[AIGUKA outbound worker]", error.message);
    await heartbeat("degraded", error.message).catch(() => {});
  } finally {
    running = false;
  }
}

export async function startOutboundWorker() {
  if (!configured()) {
    console.warn("[AIGUKA outbound] Supabase service configuration missing; worker not started");
    return;
  }
  await heartbeat("starting", null).catch(() => {});
  const verification = await verifyPages().catch((error) => [{ ok: false, reason: error.message }]);
  console.log("[AIGUKA outbound] Page verification:", verification);
  await poll();
  setInterval(() => { poll().catch(() => {}); }, POLL_MS).unref?.();
  setInterval(() => { verifyPages().catch((error) => console.error("[AIGUKA outbound verify]", error.message)); }, VERIFY_MS).unref?.();
  console.log(`[AIGUKA outbound] Worker ${WORKER_NAME} started; poll ${POLL_MS}ms`);
}

await startOutboundWorker();
