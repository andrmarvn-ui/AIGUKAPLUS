// Protect database pressure and customer-facing Meta transport before any worker.
await import("./patch-supabase-load-shed-fetch.js");
await import("./patch-meta-price-language-fetch.js");

// Establish the isolated V9 Core connection before importing any module that captures
// Core environment variables at module load time. A real Core service-role key wins;
// otherwise Railway obtains a database-only bridge credential from the legacy project.
const { bootstrapV9CoreBridge, v9CoreBridgeState } = await import("./v9-core-bridge-bootstrap.js");
await bootstrapV9CoreBridge();

const { loadActiveMetaConnection } = await import("./meta-token-store.js");

process.env.META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "AIGUKA_V8_META_VERIFY";
process.env.AIGUKA_REPORT_V21_DEFAULT = "false";

if (!process.env.SUPABASE_PUBLISHABLE_KEY && !process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Until a dedicated Reporting project is provisioned, use the Knowledge/legacy project
// only as a materialized read-model host. Explicit Reporting credentials always win.
const temporaryReportingHost = !String(process.env.AIGUKA_V9_REPORTING_URL || "").trim()
  && Boolean(String(process.env.SUPABASE_URL || "").trim())
  && Boolean(String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim());
if (temporaryReportingHost) {
  process.env.AIGUKA_V9_REPORTING_URL = process.env.SUPABASE_URL;
  process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.AIGUKA_V9_REPORTING_TEMPORARY_HOST = "true";
}

async function safeImport(path, critical = false) {
  try { return await import(path); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AIGUKA startup] ${path} failed: ${message}`);
    if (critical) throw error;
    return null;
  }
}
function startDetached(path) {
  void import(path).catch((error) => console.error(`[AIGUKA startup detached] ${path} failed: ${error instanceof Error ? error.message : String(error)}`));
}

try {
  const connection = await loadActiveMetaConnection();
  if (connection?.accessToken) {
    process.env.META_ACCESS_TOKEN = connection.accessToken;
    process.env.META_AUTO_AD_ACCOUNTS = process.env.META_AUTO_AD_ACCOUNTS || "true";
    console.log(`[AIGUKA] Loaded Meta OAuth connection for ${connection.facebookUserName || connection.facebookUserId}`);
  }
} catch (error) {
  console.error("[AIGUKA] Could not load saved Meta OAuth connection:", error.message);
}

for (const patch of [
  "./patch-v7-pancake-classifier.js",
  "./patch-v7-pancake-history.js",
  "./patch-v7-pancake-tag-parser.js",
  "./patch-learning-client.js",
  "./patch-bot-page-mode-save.js",
  "./patch-bot-page-support-mode.js",
  "./patch-bot-clock-24h.js",
  "./patch-ai-context-nav.js",
  "./patch-ai-context-card-selection.js",
  "./patch-ai-context-center-validation.js",
  "./patch-meta-pages-messaging-scope.js",
  "./patch-drive-v4-key-compat.js",
  "./patch-drive-v4-api-key-folder-action.js",
  "./patch-drive-folder-tree-hierarchy.js",
  "./patch-catalog-key-rename.js",
  "./patch-slide-generic-carousel.js",
  "./seed-tong-hop-context.js",
  "./patch-mapping-meta-midnight-delivery.js",
]) await safeImport(patch);

await safeImport("./patch-server.js");
await safeImport("./patch-outbound-human-takeover.js");
await safeImport("./patch-outbound-comment-private-reply.js");
await safeImport("./patch-outbound-binary-image-upload.js");
await safeImport("./patch-outbound-drive-image-proxy-v2.js");
await safeImport("./patch-outbound-marketing-notifications.js");
await safeImport("./patch-ai-brain-internal-auth.js");
await safeImport("./patch-ai-dispatch-profile-gender-preflight.js");

// Bind Railway HTTP first. V10 is a clean release with no runtime source patch chain.
await safeImport("./server-fixed.js", true);
console.log("[AIGUKA startup] HTTP server initialized; verifying clean V10 customer-worker release");
await safeImport("./v10-live-release.js", true);
console.log("[AIGUKA startup] V10 AI-sovereign release verified after HTTP bind");

// V8 remains a temporary durable webhook source. Customer state, jobs and decisions
// still use the isolated Core project while V10 replaces the V9 decision workers.
const v9CoreModule = await safeImport("./v9-core-fetch-router.js");
const v9CoreReady = v9CoreBridgeState.ready === true
  && v9CoreModule?.v9CoreRoutingState?.enabled === true;
const reportingReady = Boolean(
  String(process.env.AIGUKA_V9_REPORTING_URL || "").trim()
  && String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || "").trim()
);

// Legacy V8 background workers stay off unless explicitly enabled for emergency rollback.
const v8BackgroundEnabled = String(process.env.AIGUKA_V8_BACKGROUND_WORKERS || "false").trim().toLowerCase() === "true";
if (v8BackgroundEnabled) {
  startDetached("./webhook-inbox-worker.js");
  startDetached("./meta-recovery-loader.js");
  startDetached("./ai-dispatch-worker.js");
  startDetached("./outbound-worker.js");
  startDetached("./meta-profile-sync-worker.js");
  console.warn("[AIGUKA V8] legacy background workers explicitly enabled");
} else {
  console.warn("[AIGUKA V8] legacy background workers disabled for V10 migration");
}

// These workers only materialize advertising/CRM source data into the Reporting read model.
// They never send Messenger messages and do not require V9 Core credentials.
const reportingRefreshEnabled = String(process.env.AIGUKA_V9_REPORTING_LEGACY_REFRESH || "true").trim().toLowerCase() !== "false";
if (reportingReady && reportingRefreshEnabled && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  startDetached("./v9-reporting-legacy-refresh-worker-v2.js");
  startDetached("./v9-reporting-conversation-refresh-worker.js");
  console.log(`[AIGUKA Reporting] resilient legacy read-model and conversation refresh started${temporaryReportingHost ? " on temporary Knowledge host" : ""}`);
}
const metaInsightsEnabled = String(process.env.AIGUKA_V9_META_INSIGHTS_ENABLED || "true").trim().toLowerCase() !== "false";
if (reportingReady && metaInsightsEnabled && process.env.META_ACCESS_TOKEN && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  await safeImport("./v9-postgrest-uniform-batch.js");
  startDetached("./v9-meta-ads-insights-worker.js");
  startDetached("./v9-meta-ad-page-resolver-worker.js");
  startDetached("./v9-meta-orphan-ad-resolver-worker.js");
  console.log("[AIGUKA Reporting] Meta Ads Insights, creative Page and orphan Ad resolver workers started for mapped Page accounts");
}

if (v9CoreReady) {
  startDetached("./v9-legacy-inbox-bridge.js");
  startDetached("./v8-v9-mode-sync-worker.js");
  startDetached("./v10-direct-core-worker.js");
  startDetached("./v10-ai-worker.js");
  startDetached("./v10-outbound-worker.js");
  startDetached("./v9-reporting-publisher.js");
  console.log(`[AIGUKA V10] clean Core workers started via ${v9CoreBridgeState.mode}; rules and mappings are advisory, AI is the sole business decision maker`);

  if (reportingReady) {
    startDetached("./v9-reporting-sync-worker.js");
    console.log("[AIGUKA Reporting] reporting sync worker started");
  } else {
    console.warn("[AIGUKA Reporting] sync disabled: Reporting URL/service-role missing; Core outbox will retain events");
  }
} else {
  console.warn(`[AIGUKA V10] workers not started: isolated Core connection blocked (${v9CoreBridgeState.error || "unknown"})`);
}
