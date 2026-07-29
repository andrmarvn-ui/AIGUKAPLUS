// Protect database pressure and customer-facing Meta transport before any worker.
await import("./patch-supabase-load-shed-fetch.js");
await import("./patch-meta-price-language-fetch.js");
const { loadActiveMetaConnection } = await import("./meta-token-store.js");

process.env.META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "AIGUKA_V8_META_VERIFY";
process.env.AIGUKA_REPORT_V21_DEFAULT = "false";
process.env.AIGUKA_DASHBOARD_BUNDLED = "stable-self-contained-v2";

if (
  !process.env.SUPABASE_PUBLISHABLE_KEY &&
  !process.env.SUPABASE_ANON_KEY &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
}

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
).replace(/\/$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

async function safeImport(path, critical = false) {
  try {
    return await import(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AIGUKA startup] ${path} failed: ${message}`);
    if (critical) throw error;
    return null;
  }
}

function startDetached(path) {
  void import(path).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AIGUKA startup detached] ${path} failed: ${message}`);
  });
}

async function databaseReady() {
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/v8_pages?select=id&limit=1`, {
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      signal: AbortSignal.timeout(2_500),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

// One bounded readiness probe is enough. The dashboard is now committed in the
// repository and no longer depends on Supabase during Railway startup.
const dbReadyAtStartup = await databaseReady();
if (dbReadyAtStartup) {
  try {
    const connection = await loadActiveMetaConnection();
    if (connection?.accessToken) {
      process.env.META_ACCESS_TOKEN = connection.accessToken;
      process.env.META_AUTO_AD_ACCOUNTS = process.env.META_AUTO_AD_ACCOUNTS || "true";
      console.log(
        `[AIGUKA] Loaded Meta OAuth connection for ${connection.facebookUserName || connection.facebookUserId}`,
      );
    }
  } catch (error) {
    console.error("[AIGUKA] Could not load saved Meta OAuth connection:", error.message);
  }
} else {
  console.error(
    "[AIGUKA startup] Supabase is temporarily unavailable. Serving the bundled dashboard and prioritizing realtime transport.",
  );
}

// The committed v7-dashboard-stable.js is the source of truth. Do not run the
// old materializer or the runtime patch chain that previously replaced it with
// an outdated/degraded interface.
await safeImport("./patch-server.js");
await safeImport("./patch-outbound-human-takeover.js");
await safeImport("./patch-outbound-comment-private-reply.js");
await safeImport("./patch-outbound-binary-image-upload.js");
await safeImport("./patch-outbound-drive-image-proxy-v2.js");
await safeImport("./patch-outbound-marketing-notifications.js");
await safeImport("./patch-ai-brain-internal-auth.js");
await safeImport("./patch-ai-dispatch-profile-gender-preflight.js");
await safeImport("./server-fixed.js", true);

// Realtime lanes start independently. Database pressure must not block customer messages.
startDetached("./webhook-inbox-worker.js");
startDetached("./meta-recovery-loader.js");
startDetached("./ai-dispatch-worker.js");
startDetached("./outbound-worker.js");
startDetached("./meta-profile-sync-worker.js");

// Report V2.1 remains a background recovery lane; operational UI stays on V1.
if (dbReadyAtStartup) startDetached("./report-v21-worker.js");
