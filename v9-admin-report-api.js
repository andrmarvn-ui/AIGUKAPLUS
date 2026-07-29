import express from "express";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const REPORTING_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || "").replace(/\/$/, "");
const REPORTING_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || "");

const REPORT_CACHE_MS = Math.max(10_000, Number(process.env.AIGUKA_V9_REPORT_CACHE_MS || 30_000));
const ADMIN_CACHE_MS = Math.max(2_000, Number(process.env.AIGUKA_V9_ADMIN_CACHE_MS || 5_000));
const MAX_RANGE_DAYS = Math.max(7, Math.min(366, Number(process.env.AIGUKA_V9_REPORT_MAX_RANGE_DAYS || 93)));
const MAX_ROWS = Math.max(100, Math.min(20_000, Number(process.env.AIGUKA_V9_REPORT_MAX_ROWS || 8_000)));

const cache = new Map();

function jsonError(res, status, code, details = null) {
  res.status(status).json({ ok: false, error: code, details });
}

function sourceReady(base, key) {
  return Boolean(base && key);
}

async function request(base, key, path, options = {}) {
  if (!sourceReady(base, key)) throw new Error("DATA_SOURCE_NOT_CONFIGURED");
  const started = Date.now();
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 8_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 400) }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { data, elapsed_ms: Date.now() - started, headers: response.headers };
}

function core(path, options) { return request(CORE_BASE, CORE_KEY, path, options); }
function knowledge(path, options) { return request(KNOWLEDGE_BASE, KNOWLEDGE_KEY, path, options); }
function reporting(path, options) { return request(REPORTING_BASE, REPORTING_KEY, path, options); }

async function cached(key, ttl, loader) {
  const found = cache.get(key);
  if (found && found.expires_at > Date.now()) return { ...found.value, cache_hit: true };
  if (found?.promise) return found.promise;
  const promise = Promise.resolve().then(loader).then((value) => {
    cache.set(key, { expires_at: Date.now() + ttl, value });
    return { ...value, cache_hit: false };
  }).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expires_at: 0, promise });
  return promise;
}

function clearCache(prefix = "") {
  for (const key of cache.keys()) if (!prefix || key.startsWith(prefix)) cache.delete(key);
}

function isoDate(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  return raw;
}

function reportRange(query) {
  const today = new Date().toISOString().slice(0, 10);
  const fallbackFrom = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const from = isoDate(query.from, fallbackFrom);
  const to = isoDate(query.to, today);
  const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > MAX_RANGE_DAYS) {
    const error = new Error("REPORT_RANGE_INVALID");
    error.details = { from, to, max_days: MAX_RANGE_DAYS };
    throw error;
  }
  return { from, to, days };
}

function q(value) { return encodeURIComponent(String(value)); }
function optionalFilter(field, value) {
  const v = String(value || "").trim();
  return v ? `&${field}=eq.${q(v.replace(/^act_/, ""))}` : "";
}

async function countRows(client, table, filters = "") {
  const result = await client(`${table}?select=id${filters}&limit=1`, {
    headers: { Prefer: "count=exact" },
    prefer: "count=exact",
  });
  const range = result.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : Array.isArray(result.data) ? result.data.length : 0;
}

function safeHeartbeat(rows, workerName) {
  const row = (rows || []).find((item) => item.worker_name === workerName);
  if (!row) return { worker_name: workerName, status: "missing", age_seconds: null, last_error: null };
  const age = Math.max(0, Math.round((Date.now() - Date.parse(row.last_seen_at || 0)) / 1000));
  return { ...row, age_seconds: age, stale: age > 90 };
}

async function loadAdminOverview() {
  if (!sourceReady(CORE_BASE, CORE_KEY)) {
    return {
      ok: true,
      configured: false,
      core: { status: "missing_credentials" },
      knowledge: { configured: sourceReady(KNOWLEDGE_BASE, KNOWLEDGE_KEY) },
      reporting: { configured: sourceReady(REPORTING_BASE, REPORTING_KEY) },
      generated_at: new Date().toISOString(),
    };
  }

  const started = Date.now();
  const [runtimeResult, pagesResult, heartbeatResult, jobsQueued, jobsProcessing, jobsDead, outboxPending] = await Promise.all([
    core("v9_runtime_config?select=*&id=eq.1&limit=1"),
    core("v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,canary_percent,is_active,timezone,updated_at&order=page_name.asc"),
    core("v9_worker_heartbeats?select=worker_name,worker_version,status,mode,details,last_error,last_seen_at,updated_at&order=worker_name.asc"),
    countRows(core, "v9_jobs", "&status=eq.queued"),
    countRows(core, "v9_jobs", "&status=eq.processing"),
    countRows(core, "v9_jobs", "&status=eq.dead_letter"),
    countRows(core, "v9_reporting_outbox", "&status=eq.pending"),
  ]);

  let knowledgeState = { configured: sourceReady(KNOWLEDGE_BASE, KNOWLEDGE_KEY), status: "not_configured" };
  if (knowledgeState.configured) {
    try {
      const [snapshot, publishedCount, draftCount, assetsCount] = await Promise.all([
        knowledge("ai_published_snapshots?select=id,version,checksum,published_at,created_at&is_current=eq.true&limit=1"),
        countRows(knowledge, "ai_documents", "&status=eq.published"),
        countRows(knowledge, "ai_documents", "&status=eq.draft"),
        countRows(knowledge, "ai_assets", ""),
      ]);
      knowledgeState = {
        configured: true,
        status: "ready",
        current_snapshot: snapshot.data?.[0] || null,
        published_documents: publishedCount,
        draft_documents: draftCount,
        assets: assetsCount,
      };
    } catch (error) {
      knowledgeState = { configured: true, status: "degraded", error: String(error.message || error) };
    }
  }

  let reportingState = { configured: sourceReady(REPORTING_BASE, REPORTING_KEY), status: "not_configured" };
  if (reportingState.configured) {
    try {
      const [config, heartbeats, ingestCount] = await Promise.all([
        reporting("reporting_runtime_config?select=*&id=eq.1&limit=1"),
        reporting("reporting_worker_heartbeats?select=*&order=worker_name.asc"),
        countRows(reporting, "reporting_ingest_events", ""),
      ]);
      reportingState = {
        configured: true,
        status: "ready",
        runtime: config.data?.[0] || null,
        heartbeats: heartbeats.data || [],
        ingest_events: ingestCount,
      };
    } catch (error) {
      reportingState = { configured: true, status: "degraded", error: String(error.message || error) };
    }
  }

  const heartbeats = heartbeatResult.data || [];
  return {
    ok: true,
    configured: true,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    core: {
      status: "ready",
      runtime: runtimeResult.data?.[0] || null,
      pages: pagesResult.data || [],
      jobs: { queued: jobsQueued, processing: jobsProcessing, dead_letter: jobsDead },
      reporting_outbox_pending: outboxPending,
      workers: [
        safeHeartbeat(heartbeats, "aiguka-v9-legacy-inbox-bridge"),
        safeHeartbeat(heartbeats, "aiguka-v9-direct-core"),
        safeHeartbeat(heartbeats, "aiguka-v9-ai-shadow"),
        safeHeartbeat(heartbeats, "aiguka-v9-reporting-publisher"),
      ],
    },
    knowledge: knowledgeState,
    reporting: reportingState,
  };
}

async function reportingRows(table, select, range, query, order, extra = "") {
  if (!sourceReady(REPORTING_BASE, REPORTING_KEY)) {
    const error = new Error("REPORTING_NOT_CONFIGURED");
    error.status = 503;
    throw error;
  }
  const pageId = query.page_id || "";
  const adAccountId = query.ad_account_id || "";
  const campaignId = query.campaign_id || "";
  const adsetId = query.adset_id || "";
  const adId = query.ad_id || "";
  const path = `${table}?select=${select}&report_date=gte.${range.from}&report_date=lte.${range.to}`
    + optionalFilter("page_id", pageId)
    + optionalFilter("ad_account_id", adAccountId)
    + optionalFilter("campaign_id", campaignId)
    + optionalFilter("adset_id", adsetId)
    + optionalFilter("ad_id", adId)
    + extra
    + `&order=${order}&limit=${MAX_ROWS}`;
  return (await reporting(path, { timeout: 10_000 })).data || [];
}

function num(value) { const n = Number(value || 0); return Number.isFinite(n) ? n : 0; }
function aggregatePerformance(rows) {
  const out = { spend: 0, impressions: 0, reach: 0, clicks: 0, conversations: 0, customers: 0, contacts: 0, deliveries: 0 };
  for (const row of rows) for (const key of Object.keys(out)) out[key] += num(row[key]);
  out.contact_rate = out.conversations ? Math.round(out.contacts * 10_000 / out.conversations) / 100 : 0;
  out.cost_per_conversation = out.conversations ? Math.round(out.spend * 100 / out.conversations) / 100 : 0;
  out.cost_per_contact = out.contacts ? Math.round(out.spend * 100 / out.contacts) / 100 : 0;
  return out;
}

function groupPerformance(rows, keyBuilder, dimensions) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyBuilder(row);
    if (!groups.has(key)) groups.set(key, { ...Object.fromEntries(dimensions.map((d) => [d, row[d] ?? null])), rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map((group) => ({ ...group, ...aggregatePerformance(group.rows), rows: undefined }));
}

async function loadReportFilters() {
  if (!sourceReady(REPORTING_BASE, REPORTING_KEY)) throw Object.assign(new Error("REPORTING_NOT_CONFIGURED"), { status: 503 });
  const [pages, ads] = await Promise.all([
    reporting("dim_pages?select=page_id,page_name,operating_mode,is_active&order=page_name.asc"),
    reporting("dim_ads?select=ad_id,ad_name,page_id,ad_account_id,ad_account_name,campaign_id,campaign_name,adset_id,adset_name,effective_status&order=campaign_name.asc,adset_name.asc,ad_name.asc&limit=5000"),
  ]);
  const adAccounts = new Map();
  for (const ad of ads.data || []) if (ad.ad_account_id) adAccounts.set(ad.ad_account_id, { ad_account_id: ad.ad_account_id, ad_account_name: ad.ad_account_name || ad.ad_account_id });
  return { ok: true, data: { pages: pages.data || [], ad_accounts: [...adAccounts.values()], ads: ads.data || [] } };
}

async function loadReport(action, query) {
  const range = reportRange(query);
  if (action === "filters") return loadReportFilters();
  if (action === "summary" || action === "daily" || action === "ads") {
    const rows = await reportingRows(
      "fact_daily_ad_performance",
      "report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id,spend,impressions,reach,clicks,conversations,customers,contacts,deliveries,metadata,updated_at",
      range,
      query,
      "report_date.desc",
    );
    if (action === "summary") return { ok: true, data: aggregatePerformance(rows), range, source_rows: rows.length };
    if (action === "daily") {
      const data = groupPerformance(rows, (r) => `${r.report_date}|${r.page_id}|${r.ad_account_id}`, ["report_date", "page_id", "ad_account_id"])
        .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
      return { ok: true, data, count: data.length, range, source_rows: rows.length };
    }
    const data = groupPerformance(rows, (r) => `${r.page_id}|${r.ad_account_id}|${r.ad_id}`, ["page_id", "ad_account_id", "campaign_id", "adset_id", "ad_id"])
      .sort((a, b) => b.spend - a.spend);
    return { ok: true, data, count: data.length, range, source_rows: rows.length };
  }
  if (action === "leads") {
    if (!sourceReady(REPORTING_BASE, REPORTING_KEY)) throw Object.assign(new Error("REPORTING_NOT_CONFIGURED"), { status: 503 });
    const limit = Math.max(10, Math.min(200, Number(query.limit || 50)));
    const offset = Math.max(0, Number(query.offset || 0));
    let path = `dim_customers?select=page_id,customer_id,display_name,gender,preferred_salutation,first_seen_at,last_seen_at,attributes,updated_at`;
    if (query.page_id) path += `&page_id=eq.${q(query.page_id)}`;
    path += `&last_seen_at=gte.${range.from}T00:00:00Z&last_seen_at=lte.${range.to}T23:59:59Z&order=last_seen_at.desc&limit=${limit}&offset=${offset}`;
    const customers = (await reporting(path)).data || [];
    const customerIds = customers.map((row) => row.customer_id).filter(Boolean);
    let contacts = [];
    if (sourceReady(CORE_BASE, CORE_KEY) && customerIds.length) {
      try {
        const ids = customerIds.map((id) => `\"${String(id).replaceAll("\"", "")}\"`).join(",");
        contacts = (await core(`v9_contacts?select=page_id,customer_id,contact_type,contact_value,normalized_value,captured_at&customer_id=in.(${encodeURIComponent(ids)})&limit=500`)).data || [];
      } catch { contacts = []; }
    }
    const contactMap = new Map();
    for (const item of contacts) {
      const key = `${item.page_id}|${item.customer_id}`;
      const current = contactMap.get(key) || {};
      if (item.contact_type === "phone") current.phone = item.normalized_value || item.contact_value;
      if (item.contact_type === "zalo") current.zalo = item.normalized_value || item.contact_value;
      contactMap.set(key, current);
    }
    const data = customers.map((row) => ({ ...row, ...(contactMap.get(`${row.page_id}|${row.customer_id}`) || {}), has_contact: contactMap.has(`${row.page_id}|${row.customer_id}`) }));
    return { ok: true, data, count: data.length, range, pagination: { limit, offset }, contact_enriched_from_core: true };
  }
  throw Object.assign(new Error("UNKNOWN_REPORT_ACTION"), { status: 404 });
}

function validateMode(mode) {
  const value = String(mode || "").toUpperCase();
  if (!["OFF", "SUPPORT", "SHADOW", "CANARY"].includes(value)) throw Object.assign(new Error("MODE_NOT_ALLOWED_DURING_MIGRATION"), { status: 400 });
  return value;
}

export function installV9AdminReportApi(app) {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));

  router.get("/admin/overview", async (_req, res) => {
    try {
      res.setHeader("cache-control", "private, max-age=2, stale-while-revalidate=10");
      res.json(await cached("admin:overview", ADMIN_CACHE_MS, loadAdminOverview));
    } catch (error) {
      jsonError(res, error.status || 502, error.message || "ADMIN_OVERVIEW_FAILED", error.details || null);
    }
  });

  router.patch("/admin/pages/:pageId", async (req, res) => {
    try {
      if (!sourceReady(CORE_BASE, CORE_KEY)) return jsonError(res, 503, "CORE_NOT_CONFIGURED");
      const body = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (body.operating_mode !== undefined) patch.operating_mode = validateMode(body.operating_mode);
      if (body.canary_percent !== undefined) patch.canary_percent = Math.max(0, Math.min(100, Number(body.canary_percent || 0)));
      if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
      const result = await core(`v9_pages?page_id=eq.${q(req.params.pageId)}`, { method: "PATCH", body: patch });
      clearCache("admin:");
      res.json({ ok: true, data: result.data?.[0] || null });
    } catch (error) {
      jsonError(res, error.status || 502, error.message || "PAGE_UPDATE_FAILED", error.data || null);
    }
  });

  router.patch("/admin/runtime", async (req, res) => {
    try {
      if (!sourceReady(CORE_BASE, CORE_KEY)) return jsonError(res, 503, "CORE_NOT_CONFIGURED");
      const body = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (body.mode !== undefined) patch.mode = validateMode(body.mode);
      if (body.debounce_seconds !== undefined) patch.debounce_seconds = Math.max(5, Math.min(120, Number(body.debounce_seconds)));
      if (body.response_sla_seconds !== undefined) patch.response_sla_seconds = Math.max(15, Math.min(600, Number(body.response_sla_seconds)));
      if (body.actor_settle_seconds !== undefined) patch.actor_settle_seconds = Math.max(5, Math.min(120, Number(body.actor_settle_seconds)));
      const result = await core("v9_runtime_config?id=eq.1", { method: "PATCH", body: patch });
      clearCache("admin:");
      res.json({ ok: true, data: result.data?.[0] || null });
    } catch (error) {
      jsonError(res, error.status || 502, error.message || "RUNTIME_UPDATE_FAILED", error.data || null);
    }
  });

  router.post("/admin/cache/clear", (_req, res) => {
    clearCache();
    res.json({ ok: true, cleared_at: new Date().toISOString() });
  });

  router.get("/report/:action", async (req, res) => {
    const action = String(req.params.action || "summary").toLowerCase();
    const key = `report:${action}:${new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)])).toString()}`;
    try {
      res.setHeader("cache-control", "private, max-age=10, stale-while-revalidate=60");
      const result = await cached(key, action === "filters" ? 300_000 : REPORT_CACHE_MS, async () => {
        const started = Date.now();
        const value = await loadReport(action, req.query);
        return { ...value, elapsed_ms: Date.now() - started, source: "v9_reporting" };
      });
      res.json(result);
    } catch (error) {
      jsonError(res, error.status || 502, error.message || "REPORT_QUERY_FAILED", error.details || error.data || null);
    }
  });

  app.use("/api/v9", router);
  return { clearCache };
}
