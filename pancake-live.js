const PAGE_ID = process.env.PANCAKE_PAGE_ID || process.env.META_PAGE_ID || "";
const PAGE_TOKEN = process.env.PANCAKE_PAGE_ACCESS_TOKEN || "";
const lookupCache = new Map();

function cleanHtml(value = "") {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function messageText(msg = {}) { return cleanHtml(msg.message || msg.text || msg.content || msg.body || msg.snippet || msg.comment || msg.title || ""); }
function messageTime(msg = {}, fallback = null) { return msg.created_at || msg.inserted_at || msg.updated_at || msg.sent_at || msg.timestamp || fallback || new Date().toISOString(); }
function actorName(msg = {}) { return cleanHtml(msg.from?.name || msg.user?.name || msg.sender?.name || msg.admin_name || msg.actor_name || msg.created_by_name || ""); }
function actorId(msg = {}) { return String(msg.from?.id || msg.from_id || msg.sender_id || msg.user_id || msg.uid || msg.admin_id || ""); }
function inferDirection(msg = {}, pageId = "", senderId = "") {
  const fromId = actorId(msg); const type = String(msg.from?.type || msg.sender_type || msg.type || msg.role || "").toLowerCase();
  if (msg.is_from_page === true || msg.from_page === true || msg.is_page === true || msg.is_admin === true || msg.admin_id || msg.user?.is_admin || msg.is_echo === true) return "outbound";
  if (/admin|page|employee|agent|bot|system/.test(type)) return "outbound";
  if (pageId && fromId && fromId === String(pageId)) return "outbound";
  if (senderId && fromId && fromId === String(senderId)) return "inbound";
  return "unknown";
}
function sourceSystem(msg = {}, direction = "unknown") {
  const raw = JSON.stringify(msg || {}).toLowerCase(); const name = actorName(msg).toLowerCase();
  if (/aicake|ai cake|botcake|bot cake/.test(raw + " " + name)) return "aicake";
  if (/automation|automated|auto_reply|auto reply/.test(raw)) return "page_automation";
  if (/bot/.test(raw + " " + name)) return "bot";
  if (/pancake|pages\.fm/.test(raw + " " + name)) return "pancake";
  return direction === "inbound" ? "customer" : "pancake";
}
function attachments(msg = {}) { const values = []; for (const key of ["attachments", "images", "photos"]) if (Array.isArray(msg[key])) values.push(...msg[key]); if (msg.attachment) values.push(msg.attachment); return values; }
function looksLikeMessage(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const hasText = Boolean(obj.message || obj.text || obj.content || obj.body || obj.comment || obj.snippet || obj.title);
  const hasAttachment = Array.isArray(obj.attachments) || Array.isArray(obj.images) || Boolean(obj.attachment);
  const hasTime = Boolean(obj.created_at || obj.inserted_at || obj.updated_at || obj.sent_at || obj.timestamp);
  const hasActor = Boolean(obj.from || obj.from_id || obj.sender_id || obj.user_id || obj.admin_id || obj.is_from_page !== undefined);
  return (hasText || hasAttachment) && (hasTime || hasActor);
}
function collectMessages(node, out = [], depth = 0, seen = new WeakSet()) {
  if (!node || depth > 12) return out;
  if (typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectMessages(item, out, depth + 1, seen);
    return out;
  }
  if (looksLikeMessage(node)) out.push(node);
  for (const value of Object.values(node)) {
    if (!value || typeof value !== "object") continue;
    collectMessages(value, out, depth + 1, seen);
  }
  return out;
}
function conversationSummaryMessage(conv = {}) {
  const text = cleanHtml(conv.snippet || conv.last_message?.message || conv.last_message?.text || "");
  const sender = conv.last_sent_by || conv.last_message?.from || null;
  if (!text || !sender) return null;
  const senderName = cleanHtml(sender.admin_name || sender.name || sender.actor_name || "");
  const senderId = String(sender.admin_id || sender.id || conv.page_id || "");
  if (!senderName && !senderId) return null;
  return {
    id: `conversation-summary:${conv.id || conv.conversation_id || "unknown"}:${conv.updated_at || conv.last_message?.created_at || ""}`,
    message: text,
    created_at: conv.updated_at || conv.last_message?.created_at || conv.last_customer_message_at,
    from: { id: senderId, name: senderName },
    admin_id: sender.admin_id || sender.id || conv.page_id,
    admin_name: senderName,
    app_id: sender.app_id || sender.application_id || "",
    flow_id: sender.flow_id || "",
    is_admin: true,
    source_detail: "pancake_conversation_snippet",
  };
}
function normalizeMessage(msg, { pageId, senderId, fallbackTime }) {
  const direction = inferDirection(msg, pageId, senderId); const source = sourceSystem(msg, direction); const name = actorName(msg); const text = messageText(msg); const sentAt = messageTime(msg, fallbackTime);
  const id = String(msg.id || msg.mid || msg.message_id || msg.comment_id || `${sentAt}|${actorId(msg)}|${text.slice(0, 60)}`);
  return { id: `pancake:${id}`, message_id: id, direction, role: direction === "inbound" ? "customer" : "outbound", actor_type: direction === "inbound" ? "customer" : source, actor_name: name || (direction === "inbound" ? "Khách hàng" : "Page/nhân viên/hệ thống"), actor_app_id: String(msg.app_id || msg.application_id || msg.bot_id || ""), source_system: source, is_automatic: ["aicake", "page_automation", "bot"].includes(source), message_text: text, text, attachments: attachments(msg), sent_at: sentAt, created_at: sentAt, raw_payload: msg, source_detail: { source: msg.source_detail || "pancake_live" } };
}
function mergeUnique(messages = []) {
  const map = new Map();
  for (const item of messages) { const time = String(item.sent_at || item.created_at || ""); const text = cleanHtml(item.message_text || item.text || item.content || ""); const direction = String(item.direction || item.role || ""); const key = String(item.message_id || item.id || `${time}|${direction}|${text}`); if (!map.has(key)) map.set(key, item); }
  return [...map.values()].sort((a, b) => new Date(a.sent_at || a.created_at || 0) - new Date(b.sent_at || b.created_at || 0));
}
function conversationMatches(conv = {}, senderId = "") {
  const target = String(senderId || ""); if (!target) return false;
  const values = [conv.sender_id, conv.customer_id, conv.psid, conv.from_id, conv.from?.id, conv.user?.id, conv.customer?.id].map(v => String(v || ""));
  const id = String(conv.id || conv.conversation_id || "");
  return values.includes(target) || id === target || id.endsWith(`_${target}`);
}
async function lookupConversation(pageId, senderId, token) {
  const key = `${pageId}|${senderId}`; const cached = lookupCache.get(key);
  if (cached && Date.now() - cached.time < 3 * 60 * 1000) return cached.value;
  let last = ""; const attempts = [];
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    let url = `https://pages.fm/api/public_api/v2/pages/${encodeURIComponent(pageId)}/conversations?page_access_token=${token}`;
    if (last) url += `&last_conversation_id=${encodeURIComponent(last)}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      const rows = Array.isArray(data.conversations) ? data.conversations : Array.isArray(data.data) ? data.data : [];
      attempts.push({ lookup_page: pageNo + 1, status: response.status, count: rows.length });
      const found = rows.find(row => conversationMatches(row, senderId));
      if (found) {
        const embedded = collectMessages(found, []);
        const summary = conversationSummaryMessage(found);
        if (summary) embedded.push(summary);
        const value = { id: String(found.id || found.conversation_id || senderId), embedded, attempts };
        lookupCache.set(key, { time: Date.now(), value });
        return value;
      }
      const tail = rows[rows.length - 1]; if (!tail || !tail.id || tail.id === last || rows.length === 0) break; last = String(tail.id);
    } catch (error) { attempts.push({ lookup_page: pageNo + 1, status: "error", error: error instanceof Error ? error.message : String(error) }); break; }
  }
  const value = { id: String(senderId || ""), embedded: [], attempts }; lookupCache.set(key, { time: Date.now(), value }); return value;
}

export async function fetchPancakeConversationDetails({ conversationId, pageId = PAGE_ID, senderId = "", fallbackTime = null } = {}) {
  if (!PAGE_TOKEN || (!conversationId && !senderId)) return { ok: false, messages: [], attempts: [], reason: "pancake_not_configured_or_missing_conversation" };
  const token = encodeURIComponent(PAGE_TOKEN); const actualPage = String(pageId || PAGE_ID); const lookup = senderId ? await lookupConversation(actualPage, senderId, token) : { id: conversationId, embedded: [], attempts: [] };
  const actualId = String(lookup.id || conversationId || senderId); const page = encodeURIComponent(actualPage); const id = encodeURIComponent(actualId);
  const urls = [
    `https://pages.fm/api/public_api/v2/pages/${page}/conversations/${id}?page_access_token=${token}`,
    `https://pages.fm/api/public_api/v2/pages/${page}/conversations/${id}/messages?page_access_token=${token}`,
    `https://pages.fm/api/public_api/v2/pages/${page}/conversation_messages?conversation_id=${id}&page_access_token=${token}`,
    `https://pages.fm/api/public_api/v2/pages/${page}/messages?conversation_id=${id}&page_access_token=${token}`,
  ];
  const attempts = [...(lookup.attempts || [])]; const normalized = (lookup.embedded || []).map(msg => normalizeMessage(msg, { pageId: actualPage, senderId, fallbackTime }));
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" }); const raw = await response.text(); let data;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
      const found = collectMessages(data, []); attempts.push({ status: response.status, count: found.length, conversation_id: actualId });
      for (const msg of found) normalized.push(normalizeMessage(msg, { pageId: actualPage, senderId, fallbackTime }));
      if (found.length) break;
    } catch (error) { attempts.push({ status: "error", error: error instanceof Error ? error.message : String(error), conversation_id: actualId }); }
  }
  const messages = mergeUnique(normalized);
  return { ok: messages.length > 0, messages, attempts, conversation_id: actualId };
}

export function mergeConversationMessages(primary = [], secondary = []) {
  const normalizedPrimary = (primary || []).map(item => ({ ...item, message_text: item.message_text || item.text || item.message || item.content || "", text: item.text || item.message_text || item.message || item.content || "" }));
  return mergeUnique([...normalizedPrimary, ...(secondary || [])]);
}

export const __private__ = { sourceSystem, inferDirection, conversationSummaryMessage, normalizeMessage, conversationMatches };