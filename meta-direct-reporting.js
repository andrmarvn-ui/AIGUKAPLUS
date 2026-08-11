const DEFAULT_GRAPH_VERSION = "v23.0";
const CACHE_TTL_MS = 60_000;
const MAX_PAGES = 120;

const clean = (value) => String(value ?? "").trim();
const num = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const integer = (value) => Math.max(0, Math.round(num(value)));
const normalizeAccountId = (value) => clean(value).replace(/^act_/, "");
const today = () => new Date().toISOString().slice(0, 10);

function actionValue(actions, names) {
  const wanted = new Set(names);
  return integer((Array.isArray(actions) ? actions : []).reduce((sum, item) => {
    return wanted.has(clean(item?.action_type)) ? sum + num(item?.value) : sum;
  }, 0));
}

function preferredActionValue(actions, names) {
  for (const name of names) {
    const value = actionValue(actions, [name]);
    if (value > 0) return value;
  }
  return 0;
}

function paymentLast4(details) {
  const display = clean(details?.display_string || details?.displayString || details?.name);
  const matches = display.match(/(\d{4})(?!.*\d)/);
  return matches?.[1] || null;
}

function accountCacheKey(accountIds, from, to) {
  return `${[...accountIds].sort().join(",")}|${from}|${to}`;
}

async function fetchJson(url, token, timeoutMs = 50_000) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 1000) }; }
  if (!response.ok || data?.error) {
    const error = data?.error || {};
    const message = error.message || data?.message || `HTTP_${response.status}`;
    const err = new Error(`META_${error.code || response.status}:${error.error_subcode || ""}:${message}`);
    err.status = response.status;
    err.meta = error;
    throw err;
  }
  return data;
}

async function graphPaged(url, token) {
  const rows = [];
  let next = url;
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    const data = await fetchJson(next, token);
    rows.push(...(Array.isArray(data?.data) ? data.data : []));
    next = clean(data?.paging?.next) || null;
  }
  return rows;
}

async function accountMetadata(accountId, token, graphVersion) {
  const basic = ["id", "name", "currency", "timezone_name", "account_status", "amount_spent", "balance", "spend_cap"];
  const extended = [...basic, "funding_source_details"];
  const makeUrl = (fields) => {
    const params = new URLSearchParams({ fields: fields.join(",") });
    return `https://graph.facebook.com/${graphVersion}/act_${accountId}?${params}`;
  };
  try {
    return await fetchJson(makeUrl(extended), token, 30_000);
  } catch (error) {
    return { ...(await fetchJson(makeUrl(basic), token, 30_000)), funding_source_details: null, funding_source_error: error.message };
  }
}

async function accountInsights(accountId, from, to, token, graphVersion) {
  const fields = [
    "date_start", "date_stop", "account_id", "account_name", "campaign_id", "campaign_name",
    "adset_id", "adset_name", "ad_id", "ad_name", "spend", "impressions", "reach", "clicks", "actions",
  ];
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since: from, until: to }),
    fields: fields.join(","),
    limit: "500",
  });
  return graphPaged(`https://graph.facebook.com/${graphVersion}/act_${accountId}/insights?${params}`, token);
}

function buildLookup(filters = {}, fallbackRows = []) {
  const ads = Array.isArray(filters?.ads) ? filters.ads : [];
  const accounts = Array.isArray(filters?.ad_accounts) ? filters.ad_accounts : [];
  const pages = Array.isArray(filters?.pages) ? filters.pages : [];
  const adMap = new Map();
  for (const item of [...ads, ...fallbackRows]) {
    const adId = clean(item?.ad_id);
    if (!adId) continue;
    const current = adMap.get(adId) || {};
    adMap.set(adId, { ...current, ...item });
  }
  const accountMap = new Map(accounts.map((item) => [normalizeAccountId(item.ad_account_id), item]));
  const pageMap = new Map(pages.map((item) => [clean(item.page_id), item]));
  const pagesByAccount = new Map();
  for (const item of fallbackRows) {
    const accountId = normalizeAccountId(item?.ad_account_id);
    const pageId = clean(item?.page_id);
    if (!accountId || !pageId) continue;
    const set = pagesByAccount.get(accountId) || new Set();
    set.add(pageId);
    pagesByAccount.set(accountId, set);
  }
  return { adMap, accountMap, pageMap, pagesByAccount };
}

function normalizeInsight(item, meta, lookup) {
  const adId = clean(item.ad_id);
  const accountId = normalizeAccountId(item.account_id || meta.id);
  const knownAd = lookup.adMap.get(adId) || {};
  const possiblePages = lookup.pagesByAccount.get(accountId) || new Set();
  const pageId = clean(knownAd.page_id) || (possiblePages.size === 1 ? [...possiblePages][0] : null);
  const pageName = clean(knownAd.page_name) || clean(lookup.pageMap.get(pageId)?.page_name) || null;
  const spend = num(item.spend);
  const taxAmount = Math.round(spend * 0.05 * 100) / 100;
  const actions = Array.isArray(item.actions) ? item.actions : [];
  return {
    report_date: clean(item.date_start),
    page_id: pageId,
    page_name: pageName,
    ad_account_id: accountId,
    ad_account_name: clean(item.account_name) || clean(meta.name) || clean(lookup.accountMap.get(accountId)?.ad_account_name) || accountId,
    campaign_id: clean(item.campaign_id) || null,
    campaign_name: clean(item.campaign_name) || null,
    adset_id: clean(item.adset_id) || null,
    adset_name: clean(item.adset_name) || null,
    ad_id: adId || null,
    ad_name: clean(item.ad_name) || clean(knownAd.ad_name) || null,
    effective_status: clean(knownAd.effective_status) || null,
    currency: clean(meta.currency) || clean(lookup.accountMap.get(accountId)?.currency) || "VND",
    account_timezone: clean(meta.timezone_name) || clean(lookup.accountMap.get(accountId)?.timezone_name) || "Asia/Ho_Chi_Minh",
    payment_method_last4: paymentLast4(meta.funding_source_details),
    funding_source_display: clean(meta.funding_source_details?.display_string) || null,
    account_balance: num(meta.balance),
    account_amount_spent: num(meta.amount_spent),
    account_spend_cap: num(meta.spend_cap),
    spend,
    tax_amount: taxAmount,
    spend_with_tax: Math.round((spend + taxAmount) * 100) / 100,
    impressions: integer(item.impressions),
    reach: integer(item.reach),
    clicks: integer(item.clicks),
    link_clicks: actionValue(actions, ["link_click"]),
    meta_conversations: preferredActionValue(actions, [
      "onsite_conversion.messaging_conversation_started_7d",
      "messaging_conversation_started_7d",
      "onsite_conversion.messaging_first_reply",
    ]),
    meta_leads: actionValue(actions, ["lead", "onsite_conversion.lead_grouped", "onsite_conversion.lead"]),
    data_source: "meta_live",
  };
}

function matches(row, query = {}) {
  const eq = (name, value) => !clean(query[name]) || clean(value) === clean(query[name]).replace(/^act_/, "");
  if (!eq("page_id", row.page_id)) return false;
  if (!eq("ad_account_id", row.ad_account_id)) return false;
  if (!eq("campaign_id", row.campaign_id)) return false;
  if (!eq("adset_id", row.adset_id)) return false;
  if (!eq("ad_id", row.ad_id)) return false;
  const search = clean(query.search).toLowerCase();
  if (search) {
    const haystack = [row.ad_account_name, row.campaign_name, row.adset_name, row.ad_name, row.ad_id, row.page_name].join(" ").toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

function mergeCustomerMetrics(directRows, fallbackRows) {
  const customerByAd = new Map();
  for (const row of fallbackRows || []) {
    const key = clean(row.ad_id);
    if (!key) continue;
    customerByAd.set(key, row);
  }
  return directRows.map((row) => {
    const fallback = customerByAd.get(clean(row.ad_id)) || {};
    const conversations = integer(fallback.conversations);
    const contacts = integer(fallback.contacts);
    const spendWithTax = num(row.spend_with_tax);
    return {
      ...fallback,
      ...row,
      page_id: row.page_id || fallback.page_id || null,
      page_name: row.page_name || fallback.page_name || null,
      effective_status: row.effective_status || fallback.effective_status || fallback.ad_status || null,
      conversations,
      contacts,
      scanned_contacts: integer(fallback.scanned_contacts),
      hot_leads: integer(fallback.hot_leads),
      message_count: integer(fallback.message_count),
      contact_rate: conversations ? Math.round((contacts / conversations) * 10_000) / 100 : 0,
      cost_per_conversation: conversations ? Math.round((spendWithTax / conversations) * 100) / 100 : 0,
      cost_per_contact: contacts ? Math.round((spendWithTax / contacts) * 100) / 100 : 0,
      data_match_status: fallback.ad_id ? "matched_live_meta" : "meta_live_only",
    };
  });
}

function aggregateAds(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = clean(row.ad_id) || [row.ad_account_id, row.campaign_id, row.adset_id, row.ad_name].join(":");
    const current = groups.get(key) || { ...row, spend: 0, tax_amount: 0, spend_with_tax: 0, impressions: 0, reach: 0, clicks: 0, link_clicks: 0, meta_conversations: 0, meta_leads: 0 };
    for (const field of ["spend", "tax_amount", "spend_with_tax", "impressions", "reach", "clicks", "link_clicks", "meta_conversations", "meta_leads"]) current[field] += num(row[field]);
    groups.set(key, current);
  }
  return [...groups.values()];
}

function aggregateDaily(rows, fallbackDaily = []) {
  const fallbackMap = new Map();
  for (const row of fallbackDaily || []) {
    const key = [clean(row.report_date), normalizeAccountId(row.ad_account_id), clean(row.page_id)].join("|");
    fallbackMap.set(key, row);
  }
  const groups = new Map();
  for (const row of rows) {
    const key = [clean(row.report_date), normalizeAccountId(row.ad_account_id), clean(row.page_id)].join("|");
    const current = groups.get(key) || { ...row, spend: 0, tax_amount: 0, spend_with_tax: 0, impressions: 0, reach: 0, clicks: 0, link_clicks: 0, meta_conversations: 0, meta_leads: 0 };
    for (const field of ["spend", "tax_amount", "spend_with_tax", "impressions", "reach", "clicks", "link_clicks", "meta_conversations", "meta_leads"]) current[field] += num(row[field]);
    groups.set(key, current);
  }
  const result = [];
  for (const [key, row] of groups) {
    const fallback = fallbackMap.get(key) || {};
    const conversations = integer(fallback.conversations);
    const contacts = integer(fallback.contacts);
    result.push({
      ...fallback,
      ...row,
      conversations,
      contacts,
      scanned_contacts: integer(fallback.scanned_contacts),
      hot_leads: integer(fallback.hot_leads),
      message_count: integer(fallback.message_count),
      contact_rate: conversations ? Math.round((contacts / conversations) * 10_000) / 100 : 0,
      cost_per_conversation: conversations ? Math.round((num(row.spend_with_tax) / conversations) * 100) / 100 : 0,
      cost_per_contact: contacts ? Math.round((num(row.spend_with_tax) / contacts) * 100) / 100 : 0,
      data_status: fallback.report_date ? "Meta trực tiếp + khách đối chiếu" : "Meta trực tiếp; chưa có khách đối chiếu",
      has_ads_data: true,
      has_runtime_data: Boolean(fallback.report_date),
    });
    fallbackMap.delete(key);
  }
  for (const fallback of fallbackMap.values()) result.push(fallback);
  return result;
}

export function createMetaDirectReporting(options = {}) {
  const graphVersion = clean(options.graphVersion || process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).replace(/^\/?/, "");
  const cache = new Map();

  const token = () => clean(options.token || process.env.META_ACCESS_TOKEN);
  const ready = () => Boolean(token());

  async function liveRows({ from, to, accountIds, filters, fallbackRows = [] }) {
    if (!ready()) throw new Error("META_ACCESS_TOKEN_MISSING");
    const normalizedIds = [...new Set((accountIds || []).map(normalizeAccountId).filter(Boolean))];
    if (!normalizedIds.length) return { rows: [], accounts: [], warnings: ["NO_AD_ACCOUNTS"] };
    const safeFrom = clean(from) || today();
    const safeTo = clean(to) || safeFrom;
    const key = accountCacheKey(normalizedIds, safeFrom, safeTo);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const lookup = buildLookup(filters, fallbackRows);
    const rows = [];
    const accounts = [];
    const warnings = [];
    for (const accountId of normalizedIds) {
      try {
        const [meta, insights] = await Promise.all([
          accountMetadata(accountId, token(), graphVersion),
          accountInsights(accountId, safeFrom, safeTo, token(), graphVersion),
        ]);
        accounts.push({
          ad_account_id: accountId,
          ad_account_name: clean(meta.name) || clean(lookup.accountMap.get(accountId)?.ad_account_name) || accountId,
          currency: clean(meta.currency) || "VND",
          timezone_name: clean(meta.timezone_name) || "Asia/Ho_Chi_Minh",
          account_status: meta.account_status ?? null,
          payment_method_last4: paymentLast4(meta.funding_source_details),
          funding_source_display: clean(meta.funding_source_details?.display_string) || null,
          balance: num(meta.balance),
          amount_spent: num(meta.amount_spent),
          spend_cap: num(meta.spend_cap),
          source: "meta_live",
        });
        rows.push(...insights.map((item) => normalizeInsight(item, meta, lookup)));
      } catch (error) {
        warnings.push({ ad_account_id: accountId, error: error.message });
      }
    }
    if (!rows.length && warnings.length === normalizedIds.length) {
      const err = new Error("META_LIVE_ALL_ACCOUNTS_FAILED");
      err.details = warnings;
      throw err;
    }
    const value = { rows, accounts, warnings, source: "meta_live", range: { from: safeFrom, to: safeTo } };
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  async function ads({ from, to, accountIds, filters, fallbackRows = [], query = {} }) {
    const live = await liveRows({ from, to, accountIds, filters, fallbackRows });
    const aggregated = aggregateAds(live.rows).filter((row) => matches(row, query));
    const merged = mergeCustomerMetrics(aggregated, fallbackRows);
    merged.sort((a, b) => num(b.spend_with_tax) - num(a.spend_with_tax));
    return { ...live, rows: merged };
  }

  async function daily({ from, to, accountIds, filters, fallbackAds = [], fallbackDaily = [], query = {} }) {
    const live = await liveRows({ from, to, accountIds, filters, fallbackRows: fallbackAds });
    const filtered = live.rows.filter((row) => matches(row, query));
    const rows = aggregateDaily(filtered, fallbackDaily);
    rows.sort((a, b) => clean(b.report_date).localeCompare(clean(a.report_date)) || clean(a.ad_account_name).localeCompare(clean(b.ad_account_name), "vi"));
    return { ...live, rows };
  }

  return { ready, liveRows, ads, daily };
}

export const __private__ = {
  actionValue, paymentLast4, normalizeInsight, mergeCustomerMetrics, aggregateAds, aggregateDaily, matches,
};

// AIGUKA_V10_REPORT_CONTACT_SCAN_META_METRIC_V1
