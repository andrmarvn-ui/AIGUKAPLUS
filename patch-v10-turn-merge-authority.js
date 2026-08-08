import fs from "node:fs";

const OUTBOUND_FILE = "v10-outbound-worker.js";
const JANITOR_FILE = "v10-decision-queue-janitor.js";
const OUTBOUND_MARK = "AIGUKA_V10_CUSTOMER_CLUSTER_MERGE_AUTHORITY_V1";
const JANITOR_MARK = "AIGUKA_V10_CLUSTER_FRONTIER_DEDUPE_V1";

if (!fs.existsSync(OUTBOUND_FILE)) throw new Error("V10_TURN_MERGE_OUTBOUND_MISSING");
if (!fs.existsSync(JANITOR_FILE)) throw new Error("V10_TURN_MERGE_JANITOR_MISSING");

let outbound = fs.readFileSync(OUTBOUND_FILE, "utf8");
if (!outbound.includes(OUTBOUND_MARK)) {
  outbound = outbound.replace(
    'v9_runtime_config?select=mode,external_bot_mode,external_bot_policy,ingest_mode&id=eq.1&limit=1',
    'v9_runtime_config?select=mode,external_bot_mode,external_bot_policy,ingest_mode,debounce_seconds&id=eq.1&limit=1',
  );
  outbound = outbound.replace(
    'v9_runtime_config?select=mode,external_bot_mode,external_bot_policy,ingest_mode,response_sla_seconds&id=eq.1&limit=1',
    'v9_runtime_config?select=mode,external_bot_mode,external_bot_policy,ingest_mode,response_sla_seconds,debounce_seconds&id=eq.1&limit=1',
  );
  if (!outbound.includes("response_sla_seconds,debounce_seconds")) {
    throw new Error("V10_TURN_MERGE_RUNTIME_TIMING_FIELDS_MISSING");
  }
  outbound = outbound.replace(
    'v9_conversation_state?select=state,contact_status,phone,zalo,human_takeover,human_takeover_until,last_customer_event_at,last_page_event_at&page_id=',
    'v9_conversation_state?select=state,contact_status,phone,zalo,human_takeover,human_takeover_until,last_customer_event_at,last_page_event_at,last_source_event_id&page_id=',
  );

  const finalGateAnchor = 'async function finalGate(decision, config) {';
  if (!outbound.includes(finalGateAnchor)) throw new Error("V10_TURN_MERGE_FINAL_GATE_ANCHOR_MISSING");
  const helpers = String.raw`
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

// ${OUTBOUND_MARK}

`;
  outbound = outbound.replace(finalGateAnchor, helpers + finalGateAnchor);

  const oldGuard = `  const customerAt = latestCustomerAt(decision);\n  const liveCustomerAt = Date.parse(state.last_customer_event_at || "");\n  if (customerAt > 0 && Number.isFinite(liveCustomerAt) && liveCustomerAt > customerAt + 250) {\n    return { allowed: false, reason: "CUSTOMER_TURN_SUPERSEDED" };\n  }\n  const pageAt = Date.parse(state.last_page_event_at || "");`;
  if (!outbound.includes(oldGuard)) throw new Error("V10_TURN_MERGE_OLD_SUPERSESSION_GUARD_MISSING");
  const newGuard = `  const customerAt = latestCustomerAt(decision);\n  const liveCustomerAt = Date.parse(state.last_customer_event_at || "");\n  if (customerAt > 0 && Number.isFinite(liveCustomerAt) && liveCustomerAt > customerAt + 250) {\n    const merge = await ensureLatestCustomerClusterJob(decision, state, config);\n    return { allowed: false, reason: "CUSTOMER_CLUSTER_ADVANCED_WAIT_MERGE", merge };\n  }\n  const pageAt = Date.parse(state.last_page_event_at || "");`;
  outbound = outbound.replace(oldGuard, newGuard);

  const suppressionWrite = 'await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason });';
  if (!outbound.includes(suppressionWrite)) throw new Error("V10_TURN_MERGE_SUPPRESSION_WRITE_MISSING");
  outbound = outbound.replace(
    suppressionWrite,
    'await patchDecision(claimed, "live_suppressed", { should_send: false, transport_locked: true, live_suppression_reason: gate.reason, merge_job_ensured: Boolean(gate.merge?.ensured), merge_source_event_id: gate.merge?.source_event_id || null, merge_job_id: gate.merge?.job_id || null });',
  );
  outbound = outbound.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_cluster_merge_v4";');
  fs.writeFileSync(OUTBOUND_FILE, outbound, "utf8");
}

let janitor = fs.readFileSync(JANITOR_FILE, "utf8");
if (!janitor.includes(JANITOR_MARK)) {
  const helperAnchor = 'async function cleanup() {';
  if (!janitor.includes(helperAnchor)) throw new Error("V10_TURN_MERGE_JANITOR_CLEANUP_ANCHOR_MISSING");
  const helper = String.raw`
function clusterFrontier(row) {
  const messages = row?.input_snapshot?.conversation?.messages || [];
  const customers = messages.filter((message) => message && message.role === "customer");
  const latest = customers.at(-1);
  if (!latest) return "";
  return String(latest.id || latest.occurred_at || "").trim();
}

// ${JANITOR_MARK}

`;
  janitor = janitor.replace(helperAnchor, helper + helperAnchor);

  const oldBlock = `  let superseded = 0;\n  const latestByConversation = new Map();\n\n  for (const row of rows || []) {\n    const key = \`${'${row.page_id}:${row.sender_id}'}\`;\n    if (latestByConversation.has(key)) {\n      await suppress(row, "superseded", "A newer pending customer event exists in the same conversation and will carry the full history.");\n      superseded += 1;\n      continue;\n    }\n    latestByConversation.set(key, row);\n\n    if (!isV10(row)) {`;
  if (!janitor.includes(oldBlock)) throw new Error("V10_TURN_MERGE_JANITOR_LATEST_WINS_BLOCK_MISSING");
  const newBlock = `  let superseded = 0;\n  let duplicateClusters = 0;\n  const seenClusterFrontiers = new Set();\n\n  for (const row of rows || []) {\n    if (isV10(row)) {\n      const frontier = clusterFrontier(row);\n      const clusterKey = frontier ? \`${'${row.page_id}:${row.sender_id}:${frontier}'}\` : "";\n      if (clusterKey && seenClusterFrontiers.has(clusterKey)) {\n        await suppress(row, "duplicate_customer_cluster", "Another pending V10 decision already represents the exact same customer-message frontier.");\n        duplicateClusters += 1;\n      } else if (clusterKey) {\n        seenClusterFrontiers.add(clusterKey);\n      }\n      continue;\n    }\n\n    if (!isV10(row)) {`;
  janitor = janitor.replace(oldBlock, newBlock);
  janitor = janitor.replace(
    '    superseded,\n    deliveryRecovered,',
    '    superseded,\n    duplicateClusters,\n    conversation_merge_authority: "core_ingest_debounce",\n    deliveryRecovered,',
  );
  janitor = janitor.replace('const VERSION = "v10_queue_hygiene_v2";', 'const VERSION = "v10_queue_hygiene_v3_merge_safe";');
  fs.writeFileSync(JANITOR_FILE, janitor, "utf8");
}

console.log("[AIGUKA V10] customer-cluster merge authority enabled: Core debounce owns turn merging; outbound holds stale replies and guarantees a merged job; janitor dedupes only identical frontiers");
