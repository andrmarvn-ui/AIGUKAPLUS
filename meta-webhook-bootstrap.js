const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v23.0").trim();
const APP_ID = String(process.env.META_APP_ID || "").trim();
const APP_SECRET = String(process.env.META_APP_SECRET || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const PAGE_TOKEN = String(process.env.PAGE_ACCESS_TOKEN || process.env.PANCAKE_PAGE_ACCESS_TOKEN || "").trim();
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

async function ensurePageSubscription() {
  if (!PAGE_TOKEN) {
    console.warn("[AIGUKA Meta webhook] page subscription skipped: PAGE_ACCESS_TOKEN missing");
    return null;
  }
  const token = encodeURIComponent(PAGE_TOKEN);
  const profile = await graph(`/me?fields=id,name&access_token=${token}`);
  const pageId = String(profile?.id || "").trim();
  if (!pageId) throw new Error("META_PAGE_ID_MISSING");

  const body = new URLSearchParams({
    subscribed_fields: SUBSCRIBED_FIELDS.join(","),
    access_token: PAGE_TOKEN,
  });
  await graph(`/${encodeURIComponent(pageId)}/subscribed_apps`, { method: "POST", body });
  console.log(`[AIGUKA Meta webhook] page subscription healthy: ${profile?.name || pageId}`);
  return { pageId, pageName: profile?.name || null };
}

async function main() {
  if (!APP_ID || !APP_SECRET || !CALLBACK_URL) {
    console.warn("[AIGUKA Meta webhook] bootstrap skipped: META_APP_ID, META_APP_SECRET or callback URL missing");
    return;
  }
  const appToken = `${APP_ID}|${APP_SECRET}`;
  await ensureAppWebhook(appToken);
  await ensurePageSubscription();
}

main().catch((error) => {
  console.error(`[AIGUKA Meta webhook] bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
});
