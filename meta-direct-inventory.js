const DEFAULT_GRAPH_VERSION = "v23.0";
const CACHE_TTL_MS = 5 * 60_000;
const MAX_PAGES = 100;

const clean = (value) => String(value ?? "").trim();
const normalizeAccountId = (value) => clean(value).replace(/^act_/, "");

async function fetchJson(url, token, timeoutMs = 40_000) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 800) }; }
  if (!response.ok || data?.error) {
    const error = data?.error || {};
    throw new Error(`META_${error.code || response.status}:${error.error_subcode || ""}:${error.message || data?.message || "request_failed"}`);
  }
  return data;
}

async function paged(url, token) {
  const rows = [];
  let next = url;
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    const payload = await fetchJson(next, token);
    rows.push(...(Array.isArray(payload?.data) ? payload.data : []));
    next = clean(payload?.paging?.next) || null;
  }
  return rows;
}

function resourceUrl(graphVersion, accountId, resource, fields) {
  const params = new URLSearchParams({ fields: fields.join(","), limit: "500" });
  return `https://graph.facebook.com/${graphVersion}/act_${normalizeAccountId(accountId)}/${resource}?${params}`;
}

function mappingLookup(staticFilters = {}) {
  const map = new Map();
  for (const row of Array.isArray(staticFilters.ads) ? staticFilters.ads : []) {
    const id = clean(row?.ad_id);
    if (id) map.set(id, row);
  }
  return map;
}

function accountLookup(staticFilters = {}) {
  return new Map((Array.isArray(staticFilters.ad_accounts) ? staticFilters.ad_accounts : [])
    .map((row) => [normalizeAccountId(row?.ad_account_id), row]));
}

function normalizeInventory({ accountId, campaigns, adsets, ads, staticFilters }) {
  const campaignMap = new Map(campaigns.map((row) => [clean(row.id), row]));
  const adsetMap = new Map(adsets.map((row) => [clean(row.id), row]));
  const mappings = mappingLookup(staticFilters);
  const accounts = accountLookup(staticFilters);
  const configuredAccount = accounts.get(normalizeAccountId(accountId)) || {};

  return ads.map((ad) => {
    const mapping = mappings.get(clean(ad.id)) || {};
    const adset = adsetMap.get(clean(ad.adset_id || mapping.adset_id)) || {};
    const campaignId = clean(ad.campaign_id || adset.campaign_id || mapping.campaign_id);
    const campaign = campaignMap.get(campaignId) || {};
    return {
      ...mapping,
      ad_account_id: normalizeAccountId(accountId),
      ad_account_name: clean(configuredAccount.ad_account_name) || normalizeAccountId(accountId),
      campaign_id: campaignId || null,
      campaign_name: clean(campaign.name || mapping.campaign_name) || null,
      campaign_status: clean(campaign.status) || null,
      campaign_effective_status: clean(campaign.effective_status) || null,
      adset_id: clean(ad.adset_id || mapping.adset_id) || null,
      adset_name: clean(adset.name || mapping.adset_name) || null,
      adset_status: clean(adset.status) || null,
      adset_effective_status: clean(adset.effective_status) || null,
      ad_id: clean(ad.id),
      ad_name: clean(ad.name || mapping.ad_name) || clean(ad.id),
      ad_status: clean(ad.status) || null,
      effective_status: clean(ad.effective_status || mapping.effective_status) || null,
      page_id: clean(mapping.page_id) || null,
      page_name: clean(mapping.page_name) || null,
      inventory_source: "meta_live_inventory",
    };
  });
}

function mergeHistoricalMappings(staticFilters, liveAds) {
  const merged = new Map();
  for (const row of Array.isArray(staticFilters.ads) ? staticFilters.ads : []) {
    const id = clean(row?.ad_id);
    if (!id) continue;
    merged.set(id, { ...row, inventory_source: "static_mapping_history" });
  }
  for (const row of liveAds) {
    const id = clean(row?.ad_id);
    if (id) merged.set(id, row);
  }
  return [...merged.values()];
}

export function createMetaDirectInventory(options = {}) {
  const graphVersion = clean(options.graphVersion || process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).replace(/^\/?/, "");
  const cache = new Map();
  const token = () => clean(options.token || process.env.META_ACCESS_TOKEN);
  const ready = () => Boolean(token());

  async function accountInventory(accountId, staticFilters) {
    const normalized = normalizeAccountId(accountId);
    const key = `${normalized}|${JSON.stringify((staticFilters.ads || []).map((row) => row.ad_id).sort())}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const [campaigns, adsets, ads] = await Promise.all([
      paged(resourceUrl(graphVersion, normalized, "campaigns", ["id", "name", "status", "effective_status"]), token()),
      paged(resourceUrl(graphVersion, normalized, "adsets", ["id", "name", "status", "effective_status", "campaign_id"]), token()),
      paged(resourceUrl(graphVersion, normalized, "ads", ["id", "name", "status", "effective_status", "campaign_id", "adset_id"]), token()),
    ]);
    const value = normalizeInventory({ accountId: normalized, campaigns, adsets, ads, staticFilters });
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  async function filters(staticFilters = {}) {
    if (!ready()) throw new Error("META_ACCESS_TOKEN_MISSING");
    const accountIds = [...new Set((staticFilters.ad_accounts || [])
      .map((row) => normalizeAccountId(row.ad_account_id))
      .filter(Boolean))];
    const warnings = [];
    const liveAds = [];
    for (const accountId of accountIds) {
      try { liveAds.push(...await accountInventory(accountId, staticFilters)); }
      catch (error) { warnings.push({ ad_account_id: accountId, error: error.message }); }
    }
    if (!liveAds.length && warnings.length === accountIds.length && accountIds.length) {
      const error = new Error("META_INVENTORY_ALL_ACCOUNTS_FAILED");
      error.details = warnings;
      throw error;
    }
    return {
      ok: true,
      data: {
        pages: staticFilters.pages || [],
        ad_accounts: staticFilters.ad_accounts || [],
        ads: mergeHistoricalMappings(staticFilters, liveAds),
      },
      warnings,
      source: "meta_live_inventory_plus_static_mapping",
    };
  }

  return { ready, filters, accountInventory };
}

export const __private__ = { normalizeInventory, normalizeAccountId, resourceUrl, mergeHistoricalMappings };
