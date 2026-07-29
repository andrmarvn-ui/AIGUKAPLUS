const SOURCE_BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const SOURCE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const REPORT_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || SOURCE_BASE).replace(/\/$/, "");
const REPORT_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || SOURCE_KEY);
const META_TOKEN = String(process.env.META_ACCESS_TOKEN || "");
const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v23.0").replace(/^\/?/, "");
const INTERVAL_MS = Math.max(30 * 60_000, Number(process.env.AIGUKA_V9_META_PAGE_RESOLVE_MS || 30 * 60_000));
const DAYS = Math.max(7, Math.min(93, Number(process.env.AIGUKA_V9_META_PAGE_RESOLVE_DAYS || 31)));
const WORKER = "aiguka-v9-meta-ad-page-resolver";
const VERSION = "1.0.0";
let running = false;
let timer;

const nowIso = () => new Date().toISOString();
const dateDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const clean = (value) => String(value ?? "").trim() || null;
const number = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const ready = () => Boolean(SOURCE_BASE && SOURCE_KEY && REPORT_BASE && REPORT_KEY && META_TOKEN);

async function db(base, key, path, options = {}) {
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
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `DB_HTTP_${response.status}`);
  return data;
}

const source = (path, options) => db(SOURCE_BASE, SOURCE_KEY, path, options);
const report = (path, options) => db(REPORT_BASE, REPORT_KEY, path, options);

async function graph(urlOrPath) {
  let url = String(urlOrPath || "");
  if (!/^https:\/\//i.test(url)) url = `https://graph.facebook.com/${GRAPH_VERSION}/${url.replace(/^\//, "")}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${META_TOKEN}` },
    signal: AbortSignal.timeout(45_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const err = data?.error || {};
    throw new Error(`META_${err.code || response.status}:${err.error_subcode || ""}:${err.message || "request_failed"}`);
  }
  return data;
}

async function fetchAll(client, path, maxRows = 20_000) {
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += 1000) {
    const page = await client(path, { headers: { Range: `${offset}-${offset + 999}` }, prefer: "count=exact", timeout: 30_000 });
    const data = Array.isArray(page) ? page : [];
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function upsert(base, key, table, rows, conflict) {
  if (!rows.length) return 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    await db(base, key, `${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: "POST",
      body: rows.slice(offset, offset + 250),
      prefer: "resolution=merge-duplicates,return=minimal",
      timeout: 45_000,
    });
  }
  return rows.length;
}

async function heartbeat(status, details = {}, error = null) {
  await upsert(REPORT_BASE, REPORT_KEY, "reporting_worker_heartbeats", [{
    worker_name: WORKER,
    worker_version: VERSION,
    status,
    details,
    last_error: error ? String(error).slice(0, 1000) : null,
    last_seen_at: nowIso(),
    updated_at: nowIso(),
  }], "worker_name").catch(() => {});
}

function storyPageId(value) {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/^(\d+)_/);
  return match ? match[1] : null;
}

export function resolveCreativePage(creative, knownPages, fallback = null) {
  const candidates = [
    clean(creative?.actor_id),
    storyPageId(creative?.effective_object_story_id),
    storyPageId(creative?.object_story_id),
  ].filter(Boolean);
  for (const candidate of candidates) if (knownPages.has(candidate)) return candidate;
  return fallback && knownPages.has(fallback) ? fallback : null;
}

async function configuration() {
  const [pages, links, accounts, currentAds] = await Promise.all([
    source("v8_pages?select=page_id,page_name&is_active=eq.true&page_id=not.is.null&limit=500"),
    source("v8_meta_page_ad_accounts?select=page_id,ad_account_id,is_primary,purpose&order=page_id.asc,ad_account_id.asc"),
    source("v8_meta_ad_accounts?select=ad_account_id,ad_account_name&reporting_enabled=eq.true&is_active=eq.true&limit=500"),
    report("dim_ads?select=ad_id,page_id,catalog_keys,attributes,first_seen_at&limit=10000"),
  ]);
  const knownPages = new Set((pages || []).map((row) => clean(row.page_id)).filter(Boolean));
  const pagesByAccount = new Map();
  for (const row of links || []) {
    const accountId = clean(row.ad_account_id);
    const pageId = clean(row.page_id);
    if (!accountId || !pageId || !knownPages.has(pageId)) continue;
    const values = pagesByAccount.get(accountId) || new Set();
    values.add(pageId);
    pagesByAccount.set(accountId, values);
  }
  const linkedAccounts = new Set(pagesByAccount.keys());
  const accountRows = (accounts || []).filter((row) => linkedAccounts.has(clean(row.ad_account_id)));
  const currentByAd = new Map((currentAds || []).map((row) => [row.ad_id, row]));
  return { knownPages, pagesByAccount, accounts: accountRows, currentByAd };
}

async function accountAds(accountId) {
  const fields = "id,name,effective_status,campaign{id,name},adset{id,name},creative{id,actor_id,effective_object_story_id,object_story_id}";
  const params = new URLSearchParams({ fields, limit: "500" });
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/act_${accountId}/ads?${params}`;
  const rows = [];
  for (let page = 0; url && page < 100; page += 1) {
    const data = await graph(url);
    rows.push(...(Array.isArray(data?.data) ? data.data : []));
    url = clean(data?.paging?.next);
  }
  return rows;
}

async function resolveAds(config) {
  const now = nowIso();
  const resolved = [];
  const unresolved = [];
  for (const account of config.accounts) {
    const accountId = clean(account.ad_account_id);
    const mappedPages = [...(config.pagesByAccount.get(accountId) || [])];
    const onlyMappedPage = mappedPages.length === 1 ? mappedPages[0] : null;
    let ads;
    try {
      ads = await accountAds(accountId);
    } catch (error) {
      unresolved.push({ account_id: accountId, error: String(error.message || error).slice(0, 500) });
      continue;
    }
    for (const ad of ads) {
      const adId = clean(ad.id);
      if (!adId) continue;
      const existing = config.currentByAd.get(adId) || {};
      const pageId = resolveCreativePage(ad.creative || {}, config.knownPages, clean(existing.page_id) || onlyMappedPage);
      const row = {
        ad_id: adId,
        page_id: pageId,
        ad_account_id: accountId,
        ad_account_name: clean(account.ad_account_name) || accountId,
        campaign_id: clean(ad.campaign?.id),
        campaign_name: clean(ad.campaign?.name),
        adset_id: clean(ad.adset?.id),
        adset_name: clean(ad.adset?.name),
        ad_name: clean(ad.name),
        effective_status: clean(ad.effective_status),
        last_seen_at: now,
        updated_at: now,
      };
      if (!existing.first_seen_at) row.first_seen_at = now;
      if (!existing.catalog_keys) row.catalog_keys = [];
      if (!existing.attributes) row.attributes = { source: "meta_creative_page_resolver" };
      resolved.push(row);
      if (!pageId) unresolved.push({ account_id: accountId, ad_id: adId, ad_name: clean(ad.name) });
    }
  }
  return { resolved, unresolved };
}

async function patchInsightPages(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.page_id) continue;
    const list = groups.get(row.page_id) || [];
    list.push(row.ad_id);
    groups.set(row.page_id, list);
  }
  let patched = 0;
  for (const [pageId, ids] of groups.entries()) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100).join(",");
      await source(`v8_ads_daily_insights?ad_id=in.(${encodeURIComponent(batch)})`, {
        method: "PATCH",
        body: { page_id: pageId, updated_at: nowIso() },
        prefer: "return=minimal",
        timeout: 30_000,
      });
      patched += batch.length;
    }
  }
  return patched;
}

async function refreshV21(days) {
  const results = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const reportDate = dateDaysAgo(offset);
    try {
      const data = await source("rpc/v8_report_v21_refresh_day", {
        method: "POST",
        body: { p_report_date: reportDate, p_page_id: null },
        timeout: 30_000,
      });
      results.push({ report_date: reportDate, ok: true, ad_days: data?.ad_days ?? null });
    } catch (error) {
      results.push({ report_date: reportDate, ok: false, error: String(error.message || error).slice(0, 300) });
    }
  }
  return results;
}

async function syncReportingFacts(days) {
  const since = dateDaysAgo(days - 1);
  const rows = await fetchAll(source,
    `v8_report_v21_ad_day_fact?select=report_date,page_id,page_name,ad_account_id,ad_account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,effective_status,currency,account_timezone,payment_method_last4,spend,tax_amount,spend_with_tax,impressions,reach,clicks,link_clicks,meta_conversations,meta_leads,conversations,customers,contacts,hot_leads,message_count,data_match_status,latest_source_at,fact_version,refreshed_at&report_date=gte.${since}&report_date=lte.${dateDaysAgo(0)}&order=report_date.desc`,
    20_000,
  );
  const now = nowIso();
  const payload = (rows || []).filter((row) => !String(row.page_id || "").startsWith("__")).map((row) => ({
    report_date: row.report_date,
    page_id: clean(row.page_id) || "*",
    ad_account_id: clean(row.ad_account_id) || "*",
    campaign_id: clean(row.campaign_id) || "*",
    adset_id: clean(row.adset_id) || "*",
    ad_id: clean(row.ad_id) || "*",
    spend: number(row.spend_with_tax ?? row.spend),
    impressions: number(row.impressions),
    reach: number(row.reach),
    clicks: number(row.clicks),
    conversations: number(row.conversations),
    customers: number(row.customers ?? row.conversations),
    contacts: number(row.contacts),
    deliveries: 0,
    metadata: {
      source: "v8_report_v21_ad_day_fact",
      page_name: row.page_name,
      ad_account_name: row.ad_account_name,
      campaign_name: row.campaign_name,
      adset_name: row.adset_name,
      ad_name: row.ad_name,
      effective_status: row.effective_status,
      currency: row.currency || "VND",
      account_timezone: row.account_timezone,
      payment_method_last4: row.payment_method_last4,
      spend_before_tax: row.spend,
      tax_amount: row.tax_amount,
      link_clicks: row.link_clicks,
      meta_conversations: row.meta_conversations,
      hot_leads: row.hot_leads,
      message_count: row.message_count,
      meta_leads: row.meta_leads,
      data_match_status: row.data_match_status,
      source_refreshed_at: row.refreshed_at,
      latest_source_at: row.latest_source_at,
      fact_version: row.fact_version,
    },
    updated_at: now,
  }));
  return upsert(REPORT_BASE, REPORT_KEY, "fact_daily_ad_performance", payload, "report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id");
}

async function run() {
  if (!ready() || running) return;
  running = true;
  const started = Date.now();
  const details = { graph_version: GRAPH_VERSION, days: DAYS, resolved_ads: 0, page_resolved: 0, unresolved: 0 };
  try {
    const config = await configuration();
    const result = await resolveAds(config);
    details.resolved_ads = result.resolved.length;
    details.page_resolved = result.resolved.filter((row) => row.page_id).length;
    details.unresolved = result.unresolved.length;
    details.accounts = config.accounts.map((row) => row.ad_account_id);
    await upsert(REPORT_BASE, REPORT_KEY, "dim_ads", result.resolved, "ad_id");
    details.insight_rows_patched = await patchInsightPages(result.resolved);
    const facts = await refreshV21(DAYS);
    details.fact_days = facts.length;
    details.fact_days_failed = facts.filter((row) => !row.ok).length;
    details.reporting_rows_written = await syncReportingFacts(DAYS);
    details.elapsed_ms = Date.now() - started;
    const status = details.fact_days_failed || details.unresolved ? "degraded" : "healthy";
    await heartbeat(status, details, status === "healthy" ? null : `${details.unresolved} unresolved ad(s); ${details.fact_days_failed} fact day(s) failed`);
  } catch (error) {
    details.elapsed_ms = Date.now() - started;
    await heartbeat("degraded", details, error.message || error);
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => run().catch(() => {}), INTERVAL_MS);
    timer.unref?.();
  }
}

if (!ready()) {
  console.warn(`[${WORKER}] disabled: source/reporting database or Meta OAuth token missing`);
} else {
  console.log(`[${WORKER}] started; creative actor Page resolution for mapped accounts only`);
  run().catch(() => {});
}

export const __private__ = { storyPageId, resolveCreativePage };
