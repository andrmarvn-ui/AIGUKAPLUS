const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v23.0").trim();
const APP_ID = String(process.env.META_APP_ID || "").trim();
const APP_SECRET = String(process.env.META_APP_SECRET || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const CORE_URL = String(process.env.AIGUKA_V9_CORE_URL || "").trim().replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "").trim();
const VERIFY_TOKEN = String(process.env.META_WEBHOOK_VERIFY_TOKEN || "AIGUKA_V8_META_VERIFY").trim();
const CALLBACK_URL = String(
  process.env.META_WEBHOOK_CALLBACK_URL
  || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/aiguka-v9-webhook` : ""),
).trim();
const SUBSCRIBED_FIELDS = [
  "messages",
  "messaging_postbacks",
  "messaging_optins",
  "messaging_referrals",
  "feed",
];

async function graph(path, options = {}) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body: options.body,
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const message = data?.error?.message || data?.message || `META_HTTP_${response.status}`;
    const code = data?.error?.code ? `:${data.error.code}` : "";
    throw new Error(`${message}${code}`);
  }
  return data;
}

async function coreGet(path) {
  if (!CORE_URL || !CORE_KEY) return [];
  const response = await fetch(`${CORE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: CORE_KEY,
      authorization: `Bearer ${CORE_KEY}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : []; }
  catch { data = []; }
  if (!response.ok) throw new Error(data?.message || data?.error || `CORE_HTTP_${response.status}`);
  return Array.isArray(data) ? data : [];
}

function currentPageSubscription(data) {
  return (Array.isArray(data?.data) ? data.data : []).find((item) => String(item?.object || "") === "page") || null;
}

function fieldNames(subscription) {
  return new Set((Array.isArray(subscription?.fields) ? subscription.fields : [])
    .map((field) => String(field?.name || field || "").trim())
    .filter(Boolean));
}

function needsRepair(subscription) {
  if (!subscription) return true;
  if (String(subscription.callback_url || "").trim() !== CALLBACK_URL) return true;
  const names = fieldNames(subscription);
  return SUBSCRIBED_FIELDS.some((field) => !names.has(field));
}

async function ensureAppWebhook(appToken) {
  const current = await graph(`/${encodeURIComponent(APP_ID)}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
  const pageSubscription = currentPageSubscription(current);
  if (!needsRepair(pageSubscription)) {
    console.log(`[AIGUKA Meta webhook] app subscription healthy: ${CALLBACK_URL}`);
    return { changed: false };
  }

  const body = new URLSearchParams({
    object: "page",
    callback_url: CALLBACK_URL,
    verify_token: VERIFY_TOKEN,
    fields: SUBSCRIBED_FIELDS.join(","),
    include_values: "true",
    access_token: appToken,
  });
  await graph(`/${encodeURIComponent(APP_ID)}/subscriptions`, { method: "POST", body });
  console.log(`[AIGUKA Meta webhook] app subscription repaired: ${CALLBACK_URL}`);
  return { changed: true };
}

async function activeAigukaPages() {
  const rows = await coreGet("v9_pages?select=page_id,page_name,operating_mode,is_active&is_active=eq.true&operating_mode=neq.OFF");
  return rows
    .map((row) => ({
      pageId: String(row.page_id || "").trim(),
      pageName: String(row.page_name || "").trim(),
      mode: String(row.operating_mode || "").trim().toUpperCase(),
    }))
    .filter((row) => row.pageId);
}

function configuredTargetPageIds(activePages) {
  const ids = new Set(activePages.map((page) => page.pageId));
  const explicit = String(process.env.META_TARGET_PAGE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const id of explicit) ids.add(id);
  const pancakePageId = String(process.env.PANCAKE_PAGE_ID || "").trim();
  if (pancakePageId && !ids.size) ids.add(pancakePageId);
  return ids;
}

async function managedPageCandidates() {
  const userToken = String(process.env.META_ACCESS_TOKEN || "").trim();
  if (!userToken) return [];
  const accounts = await graph(`/me/accounts?fields=id,name,access_token,tasks&limit=200&access_token=${encodeURIComponent(userToken)}`);
  return (Array.isArray(accounts?.data) ? accounts.data : [])
    .map((page) => ({
      pageId: String(page?.id || "").trim(),
      pageName: String(page?.name || "").trim(),
      token: String(page?.access_token || "").trim(),
      tasks: Array.isArray(page?.tasks) ? page.tasks : [],
      source: "oauth_managed_page",
    }))
    .filter((page) => page.pageId && page.token);
}

async function explicitTokenCandidates() {
  const raw = [
    { token: String(process.env.PAGE_ACCESS_TOKEN || "").trim(), source: "PAGE_ACCESS_TOKEN" },
    { token: String(process.env.PANCAKE_PAGE_ACCESS_TOKEN || "").trim(), source: "PANCAKE_PAGE_ACCESS_TOKEN" },
  ].filter((item) => item.token);
  const result = [];
  for (const item of raw) {
    try {
      const profile = await graph(`/me?fields=id,name&access_token=${encodeURIComponent(item.token)}`);
      result.push({
        ...item,
        pageId: String(profile?.id || "").trim(),
        pageName: String(profile?.name || "").trim(),
      });
    } catch (error) {
      console.warn(`[AIGUKA Meta webhook] ${item.source} rejected while resolving page: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

async function subscribePage(candidate) {
  const body = new URLSearchParams({
    subscribed_fields: SUBSCRIBED_FIELDS.join(","),
    access_token: candidate.token,
  });
  await graph(`/${encodeURIComponent(candidate.pageId)}/subscribed_apps`, { method: "POST", body });
  const current = await graph(`/${encodeURIComponent(candidate.pageId)}/subscribed_apps?access_token=${encodeURIComponent(candidate.token)}`);
  const installed = Array.isArray(current?.data) && current.data.some((row) => String(row?.id || "") === APP_ID);
  if (!installed) throw new Error("META_PAGE_SUBSCRIPTION_NOT_CONFIRMED");
  return { pageId: candidate.pageId, pageName: candidate.pageName || candidate.pageId };
}

async function ensurePageSubscriptions() {
  const activePages = await activeAigukaPages();
  const targetIds = configuredTargetPageIds(activePages);
  const [managed, explicit] = await Promise.all([
    managedPageCandidates().catch((error) => {
      console.warn(`[AIGUKA Meta webhook] could not derive managed Page tokens: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }),
    explicitTokenCandidates(),
  ]);

  const candidatesByPage = new Map();
  for (const candidate of [...managed, ...explicit]) {
    if (!candidate.pageId || !candidate.token) continue;
    if (!candidatesByPage.has(candidate.pageId) || candidate.source === "oauth_managed_page") {
      candidatesByPage.set(candidate.pageId, candidate);
    }
  }

  const desiredIds = targetIds.size ? [...targetIds] : [...candidatesByPage.keys()];
  if (!desiredIds.length) throw new Error("META_TARGET_PAGE_MISSING");

  const subscribed = [];
  const failures = [];
  for (const pageId of desiredIds) {
    const candidate = candidatesByPage.get(pageId);
    if (!candidate) {
      failures.push(`${pageId}:PAGE_NOT_AVAILABLE_IN_OAUTH`);
      continue;
    }
    try {
      const result = await subscribePage(candidate);
      subscribed.push(result);
      if (!process.env.PAGE_ACCESS_TOKEN || activePages.some((page) => page.pageId === pageId)) {
        process.env.PAGE_ACCESS_TOKEN = candidate.token;
      }
      console.log(`[AIGUKA Meta webhook] active Page subscription healthy: ${result.pageName} (${result.pageId})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${pageId}:${message}`);
      console.warn(`[AIGUKA Meta webhook] active Page subscription failed for ${candidate.pageName || pageId}: ${message}`);
    }
  }

  const requiredActiveIds = activePages.map((page) => page.pageId);
  const subscribedIds = new Set(subscribed.map((page) => page.pageId));
  const missingRequired = requiredActiveIds.filter((id) => !subscribedIds.has(id));
  if (missingRequired.length) {
    throw new Error(`ACTIVE_PAGE_SUBSCRIPTION_FAILED:${missingRequired.join(",")}:${failures.join("|") || "unknown"}`);
  }
  if (!subscribed.length) {
    throw new Error(`PAGE_SUBSCRIPTION_FAILED:${failures.join("|") || "unknown"}`);
  }
  return subscribed;
}

export async function repairMetaWebhookSubscriptions() {
  if (!APP_ID || !APP_SECRET || !CALLBACK_URL) {
    throw new Error("META_APP_ID_META_APP_SECRET_OR_CALLBACK_MISSING");
  }
  const appToken = `${APP_ID}|${APP_SECRET}`;
  await ensureAppWebhook(appToken);
  return ensurePageSubscriptions();
}

await repairMetaWebhookSubscriptions().catch((error) => {
  console.error(`[AIGUKA Meta webhook] bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
});
