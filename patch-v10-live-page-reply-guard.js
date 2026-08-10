import fs from "node:fs";

const FILE = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_LIVE_PAGE_REPLY_GUARD_V2_SUPPORT";

if (!fs.existsSync(FILE)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_OUTBOUND_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const finalGateAnchor = "async function finalGate(decision, config) {";
  if (!source.includes(finalGateAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_FINAL_GATE_MISSING");
  const importAnchor = 'import { normalizeVietnamese } from "./v10/core/advisory-engine.js";';
  if (!source.includes(importAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_IMPORT_MISSING");
  source = source.replace(
    importAnchor,
    importAnchor + '\nimport { createPancakeConversationSnapshotCache } from "./v10/core/pancake-conversation-snapshot.js";',
  );

  const helpers = String.raw`
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

function supportSlideCaption(gate, decision) {
  const recentContactRequest = supportReplyRequestsContact(gate?.livePageReply)
    || String(decision?.output?.contact_state || "").toLowerCase() === "missing_recently_requested";
  if (gate?.contactKnown || recentContactRequest) {
    return "Em gửi anh/chị một số mẫu bán chạy để tham khảo trước ạ.";
  }
  return "Em gửi anh/chị một số mẫu bán chạy để tham khảo trước; nếu cần đúng mẫu và báo giá chính xác, anh/chị cho em xin SĐT/Zalo nhé.";
}

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

// ${MARK}

`;
  source = source.replace(finalGateAnchor, helpers + finalGateAnchor);

  const finalStart = source.indexOf(finalGateAnchor);
  const finalEnd = source.indexOf("\n\nasync function claim(decision)", finalStart);
  if (finalStart < 0 || finalEnd < 0) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_FINAL_GATE_RANGE_MISSING");

  const finalGate = String.raw`async function finalGate(decision, config) {
  if (String(config.mode || "").toUpperCase() !== "ACTIVE") return { allowed: false, reason: "RUNTIME_NOT_ACTIVE" };
  if (String(config.ingest_mode || "").toUpperCase() !== "DIRECT_CORE") return { allowed: false, reason: "INGEST_NOT_DIRECT_CORE" };

  const page = await pageRow(decision.page_id);
  if (!page?.is_active) return { allowed: false, reason: "PAGE_NOT_ACTIVE" };
  const pageMode = String(page.operating_mode || "").toUpperCase();
  const externalBotMode = String(config.external_bot_mode || "").toUpperCase();
  const externalBotPolicy = String(config.external_bot_policy || "").toUpperCase();
  const supportMode = pageMode === "SUPPORT";
  const primaryMode = pageMode === "ACTIVE";

  if (supportMode) {
    if (externalBotMode !== "AICAKE_ACTIVE") return { allowed: false, reason: "SUPPORT_REQUIRES_AICAKE_ACTIVE" };
    if (externalBotPolicy !== "AICAKE_PRIMARY_SUPPORT") return { allowed: false, reason: "SUPPORT_POLICY_NOT_ACTIVE" };
    if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_ACTIVE") return { allowed: false, reason: "PAGE_AICAKE_NOT_ACTIVE" };
    if (page?.settings?.support_enabled !== true) return { allowed: false, reason: "PAGE_SUPPORT_NOT_ENABLED" };
  } else if (primaryMode) {
    if (externalBotMode !== "AICAKE_DISABLED") return { allowed: false, reason: "EXTERNAL_BOT_NOT_DISABLED" };
    if (externalBotPolicy !== "AIGUKA_PRIMARY") return { allowed: false, reason: "AIGUKA_NOT_PRIMARY" };
    if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_DISABLED") return { allowed: false, reason: "PAGE_EXTERNAL_BOT_NOT_DISABLED" };
  } else {
    return { allowed: false, reason: "PAGE_NOT_ACTIVE" };
  }

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
  const supportTextFallbackEligible = supportFallbackRequested
    && page?.settings?.support_operational_fallback_enabled === true
    && Date.now() - latestCustomerAt(decision) >= supportFallbackWaitMs;
  if (supportMode && !supportSlideEligible && !supportImageEligible && !supportTextFallbackEligible) {
    return { allowed: false, reason: "SUPPORT_MEDIA_ONLY" };
  }

  let text = String(output.final_reply || "").trim();
  if ((!text && !supportSlideEligible) || decision.action === "suppress") return { allowed: false, reason: "NO_SEND_ACTION" };
  if (Number(decision.confidence || output.confidence || 0) < 0.45) return { allowed: false, reason: "CONFIDENCE_TOO_LOW" };

  const state = await stateRow(decision.page_id, decision.sender_id);
  const takeoverUntil = Date.parse(state.human_takeover_until || "");
  if (state.human_takeover && (!Number.isFinite(takeoverUntil) || takeoverUntil > Date.now())) return { allowed: false, reason: "HUMAN_TAKEOVER" };

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
    text = stripRepeatedContactRequest(text) || "Dạ em đã nhận nội dung của anh/chị và tiếp tục tư vấn tại Messenger ạ.";
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
  };
}`;
  source = source.slice(0, finalStart) + finalGate + source.slice(finalEnd);

  const bundleAnchor = "  const bundle = await bundleFor(claimed, gate.text, media.assets);";
  if (!source.includes(bundleAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_BUNDLE_ANCHOR_MISSING");
  source = source.replace(bundleAnchor, `  if (gate.supportMode && gate.supportSlideEligible && !media.assets.length) {\n    await patchDecision(claimed, "live_suppressed", {\n      should_send: false,\n      transport_locked: true,\n      live_suppression_reason: "SUPPORT_NO_PUBLISHED_ASSET",\n      support_mode: true,\n      support_primary_bot: "AICAKE",\n    });\n    return { sent: 0, suppressed: 1, failed: 0 };\n  }\n\n  const deliveryText = gate.supportMode\n    ? (gate.supportSlideEligible ? supportSlideCaption(gate, claimed) : supportCompactImageReply(gate))\n    : gate.text;\n  if (!deliveryText) {\n    await patchDecision(claimed, "live_suppressed", {\n      should_send: false,\n      transport_locked: true,\n      live_suppression_reason: "SUPPORT_NO_USEFUL_TEXT",\n      support_mode: Boolean(gate.supportMode),\n    });\n    return { sent: 0, suppressed: 1, failed: 0 };\n  }\n\n  const bundle = await bundleFor(claimed, deliveryText, media.assets);`);
  source = source.replace(
    "? (gate.supportSlideEligible ? supportSlideCaption(gate, claimed) : supportCompactImageReply(gate))",
    "? (gate.supportSlideEligible ? supportSlideCaption(gate, claimed) : (gate.supportTextFallbackEligible ? gate.text : supportCompactImageReply(gate)))",
  );

  const sendTextAnchor = "      textResult = await sendText(claimed.page_id, claimed.sender_id, gate.text);";
  if (!source.includes(sendTextAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_SEND_TEXT_ANCHOR_MISSING");
  source = source.replace(sendTextAnchor, "      textResult = await sendText(claimed.page_id, claimed.sender_id, deliveryText);");

  const suppressionAnchor = 'await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason, merge_job_ensured: Boolean(gate.merge?.ensured), merge_source_event_id: gate.merge?.source_event_id || null, merge_job_id: gate.merge?.job_id || null });';
  if (!source.includes(suppressionAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_SUPPRESSION_ANCHOR_MISSING");
  source = source.replace(
    suppressionAnchor,
    'await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason, merge_job_ensured: Boolean(gate.merge?.ensured), merge_source_event_id: gate.merge?.source_event_id || null, merge_job_id: gate.merge?.job_id || null, live_page_reply_source: gate.live_page_reply?.source_system || null, live_page_reply_at: gate.live_page_reply?.sent_at || null, live_page_reply_actor_name: gate.live_page_reply?.actor_name || null, live_page_reply_actor_app_id: gate.live_page_reply?.actor_app_id || null, live_page_reply_text: gate.live_page_reply?.message_text || null, live_page_reply_evidence: gate.live_page_reply?.evidence || null });',
  );

  const gateAnchor = "  if (!gate.allowed) {";
  if (!source.includes(gateAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_GATE_RETRY_ANCHOR_MISSING");
  source = source.replace(gateAnchor, `  if (!gate.allowed && gate.retryable) {\n    return { sent: 0, suppressed: 0, failed: 0, retryable: 1 };\n  }\n  if (!gate.allowed) {`);

  const deliveryMetadataAnchor = "      contact_request_sanitized: Boolean(gate.contactKnown && claimed.output?.should_request_contact),";
  if (!source.includes(deliveryMetadataAnchor)) throw new Error("V10_LIVE_PAGE_REPLY_GUARD_DELIVERY_METADATA_ANCHOR_MISSING");
  source = source.replace(deliveryMetadataAnchor, `${deliveryMetadataAnchor}\n      support_mode: Boolean(gate.supportMode),\n      support_primary_bot: gate.supportMode ? "AICAKE" : null,\n      support_operational_fallback_delivered: Boolean(gate.supportTextFallbackEligible),\n      support_fallback_guard_degraded: Boolean(gate.supportFallbackGuardDegraded),\n      support_live_reply_source: gate.livePageReply?.source_system || null,`);

  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_aicake_primary_support_v9_operational_failover";');
  if (!source.includes(MARK)
    || !source.includes("AICAKE_PRIMARY_SUPPORT")
    || !source.includes("SUPPORT_MEDIA_ONLY")
    || !source.includes("SUPPORT_NO_PUBLISHED_ASSET")
    || !source.includes("LIVE_PAGE_ALREADY_REPLIED")
    || !source.includes("SUPPORT_PRIMARY_REPLIED_BEFORE_FALLBACK")
    || !source.includes("SUPPORT_FALLBACK_PANCAKE_CHECK_RETRY")
    || !source.includes("supportTextFallbackEligible")
    || !source.includes("pancake_live_shared_page_snapshot")) {
    throw new Error("V10_LIVE_PAGE_REPLY_GUARD_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] AICake-primary support guard enabled: AIGUKA sends requested media and takes over overdue unanswered text after the live Pancake safety check");
