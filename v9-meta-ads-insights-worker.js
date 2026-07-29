const SOURCE_BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const SOURCE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const REPORT_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || SOURCE_BASE).replace(/\/$/, "");
const REPORT_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || SOURCE_KEY);
const META_TOKEN = String(process.env.META_ACCESS_TOKEN || "");
const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v23.0").replace(/^\/?/, "");
const INTERVAL_MS = Math.max(10 * 60_000, Number(process.env.AIGUKA_V9_META_INSIGHTS_REFRESH_MS || 15 * 60_000));
const INITIAL_DAYS = Math.max(7, Math.min(93, Number(process.env.AIGUKA_V9_META_INSIGHTS_INITIAL_DAYS || 31)));
const INCREMENTAL_DAYS = Math.max(2, Math.min(14, Number(process.env.AIGUKA_V9_META_INSIGHTS_DAYS || 3)));
const WORKER = "aiguka-v9-meta-ads-insights";
const VERSION = "1.0.0";
let cycle = 0;
let running = false;
let timer;

const nowIso = () => new Date().toISOString();
const dateDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const clean = (value) => String(value ?? "").trim() || null;
const number = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const integer = (value) => Math.max(0, Math.round(number(value)));
const ready = () => Boolean(SOURCE_BASE && SOURCE_KEY && META_TOKEN);

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

async function upsert(table, rows, conflict, base = SOURCE_BASE, key = SOURCE_KEY) {
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
  if (!REPORT_BASE || !REPORT_KEY) return;
  await upsert("reporting_worker_heartbeats", [{
    worker_name: WORKER,
    worker_version: VERSION,
    status,
    details,
    last_error: error ? String(error).slice(0, 1000) : null,
    last_seen_at: nowIso(),
    updated_at: nowIso(),
  }], "worker_name", REPORT_BASE, REPORT_KEY).catch(() => {});
}

function actionValue(actions, names) {
  const wanted = new Set(names);
  return integer((Array.isArray(actions) ? actions : []).reduce((sum, item) => {
    return wanted.has(String(item?.action_type || "")) ? sum + number(item?.value) : sum;
  }, 0));
}

async function configuredAccounts() {
  const links = await source("v8_meta_page_ad_accounts?select=page_id,ad_account_id,is_primary,purpose&order=page_id.asc,ad_account_id.asc");
  const ids = [...new Set((links || []).map((row) => clean(row.ad_account_id)).filter(Boolean))];
  if (!ids.length) return [];
  const list = ids.map((id) => `\"${id.replaceAll('\\"', '')}\"`).join(",");
  const rows = await source(`v8_meta_ad_accounts?select=id,tenant_id,meta_app_id,meta_connection_id,ad_account_id,ad_account_name,currency,timezone_name,reporting_timezone,account_status,reporting_enabled,is_active,tax_rate,spend_includes_tax,metadata&ad_account_id=in.(${encodeURIComponent(list)})&reporting_enabled=eq.true&is_active=eq.true`);
  const pagesByAccount = new Map();
  for (const row of links || []) {
    const id = clean(row.ad_account_id);
    if (!id) continue;
    const pages = pagesByAccount.get(id) || new Set();
    if (clean(row.page_id)) pages.add(row.page_id);
    pagesByAccount.set(id, pages);
  }
  return (rows || []).map((row) => ({ ...row, mapped_pages: [...(pagesByAccount.get(row.ad_account_id) || [])] }));
}

async function loadAdPageMap() {
  const map = new Map();
  const [referrals, facts] = await Promise.all([
    source("v8_report_v21_referral_fact?select=ad_id,page_id,referral_at&ad_id=not.is.null&page_id=not.is.null&order=referral_at.desc&limit=10000").catch(() => []),
    source("v8_report_v21_ad_day_fact?select=ad_id,page_id,refreshed_at&ad_id=neq.&page_id=neq.&order=refreshed_at.desc&limit=10000").catch(() => []),
  ]);
  for (const row of [...(referrals || []), ...(facts || [])]) {
    const adId = clean(row.ad_id);
    const pageId = clean(row.page_id);
    if (adId && pageId && !map.has(adId)) map.set(adId, pageId);
  }
  return map;
}

async function loadAdStatusMap() {
  const rows = await source("ad_mappings?select=ad_id,effective_status,ad_account_name,updated_at&ad_id=not.is.null&order=updated_at.desc.nullslast&limit=10000").catch(() => []);
  const map = new Map();
  for (const row of rows || []) if (clean(row.ad_id) && !map.has(row.ad_id)) map.set(row.ad_id, row);
  return map;
}

async function accountMetadata(account) {
  const data = await graph(`act_${account.ad_account_id}?fields=id,name,currency,timezone_name,account_status`);
  return {
    name: clean(data.name) || clean(account.ad_account_name) || account.ad_account_id,
    currency: clean(data.currency) || clean(account.currency) || "VND",
    timezone: clean(data.timezone_name) || clean(account.reporting_timezone) || clean(account.timezone_name) || "Asia/Ho_Chi_Minh",
    accountStatus: data.account_status ?? account.account_status,
  };
}

async function insightRows(account, since, until) {
  const fields = [
    "date_start", "account_id", "account_name", "campaign_id", "campaign_name",
    "adset_id", "adset_name", "ad_id", "ad_name", "spend", "impressions", "reach", "clicks", "actions",
  ].join(",");
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields,
    limit: "500",
  });
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/act_${account.ad_account_id}/insights?${params}`;
  const rows = [];
  for (let page = 0; url && page < 100; page += 1) {
    const data = await graph(url);
    rows.push(...(Array.isArray(data?.data) ? data.data : []));
    url = clean(data?.paging?.next);
  }
  return rows;
}

async function syncAccount(account, since, until, pageMap, statusMap) {
  const [meta, insights] = await Promise.all([accountMetadata(account), insightRows(account, since, until)]);
  const now = nowIso();
  const taxRate = Math.max(0, number(account.tax_rate));
  const spendIncludesTax = account.spend_includes_tax !== false;
  const mappedPages = account.mapped_pages || [];
  const rows = insights.map((item) => {
    const adId = clean(item.ad_id);
    const spend = number(item.spend);
    const taxAmount = spendIncludesTax ? 0 : Math.round(spend * taxRate * 100) / 100;
    const pageId = (adId && pageMap.get(adId)) || (mappedPages.length === 1 ? mappedPages[0] : null);
    const status = adId ? statusMap.get(adId) : null;
    const actions = Array.isArray(item.actions) ? item.actions : [];
    return {
      tenant_id: account.tenant_id,
      meta_app_id: account.meta_app_id,
      meta_connection_id: account.meta_connection_id,
      page_id: pageId,
      ad_account_id: account.ad_account_id,
      insight_date: item.date_start,
      campaign_id: clean(item.campaign_id),
      campaign_name: clean(item.campaign_name),
      adset_id: clean(item.adset_id),
      adset_name: clean(item.adset_name),
      ad_id: adId,
      ad_name: clean(item.ad_name),
      effective_status: clean(status?.effective_status),
      currency: meta.currency,
      account_timezone: meta.timezone,
      spend,
      tax_amount: taxAmount,
      spend_with_tax: spendIncludesTax ? spend : Math.round((spend + taxAmount) * 100) / 100,
      impressions: integer(item.impressions),
      reach: integer(item.reach),
      clicks: integer(item.clicks),
      link_clicks: actionValue(actions, ["link_click"]),
      messaging_conversations_started: actionValue(actions, [
        "onsite_conversion.messaging_conversation_started_7d",
        "messaging_conversation_started_7d",
        "onsite_conversion.messaging_first_reply",
      ]),
      meta_leads: actionValue(actions, ["lead", "onsite_conversion.lead_grouped", "onsite_conversion.lead"]),
      raw_actions: actions,
      raw_payload: { date_start: item.date_start, account_id: item.account_id, account_name: item.account_name },
      source: "meta_ads_api_v9",
      synced_at: now,
      updated_at: now,
    };
  }).filter((row) => row.insight_date && row.ad_id);
  await upsert("v8_ads_daily_insights", rows, "ad_account_id,insight_date,ad_id");
  await source(`v8_meta_ad_accounts?ad_account_id=eq.${encodeURIComponent(account.ad_account_id)}`, {
    method: "PATCH",
    body: {
      ad_account_name: meta.name,
      currency: meta.currency,
      timezone_name: meta.timezone,
      reporting_timezone: meta.timezone,
      account_status: String(meta.accountStatus ?? "ACTIVE"),
      last_synced_at: now,
      last_verified_at: now,
      last_error: null,
      updated_at: now,
    },
    prefer: "return=minimal",
  });
  await source(`ad_mappings?ad_account_id=eq.${encodeURIComponent(account.ad_account_id)}`, {
    method: "PATCH",
    body: {
      ad_account_name: meta.name,
      account_status: String(meta.accountStatus ?? "ACTIVE"),
      updated_at: now,
    },
    prefer: "return=minimal",
  }).catch(() => {});
  return { account_id: account.ad_account_id, account_name: meta.name, rows: rows.length, spend: rows.reduce((sum, row) => sum + row.spend_with_tax, 0) };
}

async function refreshFacts(since, until) {
  const results = [];
  for (let cursor = new Date(`${since}T00:00:00Z`); cursor <= new Date(`${until}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const reportDate = cursor.toISOString().slice(0, 10);
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

async function sync() {
  if (!ready() || running) return;
  running = true;
  cycle += 1;
  const started = Date.now();
  const days = cycle === 1 ? INITIAL_DAYS : INCREMENTAL_DAYS;
  const since = dateDaysAgo(days - 1);
  const until = dateDaysAgo(0);
  const details = { cycle, since, until, graph_version: GRAPH_VERSION, accounts: [], rows: 0, spend: 0, fact_refresh_failed: 0 };
  try {
    const [accounts, pageMap, statusMap] = await Promise.all([configuredAccounts(), loadAdPageMap(), loadAdStatusMap()]);
    if (!accounts.length) throw new Error("NO_MAPPED_REPORTING_AD_ACCOUNTS");
    for (const account of accounts) {
      try {
        const result = await syncAccount(account, since, until, pageMap, statusMap);
        details.accounts.push({ ...result, ok: true });
        details.rows += result.rows;
        details.spend += result.spend;
      } catch (error) {
        details.accounts.push({ account_id: account.ad_account_id, ok: false, error: String(error.message || error).slice(0, 500) });
      }
    }
    const facts = await refreshFacts(since, until);
    details.fact_days = facts.length;
    details.fact_refresh_failed = facts.filter((row) => !row.ok).length;
    details.elapsed_ms = Date.now() - started;
    const failedAccounts = details.accounts.filter((row) => !row.ok).length;
    const status = failedAccounts || details.fact_refresh_failed ? "degraded" : "healthy";
    await heartbeat(status, details, status === "healthy" ? null : `${failedAccounts} account(s), ${details.fact_refresh_failed} fact day(s) failed`);
  } catch (error) {
    details.elapsed_ms = Date.now() - started;
    await heartbeat("degraded", details, error.message || error);
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => sync().catch(() => {}), INTERVAL_MS);
    timer.unref?.();
  }
}

if (!ready()) {
  console.warn(`[${WORKER}] disabled: source database or Meta OAuth token missing`);
} else {
  console.log(`[${WORKER}] started; mapped accounts only; initial ${INITIAL_DAYS} days, then ${INCREMENTAL_DAYS} days`);
  sync().catch(() => {});
}

export const __private__ = { actionValue, number, integer, dateDaysAgo };
