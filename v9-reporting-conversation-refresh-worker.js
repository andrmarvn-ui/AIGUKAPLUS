import { fetchPancakeConversationDetails } from "./pancake-live.js";

const SOURCE_BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const SOURCE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const REPORT_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || SOURCE_BASE).replace(/\/$/, "");
const REPORT_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || SOURCE_KEY);
const INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.AIGUKA_V9_CONVERSATION_REFRESH_MS || 10 * 60_000));
const BENCHMARK_INTERVAL_MS = Math.max(20_000, Number(process.env.AIGUKA_V9_BENCHMARK_REFRESH_MS || 30_000));
const WORKER = "aiguka-v9-reporting-conversation-refresh";
const VERSION = "1.2.1";
const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;
let cycle = 0;
let running = false;
let benchmarkRunning = false;
let latestBenchmark = null;

const nowIso = () => new Date().toISOString();
const ready = () => Boolean(SOURCE_BASE && SOURCE_KEY && REPORT_BASE && REPORT_KEY);
const enc = (value) => encodeURIComponent(String(value ?? ""));

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
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(data?.message || data?.error || `HTTP_${response.status}`);
  return data;
}

async function heartbeat(status, details = {}, error = null) {
  try {
    await request(REPORT_BASE, REPORT_KEY, "reporting_worker_heartbeats?on_conflict=worker_name", {
      method: "POST",
      body: {
        worker_name: WORKER,
        worker_version: VERSION,
        status,
        details: { ...details, benchmark: latestBenchmark },
        last_error: error ? String(error).slice(0, 1000) : null,
        last_seen_at: nowIso(),
        updated_at: nowIso(),
      },
      prefer: "resolution=merge-duplicates,return=minimal",
      timeout: 10_000,
    });
  } catch (heartbeatError) {
    console.error(`[${WORKER}] heartbeat failed:`, heartbeatError.message);
  }
}

export function refreshSince(cycleNo = 1, now = Date.now()) {
  const lookbackMs = cycleNo === 1 ? 3 * 86_400_000 : 30 * 60_000;
  return new Date(now - lookbackMs).toISOString();
}

export function mapConversationRow(row, refreshedAt = nowIso()) {
  const sourceChannel = String(row?.source_channel || "pancake").trim() || "pancake";
  const hasAd = Boolean(String(row?.ad_id || "").trim());
  return {
    source_channel: sourceChannel,
    conversation_id: row.conversation_id,
    tenant_id: row.tenant_id,
    page_id: row.page_id,
    page_name: row.page_name,
    sender_id: row.sender_id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    conversation_started_at: row.conversation_started_at,
    conversation_date_vn: row.conversation_date_vn,
    message_count: Number(row.message_count || 0),
    ad_id: row.ad_id,
    ad_name_at_start: row.ad_name,
    ad_name_current: row.ad_name,
    ad_account_id: row.ad_account_id,
    ad_account_name: row.ad_account_name,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    ad_status_at_start: row.ad_status,
    ad_status_current: row.ad_status,
    attribution_source: hasAd ? "legacy_attribution_materialized" : "organic_or_unknown",
    attribution_confidence: hasAd ? 100 : 0,
    attribution_reason: hasAd ? "materialized_from_v8_report_conversation_attribution" : "no_ad_evidence",
    referral_at: null,
    phone: row.phone,
    zalo: row.zalo,
    has_contact: row.has_contact === true,
    is_hot_lead: row.is_hot_lead === true,
    lead_score: row.lead_score,
    lead_level: row.lead_level,
    product_group: row.product_group,
    product_label: row.product_label,
    lead_status: row.lead_status,
    pancake_tags: row.pancake_tags || [],
    pancake_employee: row.pancake_employee,
    pancake_status: row.pancake_status,
    last_snippet: row.last_snippet,
    identity_source: row.identity_source,
    source_created_at: row.created_at,
    source_updated_at: row.updated_at,
    fact_version: 21,
    refreshed_at: refreshedAt,
  };
}

async function fetchChangedConversations(since) {
  const fields = [
    "source_channel", "conversation_id", "tenant_id", "page_id", "page_name", "sender_id",
    "customer_id", "customer_name", "conversation_started_at", "conversation_date_vn", "message_count",
    "ad_id", "ad_name", "ad_account_id", "ad_account_name", "campaign_id", "campaign_name",
    "adset_id", "adset_name", "ad_status", "phone", "zalo", "has_contact", "is_hot_lead",
    "lead_score", "lead_level", "product_group", "product_label", "lead_status", "pancake_tags",
    "pancake_employee", "pancake_status", "last_snippet", "identity_source", "created_at", "updated_at",
  ].join(",");
  const changed = encodeURIComponent(`(updated_at.gte.${since},created_at.gte.${since},conversation_started_at.gte.${since})`);
  const rows = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const page = await request(
      SOURCE_BASE,
      SOURCE_KEY,
      `v8_report_conversation_attribution?select=${fields}&conversation_id=not.is.null&or=${changed}&order=updated_at.asc.nullslast,conversation_started_at.asc&limit=${PAGE_SIZE}&offset=${offset}`,
      { timeout: 30_000 },
    );
    const data = Array.isArray(page) ? page : [];
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  if (rows.length >= MAX_ROWS) throw new Error(`CONVERSATION_REFRESH_LIMIT_REACHED_${MAX_ROWS}`);
  return rows;
}

async function upsertFacts(rows) {
  if (!rows.length) return 0;
  const refreshedAt = nowIso();
  const facts = rows.map((row) => mapConversationRow(row, refreshedAt));
  for (let offset = 0; offset < facts.length; offset += 250) {
    await request(
      SOURCE_BASE,
      SOURCE_KEY,
      "v8_report_v21_conversation_fact?on_conflict=source_channel,conversation_id",
      {
        method: "POST",
        body: facts.slice(offset, offset + 250),
        prefer: "resolution=merge-duplicates,return=minimal",
        timeout: 30_000,
      },
    );
  }
  return facts.length;
}

function requestsContact(text) {
  return /(?:s(?:ố|đ)t|sđt|điện thoại|zalo|liên hệ|để lại số|xin số)/i.test(String(text || ""));
}

function chooseObservedReply(messages, firstCustomerAt) {
  const threshold = Date.parse(firstCustomerAt || 0) - 1_000;
  const outbound = (messages || []).filter((item) => {
    const timestamp = Date.parse(item.sent_at || item.created_at || 0);
    return item.direction === "outbound" && Number.isFinite(timestamp) && timestamp >= threshold && String(item.message_text || "").trim();
  });
  return outbound.find((item) => item.source_system === "aicake")
    || outbound.find((item) => item.is_automatic === true)
    || outbound[0]
    || null;
}

function safeAttempts(attempts = []) {
  return attempts.slice(0, 8).map((item) => ({
    status: item.status,
    count: Number(item.count || 0),
    lookup_page: item.lookup_page || null,
  }));
}

async function syncShadowBenchmark() {
  if (benchmarkRunning || !ready()) return latestBenchmark;
  benchmarkRunning = true;
  try {
    const runs = await request(SOURCE_BASE, SOURCE_KEY, "v9_shadow_benchmark_runs?select=*&status=eq.active&order=started_at.desc&limit=1", { timeout: 10_000 });
    const run = runs?.[0];
    if (!run) {
      latestBenchmark = { status: "inactive" };
      return latestBenchmark;
    }
    const rows = await request(
      SOURCE_BASE,
      SOURCE_KEY,
      `v9_shadow_benchmark_conversations?select=*&run_id=eq.${enc(run.id)}&order=sequence_no.asc&limit=${Math.max(20, Number(run.target_conversations || 12))}`,
      { timeout: 10_000 },
    );
    let captured = 0;
    let verifiedAicake = 0;
    for (const row of rows || []) {
      if (row.comparison?.source_verified_v2 === true) continue;
      const details = await fetchPancakeConversationDetails({
        conversationId: row.sender_id,
        pageId: row.page_id,
        senderId: row.sender_id,
        fallbackTime: row.first_customer_at,
      });
      const observed = chooseObservedReply(details.messages, row.first_customer_at);
      if (!observed) {
        await request(SOURCE_BASE, SOURCE_KEY, `v9_shadow_benchmark_conversations?id=eq.${enc(row.id)}`, {
          method: "PATCH",
          body: {
            comparison: {
              ...(row.comparison || {}),
              last_pancake_lookup_at: nowIso(),
              pancake_lookup_ok: details.ok === true,
              pancake_lookup_attempts: safeAttempts(details.attempts),
            },
            updated_at: nowIso(),
          },
          prefer: "return=minimal",
          timeout: 10_000,
        });
        continue;
      }
      const observedAt = observed.sent_at || observed.created_at || nowIso();
      const source = observed.source_system || observed.actor_type || "pancake";
      const isVerifiedAicake = source === "aicake";
      if (isVerifiedAicake) verifiedAicake += 1;
      const comparison = {
        ...(row.comparison || {}),
        aicake_requests_contact: requestsContact(observed.message_text),
        aicake_reply_latency_seconds: Math.max(0, Math.round((Date.parse(observedAt) - Date.parse(row.first_customer_at)) / 1000)),
        contact_request_match: row.aiguka_should_request_contact == null
          ? null
          : Boolean(row.aiguka_should_request_contact) === requestsContact(observed.message_text),
        observed_via: "pancake_live",
        observed_actor_name: observed.actor_name || null,
        observed_actor_app_id: observed.actor_app_id || null,
        aicake_source_verified: isVerifiedAicake,
        source_verified_v2: true,
        pancake_lookup_attempts: safeAttempts(details.attempts),
      };
      await request(SOURCE_BASE, SOURCE_KEY, `v9_shadow_benchmark_conversations?id=eq.${enc(row.id)}`, {
        method: "PATCH",
        body: {
          aicake_reply: String(observed.message_text || "").slice(0, 6000),
          aicake_reply_at: observedAt,
          aicake_source: source,
          aicake_is_automatic: observed.is_automatic === true,
          comparison,
          status: row.aiguka_decision_id || row.aiguka_status ? "complete" : "aicake_observed",
          updated_at: nowIso(),
        },
        prefer: "return=minimal",
        timeout: 10_000,
      });
      captured += 1;
    }
    const finalRows = await request(
      SOURCE_BASE,
      SOURCE_KEY,
      `v9_shadow_benchmark_conversations?select=id,status,aicake_source,comparison&run_id=eq.${enc(run.id)}&order=sequence_no.asc&limit=${Math.max(20, Number(run.target_conversations || 12))}`,
      { timeout: 10_000 },
    );
    const observedCount = finalRows.length;
    const completedCount = finalRows.filter((item) => item.status === "complete").length;
    const verifiedCount = finalRows.filter((item) => item.comparison?.aicake_source_verified === true).length;
    const done = observedCount >= Number(run.target_conversations || 12) && completedCount >= Number(run.target_conversations || 12);
    await request(SOURCE_BASE, SOURCE_KEY, `v9_shadow_benchmark_runs?id=eq.${enc(run.id)}`, {
      method: "PATCH",
      body: {
        observed_conversations: observedCount,
        completed_conversations: completedCount,
        status: done ? "completed" : "active",
        completed_at: done ? (run.completed_at || nowIso()) : null,
        notes: {
          ...(run.notes || {}),
          verified_aicake_replies: verifiedCount,
          actual_customer_facing_replies: completedCount,
        },
        updated_at: nowIso(),
      },
      prefer: "return=minimal",
      timeout: 10_000,
    });
    latestBenchmark = {
      run_id: run.id,
      status: done ? "completed" : "active",
      target: Number(run.target_conversations || 12),
      observed: observedCount,
      completed: completedCount,
      verified_aicake: verifiedCount,
      replies_reclassified_last_tick: captured,
      verified_aicake_last_tick: verifiedAicake,
      transport_locked: true,
    };
    return latestBenchmark;
  } catch (error) {
    latestBenchmark = { ...(latestBenchmark || {}), status: "degraded", error: String(error?.message || error).slice(0, 300) };
    return latestBenchmark;
  } finally {
    benchmarkRunning = false;
  }
}

async function refresh() {
  if (running || !ready()) return;
  running = true;
  cycle += 1;
  const started = Date.now();
  const since = refreshSince(cycle);
  const details = {
    cycle,
    since,
    mode: cycle === 1 ? "startup_3d" : "incremental_30m",
    source: "v8_report_conversation_attribution",
    target: "v8_report_v21_conversation_fact",
    transport: "direct_postgrest_table_upsert",
    raw_contact_logging: false,
  };
  try {
    await heartbeat("running", details);
    const rows = await fetchChangedConversations(since);
    details.source_rows = rows.length;
    details.rows_upserted = await upsertFacts(rows);
    await syncShadowBenchmark();
    details.elapsed_ms = Date.now() - started;
    await heartbeat("healthy", details);
    console.log(`[${WORKER}] healthy`, details);
  } catch (error) {
    details.elapsed_ms = Date.now() - started;
    await heartbeat("degraded", details, error instanceof Error ? error.message : String(error));
    console.error(`[${WORKER}] refresh failed:`, error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

if (!ready()) {
  console.warn(`[${WORKER}] disabled: source/reporting credentials missing`);
} else {
  void refresh();
  void syncShadowBenchmark();
  setInterval(() => void refresh(), INTERVAL_MS).unref();
  setInterval(() => void syncShadowBenchmark(), BENCHMARK_INTERVAL_MS).unref();
}

export const __private__ = {
  ready,
  refreshSince,
  mapConversationRow,
  fetchChangedConversations,
  upsertFacts,
  requestsContact,
  chooseObservedReply,
  safeAttempts,
  syncShadowBenchmark,
};