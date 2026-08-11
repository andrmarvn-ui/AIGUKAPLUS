const clean = (value) => String(value ?? "").trim();
const normalizeAccountId = (value) => clean(value).replace(/^act_/, "");
const number = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function rpc(base, key, name, args = {}, timeoutMs = 45_000) {
  if (!base || !key) throw new Error(`RPC_NOT_CONFIGURED:${name}`);
  const response = await fetch(`${String(base).replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-aiguka-railway-test": "enabled",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 600) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `RPC_HTTP_${response.status}:${name}`);
  return data;
}

function queryValue(query, name) {
  const value = clean(query?.[name]);
  return value || null;
}

function adMap(filters = {}) {
  return new Map((Array.isArray(filters.ads) ? filters.ads : [])
    .filter((row) => clean(row?.ad_id))
    .map((row) => [clean(row.ad_id), row]));
}

function pageMap(filters = {}) {
  return new Map((Array.isArray(filters.pages) ? filters.pages : [])
    .filter((row) => clean(row?.page_id))
    .map((row) => [clean(row.page_id), row]));
}

function accountMap(filters = {}) {
  return new Map((Array.isArray(filters.ad_accounts) ? filters.ad_accounts : [])
    .filter((row) => clean(row?.ad_account_id))
    .map((row) => [normalizeAccountId(row.ad_account_id), row]));
}

function matchesMetric(row, query = {}) {
  const equals = (name, value) => !queryValue(query, name) || clean(value) === clean(queryValue(query, name)).replace(/^act_/, "");
  if (!equals("page_id", row.page_id)) return false;
  if (!equals("ad_account_id", row.ad_account_id)) return false;
  if (!equals("campaign_id", row.campaign_id)) return false;
  if (!equals("adset_id", row.adset_id)) return false;
  if (!equals("ad_id", row.ad_id)) return false;
  return true;
}

function attachDimensions(rows, filters = {}, query = {}) {
  const ads = adMap(filters);
  const pages = pageMap(filters);
  const accounts = accountMap(filters);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const mapping = ads.get(clean(row.ad_id)) || {};
    const accountId = normalizeAccountId(mapping.ad_account_id);
    const account = accounts.get(accountId) || {};
    const pageId = clean(row.page_id || mapping.page_id);
    const page = pages.get(pageId) || {};
    return {
      ...mapping,
      ...row,
      page_id: pageId || null,
      page_name: clean(mapping.page_name || page.page_name) || null,
      ad_account_id: accountId || null,
      ad_account_name: clean(mapping.ad_account_name || account.ad_account_name) || null,
      campaign_id: clean(mapping.campaign_id) || null,
      campaign_name: clean(mapping.campaign_name) || null,
      adset_id: clean(mapping.adset_id) || null,
      adset_name: clean(mapping.adset_name) || null,
      ad_id: clean(row.ad_id) || null,
      ad_name: clean(mapping.ad_name) || null,
      conversations: Math.max(0, Math.round(number(row.conversations))),
      contacts: Math.max(0, Math.round(number(row.contacts))),
      scanned_contacts: Math.max(0, Math.round(number(row.scanned_contacts))),
      hot_leads: Math.max(0, Math.round(number(row.hot_leads))),
      message_count: Math.max(0, Math.round(number(row.message_count))),
      customer_metric_source: "v10_core_live",
    };
  }).filter((row) => matchesMetric(row, query));
}

function aggregateByAd(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!clean(row.ad_id)) continue;
    const current = groups.get(row.ad_id) || {
      ...row,
      conversations: 0,
      contacts: 0,
      scanned_contacts: 0,
      hot_leads: 0,
      message_count: 0,
    };
    for (const key of ["conversations", "contacts", "scanned_contacts", "hot_leads", "message_count"]) current[key] += number(row[key]);
    groups.set(row.ad_id, current);
  }
  return [...groups.values()];
}

function aggregateDaily(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [clean(row.report_date), normalizeAccountId(row.ad_account_id), clean(row.page_id)].join("|");
    const current = groups.get(key) || {
      ...row,
      conversations: 0,
      contacts: 0,
      scanned_contacts: 0,
      hot_leads: 0,
      message_count: 0,
    };
    for (const field of ["conversations", "contacts", "scanned_contacts", "hot_leads", "message_count"]) current[field] += number(row[field]);
    groups.set(key, current);
  }
  return [...groups.values()];
}

export function createV10ReportSources(options = {}) {
  const reportingBase = clean(options.reportingBase || process.env.AIGUKA_V9_REPORTING_URL || process.env.SUPABASE_URL);
  const reportingKey = clean(options.reportingKey || process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || options.publishableKey);
  const coreBase = clean(options.coreBase || process.env.AIGUKA_V9_CORE_URL);
  const coreKey = clean(options.coreKey || process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY);

  async function staticFilters() {
    try {
      const result = await rpc(reportingBase, reportingKey, "v10_report_filter_registry");
      return {
        ok: true,
        data: result?.data || {},
        source: result?.source || "v10_static_registry_and_mapping",
        warnings: [],
      };
    } catch (error) {
      const fallback = await rpc(reportingBase, reportingKey, "v8_report_filters_test");
      return {
        ok: true,
        data: fallback?.data || {},
        source: "legacy_filter_registry_fallback",
        warnings: [`V10_FILTER_REGISTRY:${error.message}`],
      };
    }
  }

  async function customerMetrics(query = {}, filters = {}) {
    const result = await rpc(coreBase, coreKey, "v10_report_customer_metrics", {
      p_from: queryValue(query, "from"),
      p_to: queryValue(query, "to"),
      p_page_id: queryValue(query, "page_id"),
      p_ad_id: queryValue(query, "ad_id"),
    }, 20_000);
    const rows = attachDimensions(result?.data || [], filters, query);
    return {
      ok: true,
      rows,
      ads: aggregateByAd(rows),
      daily: aggregateDaily(rows),
      source: result?.source || "v10_core_live_customer_metrics",
      range: result?.range || null,
    };
  }

  return { staticFilters, customerMetrics, rpc };
}

export const __private__ = { attachDimensions, aggregateByAd, aggregateDaily, matchesMetric };

// AIGUKA_V10_REPORT_CONTACT_SCAN_META_METRIC_V1
