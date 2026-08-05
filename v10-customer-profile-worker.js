import { loadActiveMetaConnection } from "./meta-token-store.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v23.0").replace(/^\/?/, "");
const WORKER = "aiguka-v10-customer-profile";
const VERSION = "v10_customer_profile_v3";
const POLL_MS = Math.max(15_000, Number(process.env.AIGUKA_V10_PROFILE_POLL_MS || 20_000));
const BATCH_SIZE = Math.max(1, Math.min(15, Number(process.env.AIGUKA_V10_PROFILE_BATCH || 5)));
const RETRY_MS = Math.max(15 * 60_000, Number(process.env.AIGUKA_V10_PROFILE_RETRY_MS || 6 * 60 * 60_000));
const UNAVAILABLE_RETRY_MS = Math.max(24 * 60 * 60_000, Number(process.env.AIGUKA_V10_PROFILE_UNAVAILABLE_RETRY_MS || 7 * 24 * 60 * 60_000));

let running = false;
let timer;
let pageTokens = { expiresAt: 0, values: new Map() };
const localCooldown = new Map();

const clean = (value) => String(value ?? "").trim();
const nowIso = () => new Date().toISOString();
const configured = () => Boolean(CORE_BASE && CORE_KEY);

async function core(path, options = {}) {
  const response = await fetch(`${CORE_BASE}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: CORE_KEY,
      authorization: `Bearer ${CORE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 25_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
  return data;
}

async function graph(pathOrUrl, token, query = {}) {
  const url = /^https:\/\//i.test(String(pathOrUrl || ""))
    ? new URL(pathOrUrl)
    : new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(pathOrUrl || "").replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = data?.error || {};
    const err = new Error(`META_${error.code || response.status}:${error.error_subcode || ""}:${error.message || "request_failed"}`);
    err.code = error.code;
    throw err;
  }
  return data;
}

async function loadPageTokens(force = false) {
  if (!force && pageTokens.expiresAt > Date.now()) return pageTokens.values;
  const connection = await loadActiveMetaConnection();
  if (!connection?.accessToken) throw new Error("META_OAUTH_CONNECTION_NOT_AVAILABLE");
  const values = new Map();
  let next = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,tasks&limit=200`;
  for (let page = 0; next && page < 10; page += 1) {
    const data = await graph(next, connection.accessToken);
    for (const item of data.data || []) {
      if (item.id && item.access_token) values.set(String(item.id), { token: item.access_token, name: item.name || null });
    }
    next = clean(data?.paging?.next) || null;
  }
  pageTokens = { expiresAt: Date.now() + 5 * 60_000, values };
  return values;
}

async function tokenForPage(pageId) {
  let values = await loadPageTokens();
  let item = values.get(String(pageId));
  if (!item) {
    values = await loadPageTokens(true);
    item = values.get(String(pageId));
  }
  if (!item?.token) throw new Error(`OAUTH_PAGE_TOKEN_NOT_FOUND_${pageId}`);
  return item.token;
}

function displayName(profile) {
  return clean(profile?.name) || clean([profile?.first_name, profile?.last_name].filter(Boolean).join(" ")) || null;
}

function normalizeGender(value) {
  const text = clean(value).toLowerCase();
  if (["male", "nam", "man"].includes(text)) return "male";
  if (["female", "nữ", "nu", "woman"].includes(text)) return "female";
  return null;
}

function applyParticipantName(profile, participantName) {
  if (displayName(profile) || !clean(participantName)) return profile;
  const parts = clean(participantName).split(/\s+/).filter(Boolean);
  return {
    ...profile,
    first_name: parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || null,
    last_name: parts.length > 1 ? parts.at(-1) : null,
  };
}

function isProfileUnavailable(error) {
  return clean(error?.message || error) === "META_PROFILE_NAME_UNAVAILABLE";
}

async function participantName(pageId, customerId, token) {
  try {
    const data = await graph(`${pageId}/conversations`, token, {
      platform: "messenger",
      user_id: customerId,
      fields: "participants",
      limit: 1,
    });
    const participants = data?.data?.[0]?.participants?.data || [];
    return clean(participants.find((item) => String(item.id) === String(customerId))?.name) || null;
  } catch {
    return null;
  }
}

async function fetchProfile(pageId, customerId) {
  const token = await tokenForPage(pageId);
  let profile = {};
  try {
    profile = await graph(customerId, token, { fields: "first_name,last_name,profile_pic,locale,gender" });
  } catch {
    try {
      profile = await graph(customerId, token, { fields: "first_name,last_name,profile_pic,locale" });
    } catch {
      profile = {};
    }
  }
  if (!displayName(profile)) profile = applyParticipantName(profile, await participantName(pageId, customerId, token));
  const name = displayName(profile);
  if (!name) throw new Error("META_PROFILE_NAME_UNAVAILABLE");
  return { profile, name, gender: normalizeGender(profile.gender) };
}

function retryAt(row) {
  const value = row?.profile?.profile_sync_next_at;
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function candidates() {
  const rows = await core(
    "v9_customers?select=id,page_id,customer_id,display_name,gender,profile,last_seen_at,updated_at"
      + "&display_name=is.null&customer_id=not.is.null&order=last_seen_at.desc.nullslast&limit=250",
  );
  const now = Date.now();
  return (rows || []).filter((row) => {
    if (!clean(row.page_id) || !clean(row.customer_id) || row.page_id === row.customer_id) return false;
    const key = `${row.page_id}:${row.customer_id}`;
    return (localCooldown.get(key) || 0) <= now && retryAt(row) <= now;
  }).slice(0, BATCH_SIZE);
}

async function saveSuccess(row, result) {
  const timestamp = nowIso();
  await core(`v9_customers?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      display_name: result.name,
      gender: result.gender || row.gender || null,
      profile: {
        ...(row.profile || {}),
        source: "meta_profile_v10",
        first_name: result.profile.first_name || null,
        last_name: result.profile.last_name || null,
        profile_pic: result.profile.profile_pic || null,
        locale: result.profile.locale || null,
        profile_sync_status: "synced",
        profile_synced_at: timestamp,
        profile_sync_error: null,
        profile_sync_next_at: null,
      },
      updated_at: timestamp,
    },
  });
}

async function saveUnavailable(row) {
  const timestamp = nowIso();
  const next = new Date(Date.now() + UNAVAILABLE_RETRY_MS).toISOString();
  await core(`v9_customers?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      profile: {
        ...(row.profile || {}),
        profile_sync_status: "unavailable",
        profile_sync_attempted_at: timestamp,
        profile_sync_error: "META_PROFILE_NAME_UNAVAILABLE",
        profile_sync_next_at: next,
      },
      updated_at: timestamp,
    },
  }).catch(() => {});
}

async function saveFailure(row, error) {
  const next = new Date(Date.now() + RETRY_MS).toISOString();
  await core(`v9_customers?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      profile: {
        ...(row.profile || {}),
        profile_sync_status: "retry",
        profile_sync_attempted_at: nowIso(),
        profile_sync_error: String(error?.message || error).slice(0, 500),
        profile_sync_next_at: next,
      },
      updated_at: nowIso(),
    },
  }).catch(() => {});
}

async function heartbeat(status, details = {}, error = null) {
  if (!configured()) return;
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER,
      worker_version: VERSION,
      status,
      mode: "SHADOW",
      details: { profile_only: true, outbound: false, ...details },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: nowIso(),
      updated_at: nowIso(),
    },
  });
}

async function tick() {
  if (!configured() || running) return;
  running = true;
  const details = { selected: 0, synced: 0, unavailable: 0, failed: 0 };
  try {
    const rows = await candidates();
    details.selected = rows.length;
    for (const row of rows) {
      const key = `${row.page_id}:${row.customer_id}`;
      try {
        const result = await fetchProfile(row.page_id, row.customer_id);
        await saveSuccess(row, result);
        details.synced += 1;
        localCooldown.delete(key);
      } catch (error) {
        if (isProfileUnavailable(error)) {
          details.unavailable += 1;
          localCooldown.set(key, Date.now() + UNAVAILABLE_RETRY_MS);
          await saveUnavailable(row);
        } else {
          details.failed += 1;
          localCooldown.set(key, Date.now() + RETRY_MS);
          await saveFailure(row, error);
        }
      }
    }
    await heartbeat(details.failed ? "degraded" : "healthy", details, details.failed ? `${details.failed} profile transport/system error(s)` : null);
  } catch (error) {
    await heartbeat("degraded", details, error?.message || error).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

export async function startV10CustomerProfileWorker() {
  if (!configured()) {
    console.warn("[AIGUKA V10 profile] Core configuration missing; disabled");
    return;
  }
  console.log(`[AIGUKA V10 profile] started; profile-only batch=${BATCH_SIZE}, poll=${POLL_MS}ms`);
  await heartbeat("starting", { batch_size: BATCH_SIZE, poll_ms: POLL_MS }).catch(() => {});
  tick().catch(() => {});
}

export const __private__ = {
  displayName,
  normalizeGender,
  applyParticipantName,
  isProfileUnavailable,
  retryAt,
};

await startV10CustomerProfileWorker();
