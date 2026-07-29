const SOURCE_BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const SOURCE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const REPORT_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || SOURCE_BASE).replace(/\/$/, "");
const REPORT_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || SOURCE_KEY);
const META_TOKEN = String(process.env.META_ACCESS_TOKEN || "");
const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v23.0").replace(/^\/?/, "");
const INTERVAL_MS = Math.max(6 * 60 * 60_000, Number(process.env.AIGUKA_V9_META_ORPHAN_RESOLVE_MS || 6 * 60 * 60_000));
const DAYS = Math.max(31, Math.min(366, Number(process.env.AIGUKA_V9_META_ORPHAN_RESOLVE_DAYS || 93)));
const WORKER = "aiguka-v9-meta-orphan-ad-resolver";
const VERSION = "1.0.0";
let running = false;
let timer;

const clean = (value) => String(value ?? "").trim() || null;
const nowIso = () => new Date().toISOString();
const dateDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
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

async function graph(adId) {
  const fields = "id,name,effective_status,account_id,campaign{id,name},adset{id,name},creative{id,actor_id,effective_object_story_id,object_story_id}";
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${adId}?${new URLSearchParams({ fields })}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${META_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
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

async function heartbeat(status, details, error = null) {
  await report("reporting_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    body: [{
      worker_name: WORKER,
      worker_version: VERSION,
      status,
      details,
      last_error: error ? String(error).slice(0, 1000) : null,
      last_seen_at: nowIso(),
      updated_at: nowIso(),
    }],
    prefer: "resolution=merge-duplicates,return=minimal",
  }).catch(() => {});
}

function storyPageId(value) {
  const match = String(value || "").match(/^(\d+)_/);
  return match ? match[1] : null;
}

export function resolveOrphanPage(creative, knownPages) {
  const candidates = [
    clean(creative?.actor_id),
    storyPageId(creative?.effective_object_story_id),
    storyPageId(creative?.object_story_id),
  ].filter(Boolean);
  return candidates.find((id) => knownPages.has(id)) || null;
}

async function unresolvedAds() {
  const since = dateDaysAgo(DAYS - 1);
  const rows = await source(`v8_ads_daily_insights?select=ad_id,ad_account_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,insight_date&page_id=is.null&insight_date=gte.${since}&order=insight_date.desc&limit=5000`);
  const map = new Map();
  for (const row of rows || []) {
    const adId = clean(row.ad_id);
    if (!adId) continue;
    const current = map.get(adId) || { ...row, dates: new Set() };
    current.dates.add(row.insight_date);
    map.set(adId, current);
  }
  return [...map.values()].map((row) => ({ ...row, dates: [...row.dates].sort() }));
}

async function knownPages() {
  const rows = await source("v8_pages?select=page_id&is_active=eq.true&page_id=not.is.null&limit=500");
  return new Set((rows || []).map((row) => clean(row.page_id)).filter(Boolean));
}

async function updateResolved(sourceRow, meta, pageId) {
  const now = nowIso();
  await source(`v8_ads_daily_insights?ad_id=eq.${encodeURIComponent(sourceRow.ad_id)}`, {
    method: "PATCH",
    body: {
      page_id: pageId,
      campaign_id: clean(meta.campaign?.id) || sourceRow.campaign_id,
      campaign_name: clean(meta.campaign?.name) || sourceRow.campaign_name,
      adset_id: clean(meta.adset?.id) || sourceRow.adset_id,
      adset_name: clean(meta.adset?.name) || sourceRow.adset_name,
      ad_name: clean(meta.name) || sourceRow.ad_name,
      effective_status: clean(meta.effective_status),
      updated_at: now,
    },
    prefer: "return=minimal",
  });
  await report("dim_ads?on_conflict=ad_id", {
    method: "POST",
    body: [{
      ad_id: sourceRow.ad_id,
      page_id: pageId,
      ad_account_id: clean(meta.account_id) || sourceRow.ad_account_id,
      campaign_id: clean(meta.campaign?.id) || sourceRow.campaign_id,
      campaign_name: clean(meta.campaign?.name) || sourceRow.campaign_name,
      adset_id: clean(meta.adset?.id) || sourceRow.adset_id,
      adset_name: clean(meta.adset?.name) || sourceRow.adset_name,
      ad_name: clean(meta.name) || sourceRow.ad_name,
      effective_status: clean(meta.effective_status),
      last_seen_at: now,
      updated_at: now,
    }],
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

async function refreshDates(dates) {
  const results = [];
  for (const date of [...new Set(dates)].sort()) {
    try {
      await source("rpc/v8_report_v21_refresh_day", {
        method: "POST",
        body: { p_report_date: date, p_page_id: null },
        timeout: 30_000,
      });
      results.push({ date, ok: true });
    } catch (error) {
      results.push({ date, ok: false, error: String(error.message || error).slice(0, 300) });
    }
  }
  return results;
}

async function run() {
  if (!ready() || running) return;
  running = true;
  const started = Date.now();
  const details = { graph_version: GRAPH_VERSION, checked: 0, resolved: 0, unresolved: [] };
  try {
    const [ads, pages] = await Promise.all([unresolvedAds(), knownPages()]);
    details.checked = ads.length;
    const dates = [];
    for (const ad of ads) {
      try {
        const meta = await graph(ad.ad_id);
        const pageId = resolveOrphanPage(meta.creative || {}, pages);
        if (!pageId) {
          details.unresolved.push({ ad_id: ad.ad_id, reason: "NO_KNOWN_PAGE_EVIDENCE" });
          continue;
        }
        await updateResolved(ad, meta, pageId);
        details.resolved += 1;
        dates.push(...ad.dates);
      } catch (error) {
        details.unresolved.push({ ad_id: ad.ad_id, reason: String(error.message || error).slice(0, 300) });
      }
    }
    const refreshed = await refreshDates(dates);
    details.fact_dates = refreshed.length;
    details.fact_failures = refreshed.filter((row) => !row.ok).length;
    details.elapsed_ms = Date.now() - started;
    const status = details.unresolved.length || details.fact_failures ? "degraded" : "healthy";
    await heartbeat(status, details, status === "healthy" ? null : `${details.unresolved.length} orphan ad(s) unresolved`);
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
  console.warn(`[${WORKER}] disabled: database or Meta OAuth token missing`);
} else {
  console.log(`[${WORKER}] started; direct lookup for Insights ads missing Page evidence`);
  run().catch(() => {});
}

export const __private__ = { storyPageId, resolveOrphanPage };
