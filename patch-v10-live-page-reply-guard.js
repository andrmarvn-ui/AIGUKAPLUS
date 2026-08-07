import fs from "node:fs";

const FILE = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_LIVE_PAGE_REPLY_GUARD_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_OUTBOUND_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const finalGateAnchor = "async function finalGate(decision, config) {";
  if (!source.includes(finalGateAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_FINAL_GATE_MISSING");

  const helpers = String.raw`
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

async function livePageReplyEvidence(decision, customerAt) {
  const pageId = String(decision?.page_id || "").trim();
  const senderId = String(decision?.sender_id || "").trim();
  const token = String(process.env.PANCAKE_PAGE_ACCESS_TOKEN || "").trim();
  if (!pageId || !senderId || !token || !customerAt) return null;

  const latestCustomerText = livePageReplyLatestCustomerText(decision);
  let lastConversationId = "";
  for (let pageNo = 0; pageNo < 4; pageNo += 1) {
    let url = "https://pages.fm/api/public_api/v2/pages/" + encodeURIComponent(pageId)
      + "/conversations?page_access_token=" + encodeURIComponent(token);
    if (lastConversationId) url += "&last_conversation_id=" + encodeURIComponent(lastConversationId);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(3500),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const rows = Array.isArray(data.conversations) ? data.conversations : Array.isArray(data.data) ? data.data : [];
    const row = rows.find((item) => livePageReplyConversationMatches(item, senderId));
    if (row) {
      const updatedAtValue = row.updated_at || row.last_message?.created_at || row.last_message_at || null;
      const updatedAt = livePageReplyTime(updatedAtValue);
      const pancakeCustomerAt = livePageReplyTime(row.last_customer_message_at || row.last_customer_at || "");
      const effectiveCustomerAt = Math.max(customerAt, pancakeCustomerAt || 0);
      const snippet = String(row.snippet || row.last_message?.message || row.last_message?.text || "").trim();
      const normalizedSnippet = livePageReplyText(snippet);
      const sender = livePageReplySender(row);

      if (!sender || !updatedAt || updatedAt <= effectiveCustomerAt + 500) return null;
      if (latestCustomerText && normalizedSnippet && normalizedSnippet === latestCustomerText) return null;

      const actorName = String(sender.admin_name || sender.name || sender.actor_name || "").trim();
      const actorAppId = String(sender.app_id || sender.application_id || sender.bot_id || "").trim();
      return {
        source_system: livePageReplySource(row),
        sent_at: new Date(updatedAt).toISOString(),
        actor_name: actorName || null,
        actor_app_id: actorAppId || null,
        message_text: snippet.slice(0, 600) || null,
        conversation_id: String(row.id || row.conversation_id || "").trim() || null,
        evidence: "pancake_live_conversation_summary",
      };
    }

    const tail = rows[rows.length - 1];
    const next = String(tail?.id || tail?.conversation_id || "").trim();
    if (!next || next === lastConversationId || rows.length === 0) break;
    lastConversationId = next;
  }
  return null;
}

// ${MARK}

`;
  source = source.replace(finalGateAnchor, helpers + finalGateAnchor);

  const pageReplyAnchor = '  if (pageClearlyAfterCustomer || pageOrderedAfterCustomer) return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };';
  if (!source.includes(pageReplyAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_PAGE_ANCHOR_MISSING");
  source = source.replace(
    pageReplyAnchor,
    pageReplyAnchor + '\n  const livePageReply = await livePageReplyEvidence(decision, customerAt).catch(() => null);\n  if (livePageReply) return { allowed: false, reason: "LIVE_PAGE_ALREADY_REPLIED", live_page_reply: livePageReply };',
  );

  const suppressionAnchor = 'await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason, merge_job_ensured: Boolean(gate.merge?.ensured), merge_source_event_id: gate.merge?.source_event_id || null, merge_job_id: gate.merge?.job_id || null });';
  if (!source.includes(suppressionAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_SUPPRESSION_ANCHOR_MISSING");
  source = source.replace(
    suppressionAnchor,
    'await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason, merge_job_ensured: Boolean(gate.merge?.ensured), merge_source_event_id: gate.merge?.source_event_id || null, merge_job_id: gate.merge?.job_id || null, live_page_reply_source: gate.live_page_reply?.source_system || null, live_page_reply_at: gate.live_page_reply?.sent_at || null, live_page_reply_actor_name: gate.live_page_reply?.actor_name || null, live_page_reply_actor_app_id: gate.live_page_reply?.actor_app_id || null, live_page_reply_text: gate.live_page_reply?.message_text || null, live_page_reply_evidence: gate.live_page_reply?.evidence || null });',
  );

  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_live_page_reply_guard_v6";');
  if (!source.includes(MARK) || !source.includes("LIVE_PAGE_ALREADY_REPLIED") || !source.includes("live_page_reply_source")) {
    throw new Error("V10_LIVE_PAGE_REPLY_GUARD_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] live page reply guard enabled: Pancake conversation evidence is checked immediately before customer-facing delivery so AICake, automation, or admin replies cannot be duplicated by AIGUKA");
