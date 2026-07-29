import express from "express";

const ENV = {
  coreBase: String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, ""),
  coreKey: String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || ""),
  knowledgeBase: String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  knowledgeKey: String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""),
  reportingBase: String(process.env.AIGUKA_V9_REPORTING_URL || "").replace(/\/$/, ""),
  reportingKey: String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || ""),
};

const CACHE = new Map();
const ADMIN_TTL = Math.max(2_000, Number(process.env.AIGUKA_V9_ADMIN_CACHE_MS || 5_000));
const REPORT_TTL = Math.max(10_000, Number(process.env.AIGUKA_V9_REPORT_CACHE_MS || 30_000));
const MAX_DAYS = Math.max(7, Math.min(366, Number(process.env.AIGUKA_V9_REPORT_MAX_RANGE_DAYS || 93)));
const MAX_ROWS = Math.max(500, Math.min(20_000, Number(process.env.AIGUKA_V9_REPORT_MAX_ROWS || 8_000)));

function ready(base, key) { return Boolean(base && key); }
function core(path, options) { return db(ENV.coreBase, ENV.coreKey, path, options); }
function knowledge(path, options) { return db(ENV.knowledgeBase, ENV.knowledgeKey, path, options); }
function reporting(path, options) { return db(ENV.reportingBase, ENV.reportingKey, path, options); }
function enc(value) { return encodeURIComponent(String(value)); }

async function db(base, key, path, options = {}) {
  if (!ready(base, key)) throw Object.assign(new Error("DATA_SOURCE_NOT_CONFIGURED"), { status: 503 });
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
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 400) }; }
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`), { status: response.status, data });
  return { data, headers: response.headers };
}

async function countRows(client, table, keyField, filters = "") {
  const result = await client(`${table}?select=${keyField}${filters}&limit=1`, {
    prefer: "count=exact",
    headers: { Range: "0-0" },
  });
  const total = Number(String(result.headers.get("content-range") || "").split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function memo(key, ttl, loader) {
  const current = CACHE.get(key);
  if (current?.value && current.expiresAt > Date.now()) return { ...current.value, cache_hit: true };
  if (current?.promise) return current.promise;
  const promise = loader().then((value) => {
    CACHE.set(key, { value, expiresAt: Date.now() + ttl });
    return { ...value, cache_hit: false };
  }).catch((error) => { CACHE.delete(key); throw error; });
  CACHE.set(key, { promise, expiresAt: 0 });
  return promise;
}

function clearCache(prefix = "") { for (const key of CACHE.keys()) if (!prefix || key.startsWith(prefix)) CACHE.delete(key); }
function number(value) { const parsed = Number(value || 0); return Number.isFinite(parsed) ? parsed : 0; }
function dateOnly(value, fallback) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : fallback; }

export function parseReportRange(query = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const fallbackFrom = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const from = dateOnly(query.from, fallbackFrom);
  const to = dateOnly(query.to, today);
  const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) throw Object.assign(new Error("REPORT_RANGE_INVALID"), { status: 400, details: { from, to, max_days: MAX_DAYS } });
  return { from, to, days };
}

export function aggregatePerformance(rows = []) {
  const result = { spend: 0, impressions: 0, reach: 0, clicks: 0, conversations: 0, customers: 0, contacts: 0, deliveries: 0 };
  for (const row of rows) for (const key of Object.keys(result)) result[key] += number(row[key]);
  result.contact_rate = result.conversations ? Math.round(result.contacts * 10_000 / result.conversations) / 100 : 0;
  result.cost_per_conversation = result.conversations ? Math.round(result.spend * 100 / result.conversations) / 100 : 0;
  result.cost_per_contact = result.contacts ? Math.round(result.spend * 100 / result.contacts) / 100 : 0;
  return result;
}

function group(rows, keyOf, fields) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!map.has(key)) map.set(key, { dimensions: Object.fromEntries(fields.map((field) => [field, row[field] ?? null])), rows: [] });
    map.get(key).rows.push(row);
  }
  return [...map.values()].map(({ dimensions, rows: groupRows }) => ({ ...dimensions, ...aggregatePerformance(groupRows) }));
}

function worker(rows, name) {
  const row = rows.find((item) => item.worker_name === name);
  if (!row) return { worker_name: name, status: "missing", age_seconds: null, stale: true };
  const age = Math.max(0, Math.round((Date.now() - Date.parse(row.last_seen_at || 0)) / 1000));
  return { ...row, age_seconds: age, stale: age > 90 };
}

async function knowledgeStatus() {
  if (!ready(ENV.knowledgeBase, ENV.knowledgeKey)) return { configured: false, status: "not_configured" };
  try {
    const [runtime, snapshots, published, drafts, assets] = await Promise.all([
      knowledge("ai_runtime_config?select=mode,published_snapshot_id,cache_ttl_seconds,updated_at&id=eq.1&limit=1"),
      knowledge("ai_published_snapshots?select=id,version_no,checksum,status,built_at,created_at&status=eq.published&order=version_no.desc&limit=5"),
      countRows(knowledge, "ai_documents", "id", "&status=eq.published"),
      countRows(knowledge, "ai_documents", "id", "&status=eq.draft"),
      countRows(knowledge, "ai_assets", "id"),
    ]);
    const config = runtime.data?.[0] || null;
    const current = (snapshots.data || []).find((row) => row.id === config?.published_snapshot_id) || snapshots.data?.[0] || null;
    return { configured: true, status: "ready", runtime: config, current_snapshot: current, published_documents: published, draft_documents: drafts, assets };
  } catch (error) { return { configured: true, status: "degraded", error: String(error.message || error) }; }
}

async function reportingStatus() {
  if (!ready(ENV.reportingBase, ENV.reportingKey)) return { configured: false, status: "not_configured" };
  try {
    const [runtime, heartbeats, ingestEvents] = await Promise.all([
      reporting("reporting_runtime_config?select=mode,retention_days,timezone,updated_at&id=eq.1&limit=1"),
      reporting("reporting_worker_heartbeats?select=worker_name,worker_version,status,details,last_error,last_seen_at,updated_at&order=worker_name.asc"),
      countRows(reporting, "reporting_ingest_events", "event_key"),
    ]);
    return { configured: true, status: "ready", runtime: runtime.data?.[0] || null, heartbeats: heartbeats.data || [], ingest_events: ingestEvents };
  } catch (error) { return { configured: true, status: "degraded", error: String(error.message || error) }; }
}

async function adminOverview() {
  const started = Date.now();
  if (!ready(ENV.coreBase, ENV.coreKey)) return { ok: true, configured: false, generated_at: new Date().toISOString(), core: { status: "missing_credentials" }, knowledge: await knowledgeStatus(), reporting: await reportingStatus() };
  const [runtime, pages, heartbeats, queued, processing, dead, outbox, knowledgeState, reportingState] = await Promise.all([
    core("v9_runtime_config?select=*&id=eq.1&limit=1"),
    core("v9_pages?select=page_id,page_name,operating_mode,coexistence_mode,canary_percent,is_active,timezone,updated_at&order=page_name.asc"),
    core("v9_worker_heartbeats?select=worker_name,worker_version,status,mode,details,last_error,last_seen_at,updated_at&order=worker_name.asc"),
    countRows(core, "v9_jobs", "id", "&status=eq.queued"),
    countRows(core, "v9_jobs", "id", "&status=eq.processing"),
    countRows(core, "v9_jobs", "id", "&status=eq.dead_letter"),
    countRows(core, "v9_reporting_outbox", "id", "&status=eq.pending"),
    knowledgeStatus(),
    reportingStatus(),
  ]);
  const heartbeatRows = heartbeats.data || [];
  return {
    ok: true,
    configured: true,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    core: {
      status: "ready",
      runtime: runtime.data?.[0] || null,
      pages: pages.data || [],
      jobs: { queued, processing, dead_letter: dead },
      reporting_outbox_pending: outbox,
      workers: [
        worker(heartbeatRows, "aiguka-v9-legacy-inbox-bridge"),
        worker(heartbeatRows, "aiguka-v9-direct-core"),
        worker(heartbeatRows, "aiguka-v9-ai-shadow"),
        worker(heartbeatRows, "aiguka-v9-reporting-publisher"),
      ],
    },
    knowledge: knowledgeState,
    reporting: reportingState,
  };
}

function filter(field, value, normalizeAct = false) {
  let data = String(value || "").trim();
  if (!data) return "";
  if (normalizeAct) data = data.replace(/^act_/, "");
  return `&${field}=eq.${enc(data)}`;
}

async function performanceRows(range, query) {
  if (!ready(ENV.reportingBase, ENV.reportingKey)) throw Object.assign(new Error("REPORTING_NOT_CONFIGURED"), { status: 503 });
  const path = "fact_daily_ad_performance?select=report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id,spend,impressions,reach,clicks,conversations,customers,contacts,deliveries,metadata,updated_at"
    + `&report_date=gte.${range.from}&report_date=lte.${range.to}`
    + filter("page_id", query.page_id)
    + filter("ad_account_id", query.ad_account_id, true)
    + filter("campaign_id", query.campaign_id)
    + filter("adset_id", query.adset_id)
    + filter("ad_id", query.ad_id)
    + `&order=report_date.desc&limit=${MAX_ROWS}`;
  return (await reporting(path, { timeout: 10_000 })).data || [];
}

async function reportFilters() {
  if (!ready(ENV.reportingBase, ENV.reportingKey)) throw Object.assign(new Error("REPORTING_NOT_CONFIGURED"), { status: 503 });
  const [pages, ads] = await Promise.all([
    reporting("dim_pages?select=page_id,page_name,operating_mode,is_active&order=page_name.asc"),
    reporting("dim_ads?select=ad_id,ad_name,page_id,ad_account_id,ad_account_name,campaign_id,campaign_name,adset_id,adset_name,effective_status&order=campaign_name.asc,adset_name.asc,ad_name.asc&limit=5000"),
  ]);
  const accounts = new Map();
  for (const ad of ads.data || []) if (ad.ad_account_id) accounts.set(ad.ad_account_id, { ad_account_id: ad.ad_account_id, ad_account_name: ad.ad_account_name || ad.ad_account_id });
  return { ok: true, data: { pages: pages.data || [], ad_accounts: [...accounts.values()], ads: ads.data || [] } };
}

async function reportLeads(range, query) {
  if (!ready(ENV.reportingBase, ENV.reportingKey)) throw Object.assign(new Error("REPORTING_NOT_CONFIGURED"), { status: 503 });
  const limit = Math.max(10, Math.min(200, Number(query.limit || 50)));
  const offset = Math.max(0, Number(query.offset || 0));
  let path = "dim_customers?select=page_id,customer_id,display_name,gender,preferred_salutation,first_seen_at,last_seen_at,attributes,updated_at"
    + `&last_seen_at=gte.${range.from}T00:00:00Z&last_seen_at=lte.${range.to}T23:59:59Z`
    + filter("page_id", query.page_id)
    + `&order=last_seen_at.desc&limit=${limit}&offset=${offset}`;
  const customers = (await reporting(path)).data || [];
  const ids = [...new Set(customers.map((row) => row.customer_id).filter(Boolean))];
  let contacts = [];
  if (ready(ENV.coreBase, ENV.coreKey) && ids.length) {
    try {
      const inList = ids.map((id) => `\"${String(id).replaceAll("\"", "")}\"`).join(",");
      contacts = (await core(`v9_contacts?select=page_id,customer_id,contact_type,contact_value,normalized_value,captured_at&customer_id=in.(${enc(inList)})&limit=500`)).data || [];
    } catch { contacts = []; }
  }
  const contactMap = new Map();
  for (const item of contacts) {
    const key = `${item.page_id}|${item.customer_id}`;
    const current = contactMap.get(key) || {};
    current[item.contact_type] = item.normalized_value || item.contact_value;
    contactMap.set(key, current);
  }
  const data = customers.map((row) => ({ ...row, ...(contactMap.get(`${row.page_id}|${row.customer_id}`) || {}), has_contact: contactMap.has(`${row.page_id}|${row.customer_id}`) }));
  return { ok: true, data, count: data.length, range, pagination: { limit, offset }, contact_enriched_from_core: true };
}

async function loadReport(action, query) {
  if (action === "filters") return reportFilters();
  const range = parseReportRange(query);
  if (action === "leads") return reportLeads(range, query);
  if (!["summary", "daily", "ads"].includes(action)) throw Object.assign(new Error("UNKNOWN_REPORT_ACTION"), { status: 404 });
  const rows = await performanceRows(range, query);
  if (action === "summary") return { ok: true, data: aggregatePerformance(rows), range, source_rows: rows.length };
  if (action === "daily") {
    const data = group(rows, (row) => `${row.report_date}|${row.page_id}|${row.ad_account_id}`, ["report_date", "page_id", "ad_account_id"]).sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    return { ok: true, data, count: data.length, range, source_rows: rows.length };
  }
  const data = group(rows, (row) => `${row.page_id}|${row.ad_account_id}|${row.ad_id}`, ["page_id", "ad_account_id", "campaign_id", "adset_id", "ad_id"]).sort((a, b) => b.spend - a.spend);
  return { ok: true, data, count: data.length, range, source_rows: rows.length };
}

function pageMode(value) {
  const mode = String(value || "").toUpperCase();
  if (!["OFF", "SUPPORT", "SHADOW", "CANARY"].includes(mode)) throw Object.assign(new Error("PAGE_MODE_NOT_ALLOWED"), { status: 400 });
  return mode;
}
function runtimeMode(value) {
  const mode = String(value || "").toUpperCase();
  if (!["OFF", "SHADOW", "CANARY"].includes(mode)) throw Object.assign(new Error("RUNTIME_MODE_NOT_ALLOWED"), { status: 400 });
  return mode;
}
function fail(res, error, fallback) { res.status(error.status || 502).json({ ok: false, error: error.message || fallback, details: error.details || error.data || null }); }

export function installV9AdminReportApiV2(app) {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));

  router.get("/admin/overview", async (_req, res) => {
    try { res.setHeader("cache-control", "private, max-age=2, stale-while-revalidate=10"); res.json(await memo("admin:overview", ADMIN_TTL, adminOverview)); }
    catch (error) { fail(res, error, "ADMIN_OVERVIEW_FAILED"); }
  });

  router.patch("/admin/pages/:pageId", async (req, res) => {
    try {
      if (!ready(ENV.coreBase, ENV.coreKey)) throw Object.assign(new Error("CORE_NOT_CONFIGURED"), { status: 503 });
      const body = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (body.operating_mode !== undefined) patch.operating_mode = pageMode(body.operating_mode);
      if (body.canary_percent !== undefined) patch.canary_percent = Math.max(0, Math.min(100, Number(body.canary_percent || 0)));
      if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
      const result = await core(`v9_pages?page_id=eq.${enc(req.params.pageId)}`, { method: "PATCH", body: patch });
      clearCache("admin:");
      res.json({ ok: true, data: result.data?.[0] || null });
    } catch (error) { fail(res, error, "PAGE_UPDATE_FAILED"); }
  });

  router.patch("/admin/runtime", async (req, res) => {
    try {
      if (!ready(ENV.coreBase, ENV.coreKey)) throw Object.assign(new Error("CORE_NOT_CONFIGURED"), { status: 503 });
      const body = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (body.mode !== undefined) patch.mode = runtimeMode(body.mode);
      if (body.debounce_seconds !== undefined) patch.debounce_seconds = Math.max(5, Math.min(120, Number(body.debounce_seconds)));
      if (body.response_sla_seconds !== undefined) patch.response_sla_seconds = Math.max(15, Math.min(600, Number(body.response_sla_seconds)));
      if (body.actor_settle_seconds !== undefined) patch.actor_settle_seconds = Math.max(5, Math.min(120, Number(body.actor_settle_seconds)));
      const result = await core("v9_runtime_config?id=eq.1", { method: "PATCH", body: patch });
      clearCache("admin:");
      res.json({ ok: true, data: result.data?.[0] || null });
    } catch (error) { fail(res, error, "RUNTIME_UPDATE_FAILED"); }
  });

  router.post("/admin/cache/clear", (_req, res) => { clearCache(); res.json({ ok: true, cleared_at: new Date().toISOString() }); });

  router.get("/report/:action", async (req, res) => {
    const action = String(req.params.action || "summary").toLowerCase();
    const cacheKey = `report:${action}:${new URLSearchParams(Object.entries(req.query).map(([key, value]) => [key, String(value)])).toString()}`;
    try {
      res.setHeader("cache-control", "private, max-age=10, stale-while-revalidate=60");
      const result = await memo(cacheKey, action === "filters" ? 300_000 : REPORT_TTL, async () => {
        const started = Date.now();
        return { ...(await loadReport(action, req.query)), elapsed_ms: Date.now() - started, source: "v9_reporting" };
      });
      res.json(result);
    } catch (error) { fail(res, error, "REPORT_QUERY_FAILED"); }
  });

  app.use("/api/v9", router);
  return { clearCache };
}

export const __private__ = { pageMode, runtimeMode, group, countRows };
