import crypto from "node:crypto";

const SOURCE_BASE = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SOURCE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const REPORT_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || SOURCE_BASE).replace(/\/$/, "");
const REPORT_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || SOURCE_KEY);
const INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.AIGUKA_V9_REPORTING_REFRESH_MS || 10 * 60_000));
const HASH_SALT = String(process.env.AIGUKA_V9_REPORT_CONTACT_HASH_SALT || SOURCE_KEY);
const WORKER = "aiguka-v9-reporting-legacy-refresh";
const VERSION = "1.0.0";
const BATCH = 500;
let cycle = 0;
let running = false;

function ready() { return Boolean(SOURCE_BASE && SOURCE_KEY && REPORT_BASE && REPORT_KEY); }
function isoDaysAgo(days) { return new Date(Date.now() - days * 86_400_000).toISOString(); }
function dateDaysAgo(days) { return isoDaysAgo(days).slice(0, 10); }
function clean(value) { const text = String(value ?? "").trim(); return text || null; }
function hashContact(type, value) {
  return crypto.createHmac("sha256", HASH_SALT).update(`${type}|${String(value || "").trim().toLowerCase()}`).digest("hex");
}
function catalogKeys(row) {
  return [...new Set([row.product_item_key, row.product_group, row.product_type].map(clean).filter(Boolean))];
}

async function request(base, key, path, options = {}) {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=minimal",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(data?.message || data?.error || `HTTP_${response.status}`);
  return { data, headers: response.headers };
}

async function source(path, options) { return request(SOURCE_BASE, SOURCE_KEY, path, options); }
async function report(path, options) { return request(REPORT_BASE, REPORT_KEY, path, options); }

async function fetchAll(client, path, maxRows = 20_000) {
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += 1000) {
    const result = await client(path, { headers: { Range: `${offset}-${offset + 999}` }, prefer: "count=exact", timeout: 45_000 });
    const page = Array.isArray(result.data) ? result.data : [];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function upsert(table, rows, conflict) {
  if (!rows.length) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await report(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: "POST",
      body: batch,
      prefer: "resolution=merge-duplicates,return=minimal",
      timeout: 45_000,
    });
    written += batch.length;
  }
  return written;
}

async function heartbeat(status, details = {}, lastError = null) {
  try {
    await upsert("reporting_worker_heartbeats", [{
      worker_name: WORKER,
      worker_version: VERSION,
      status,
      details,
      last_error: lastError,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }], "worker_name");
  } catch (error) {
    console.error(`[${WORKER}] heartbeat failed:`, error.message);
  }
}

async function refreshPages() {
  const rows = await fetchAll(source, "v8_pages?select=page_id,page_name,bot_mode,is_active,category,connection_status,webhook_status,page_username,created_at,updated_at&page_id=not.is.null&order=page_name.asc", 5000);
  return upsert("dim_pages", rows.map((row) => ({
    page_id: row.page_id,
    page_name: row.page_name,
    timezone: "Asia/Bangkok",
    operating_mode: row.bot_mode,
    is_active: row.is_active !== false,
    attributes: {
      source: "legacy_v8_refresh",
      category: row.category,
      connection_status: row.connection_status,
      webhook_status: row.webhook_status,
      page_username: row.page_username,
    },
    first_seen_at: row.created_at || new Date().toISOString(),
    last_seen_at: row.updated_at || row.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })), "page_id");
}

async function refreshCustomers(full) {
  const since = isoDaysAgo(full ? 3650 : 3);
  const path = "v8_customers?select=id,page_id,sender_id,display_name,gender,preferred_salutation,phone,zalo,first_seen_at,last_seen_at,lead_score,lead_state,status,assigned_sale,last_product_key,last_catalog_key,gender_source"
    + `&page_id=not.is.null&id=not.is.null&last_seen_at=gte.${encodeURIComponent(since)}&order=last_seen_at.desc`;
  const rows = await fetchAll(source, path, 20_000);
  const now = new Date().toISOString();
  const customers = rows.map((row) => ({
    page_id: row.page_id,
    customer_id: String(row.id),
    display_name: row.display_name,
    gender: row.gender,
    preferred_salutation: row.preferred_salutation,
    attributes: {
      source: "legacy_v8_refresh",
      sender_id: row.sender_id,
      has_contact: Boolean(clean(row.phone) || clean(row.zalo)),
      lead_score: row.lead_score,
      lead_state: row.lead_state,
      status: row.status,
      assigned_sale: row.assigned_sale,
      last_product_key: row.last_product_key,
      last_catalog_key: row.last_catalog_key,
      gender_source: row.gender_source,
    },
    first_seen_at: row.first_seen_at || row.last_seen_at || now,
    last_seen_at: row.last_seen_at || row.first_seen_at || now,
    updated_at: now,
  }));
  const contacts = [];
  const staff = new Map();
  for (const row of rows) {
    if (clean(row.phone)) contacts.push({
      source_contact_id: `legacy:phone:${row.id}`,
      page_id: row.page_id,
      customer_id: String(row.id),
      contact_type: "phone",
      contact_hash: hashContact("phone", String(row.phone).replace(/\D/g, "")),
      confidence: 1,
      captured_at: row.last_seen_at || row.first_seen_at || now,
      attributes: { source: "legacy_v8_refresh", value_present: true },
      ingested_at: now,
    });
    if (clean(row.zalo)) contacts.push({
      source_contact_id: `legacy:zalo:${row.id}`,
      page_id: row.page_id,
      customer_id: String(row.id),
      contact_type: "zalo",
      contact_hash: hashContact("zalo", row.zalo),
      confidence: 1,
      captured_at: row.last_seen_at || row.first_seen_at || now,
      attributes: { source: "legacy_v8_refresh", value_present: true },
      ingested_at: now,
    });
    const name = clean(row.assigned_sale);
    if (name) staff.set(name.toLowerCase(), name);
  }
  const staffRows = [...staff.values()].map((name) => ({
    staff_key: `staff:${crypto.createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 24)}`,
    display_name: name,
    role: "sale",
    provider: "legacy_customer",
    is_active: true,
    attributes: { source: "legacy_v8_refresh" },
    first_seen_at: now,
    last_seen_at: now,
    updated_at: now,
  }));
  return {
    customers: await upsert("dim_customers", customers, "page_id,customer_id"),
    contacts: await upsert("fact_contacts", contacts, "source_contact_id"),
    staff: await upsert("dim_staff", staffRows, "staff_key"),
  };
}

async function refreshAds() {
  const [rows, current] = await Promise.all([
    fetchAll(source, "ad_mappings?select=id,ad_account_id,ad_account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,product_type,product_group,product_item_key,enabled,is_active,effective_status,mapping_mode,mapping_target_type,recognition_name,product_name,slide_key,account_status,created_at,updated_at&ad_id=not.is.null&order=updated_at.desc.nullslast", 10_000),
    fetchAll(report, "dim_ads?select=ad_id,page_id&order=ad_id.asc", 10_000),
  ]);
  const pageByAd = new Map(current.map((row) => [row.ad_id, row.page_id]));
  const best = new Map();
  for (const row of rows) if (!best.has(row.ad_id)) best.set(row.ad_id, row);
  const now = new Date().toISOString();
  return upsert("dim_ads", [...best.values()].map((row) => ({
    ad_id: row.ad_id,
    page_id: pageByAd.get(row.ad_id) || null,
    ad_account_id: row.ad_account_id,
    ad_account_name: row.ad_account_name,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    ad_name: row.ad_name,
    effective_status: row.effective_status,
    catalog_keys: catalogKeys(row),
    attributes: {
      source: "legacy_v8_refresh",
      is_active: row.is_active ?? row.enabled ?? true,
      mapping_mode: row.mapping_mode,
      mapping_target_type: row.mapping_target_type,
      recognition_name: row.recognition_name,
      product_name: row.product_name,
      slide_key: row.slide_key,
      account_status: row.account_status,
    },
    first_seen_at: row.created_at || now,
    last_seen_at: row.updated_at || row.created_at || now,
    updated_at: now,
  })), "ad_id");
}

async function refreshDaily(full) {
  const from = dateDaysAgo(full ? 365 : 14);
  const path = "v8_report_daily_runtime_detail?select=report_date,page_id,page_name,ad_account_id,ad_account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,effective_status,currency,account_timezone,spend,tax_amount,spend_with_tax,impressions,reach,clicks,meta_conversations,conversations,contacts,hot_leads,message_count,meta_leads,data_match_status,contact_rate"
    + `&report_date=gte.${from}&report_date=lte.${dateDaysAgo(-1)}&order=report_date.desc`;
  const rows = await fetchAll(source, path, 20_000);
  const now = new Date().toISOString();
  return upsert("fact_daily_ad_performance", rows.map((row) => ({
    report_date: row.report_date,
    page_id: clean(row.page_id) || "*",
    ad_account_id: clean(row.ad_account_id) || "*",
    campaign_id: clean(row.campaign_id) || "*",
    adset_id: clean(row.adset_id) || "*",
    ad_id: clean(row.ad_id) || "*",
    spend: Number(row.spend_with_tax ?? row.spend ?? 0),
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks: Number(row.clicks || 0),
    conversations: Number(row.conversations || 0),
    customers: Number(row.conversations || 0),
    contacts: Number(row.contacts || 0),
    deliveries: 0,
    metadata: {
      source: "legacy_v8_materialized",
      page_name: row.page_name,
      ad_account_name: row.ad_account_name,
      campaign_name: row.campaign_name,
      adset_name: row.adset_name,
      ad_name: row.ad_name,
      effective_status: row.effective_status,
      currency: row.currency,
      account_timezone: row.account_timezone,
      spend_before_tax: row.spend,
      tax_amount: row.tax_amount,
      meta_conversations: row.meta_conversations,
      hot_leads: row.hot_leads,
      message_count: row.message_count,
      meta_leads: row.meta_leads,
      data_match_status: row.data_match_status,
      legacy_contact_rate: row.contact_rate,
    },
    updated_at: now,
  })), "report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id");
}

async function refresh() {
  if (running || !ready()) return;
  running = true;
  const started = Date.now();
  const full = cycle === 0 || cycle % 144 === 0;
  cycle += 1;
  try {
    await heartbeat("running", { full, cycle });
    const [pages, customers, ads, daily] = await Promise.all([
      refreshPages(),
      refreshCustomers(full),
      refreshAds(),
      refreshDaily(full),
    ]);
    const details = { full, cycle, pages, ...customers, ads, daily, elapsed_ms: Date.now() - started, temporary_host: process.env.AIGUKA_V9_REPORTING_TEMPORARY_HOST === "true" };
    await heartbeat("healthy", details);
    console.log(`[${WORKER}] refreshed`, details);
  } catch (error) {
    await heartbeat("degraded", { cycle, elapsed_ms: Date.now() - started }, error instanceof Error ? error.message : String(error));
    console.error(`[${WORKER}] refresh failed:`, error);
  } finally {
    running = false;
  }
}

if (!ready()) {
  console.warn(`[${WORKER}] disabled: source/reporting credentials missing`);
} else {
  void refresh();
  setInterval(() => void refresh(), INTERVAL_MS).unref();
}

export const __private__ = { hashContact, catalogKeys, clean };
