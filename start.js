// Protect database pressure and customer-facing Meta transport before any worker.
await import("./patch-supabase-load-shed-fetch.js");

// Establish the isolated Core connection before importing modules that capture
// Core environment variables at module load time.
const { bootstrapV9CoreBridge, v9CoreBridgeState } = await import("./v9-core-bridge-bootstrap.js");
await bootstrapV9CoreBridge();

const { loadActiveMetaConnection } = await import("./meta-token-store.js");

process.env.META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "AIGUKA_V8_META_VERIFY";

if (!process.env.SUPABASE_PUBLISHABLE_KEY && !process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Reporting remains a read model. Explicit Reporting credentials win; the legacy
// project is only a temporary host while the dedicated Reporting project is absent.
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
  void import(path).catch((error) => {
    console.error(`[AIGUKA startup detached] ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
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

// Active feature-source compatibility patches. These patch feature modules only;
// the Railway HTTP server and AI worker are committed checksummed artifacts.
for (const patch of [
  "./patch-learning-client.js",
  "./patch-bot-page-mode-save.js",
  "./patch-bot-page-support-mode.js",
  "./patch-bot-clock-24h.js",
  "./patch-ai-context-nav.js",
  "./patch-ai-context-card-selection.js",
  "./patch-ai-context-center-validation.js",
  "./patch-ai-provider-tokenrouter.js",
  "./patch-ai-provider-manager-compact-ui.js",
  "./patch-ai-provider-resilience-ui.js",
  "./patch-ai-provider-temporary-errors.js",
  "./patch-meta-pages-messaging-scope.js",
  "./patch-drive-v4-key-compat.js",
  "./patch-drive-v4-api-key-folder-action.js",
  "./patch-drive-folder-tree-hierarchy.js",
  "./patch-catalog-key-rename.js",
  "./patch-slide-generic-carousel.js",
  "./seed-tong-hop-context.js",
  "./patch-mapping-meta-midnight-delivery.js",
]) await safeImport(patch);

// TokenRouter's free Kimi K3 route documents streaming chat completions. Install the
// SSE aggregator before the HTTP server so both manager smoke tests and the worker use it.
await safeImport("./v10-tokenrouter-runtime-adapter.js");

await safeImport("./patch-outbound-human-takeover.js");
await safeImport("./patch-outbound-comment-private-reply.js");
await safeImport("./patch-outbound-binary-image-upload.js");
await safeImport("./patch-outbound-drive-image-proxy-v2.js");
await safeImport("./patch-outbound-marketing-notifications.js");
await safeImport("./patch-ai-brain-internal-auth.js");
await safeImport("./patch-ai-dispatch-profile-gender-preflight.js");

// Bind the checksummed Railway HTTP server before background workers.
await safeImport("./v10-server-release.js", true);
console.log("[AIGUKA startup] final V10 HTTP server initialized; verifying V10 AI release contract");
await safeImport("./v10-live-release.js", true);
console.log("[AIGUKA startup] V10 AI-sovereign release contract verified");

// Apply the stable sales patch first. The Core router then installs the legacy V10
// quality/hierarchy compatibility chain against its expected source layout.
await safeImport("./patch-v10-general-product-sales-handoff.js", true);
const v9CoreModule = await safeImport("./v9-core-fetch-router.js");

// Media obligation integrity is deliberately the last resolver layer. It replaces the
// already-patched outbound resolver, so legacy quality patches never have to parse the
// new layout. Keep fail-open behavior for future source-layout changes.
await safeImport("./patch-v10-media-obligation-integrity.js");

// Core ingest/debounce is the single authority for merging rapid customer messages.
// This final patch removes conversation-level "latest decision wins" behavior: stale
// outbound work is held, a merged job is guaranteed, and janitor only dedupes decisions
// that represent the exact same customer-message frontier.
await safeImport("./patch-v10-turn-merge-authority.js", true);

const v9CoreReady = v9CoreBridgeState.ready === true
  && v9CoreModule?.v9CoreRoutingState?.enabled === true;
const reportingReady = Boolean(
  String(process.env.AIGUKA_V9_REPORTING_URL || "").trim()
  && String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || "").trim()
);

// V8 decision, AI, profile and outbound workers are permanently retired. Ignore the
// historical rollback flag so an old Railway variable cannot start a second bot stack.
if (String(process.env.AIGUKA_V8_BACKGROUND_WORKERS || "false").trim().toLowerCase() === "true") {
  console.error("[AIGUKA V10] AIGUKA_V8_BACKGROUND_WORKERS is ignored: legacy customer workers are permanently retired");
}

// Legacy report rebuilds are opt-in fallback only. Normal reporting reads live Meta
// inventory/insights and Core customer metrics, so these duplicate DB writes stay off.
const reportingRefreshEnabled = String(process.env.AIGUKA_V9_REPORTING_LEGACY_REFRESH || "false").trim().toLowerCase() === "true";
if (reportingReady && reportingRefreshEnabled && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  startDetached("./v9-reporting-legacy-refresh-worker-v2.js");
  startDetached("./v9-reporting-conversation-refresh-worker.js");
  console.warn(`[AIGUKA Reporting] legacy read-model refresh explicitly enabled${temporaryReportingHost ? " on temporary Knowledge host" : ""}`);
} else {
  console.log("[AIGUKA Reporting] legacy read-model refresh disabled; direct Meta/Core sources active");
}

const metaInsightsEnabled = String(process.env.AIGUKA_V9_META_INSIGHTS_ENABLED || "false").trim().toLowerCase() === "true";
if (reportingReady && metaInsightsEnabled && process.env.META_ACCESS_TOKEN && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  await safeImport("./v9-postgrest-uniform-batch.js");
  startDetached("./v9-meta-ads-insights-worker.js");
  startDetached("./v9-meta-ad-page-resolver-worker.js");
  startDetached("./v9-meta-orphan-ad-resolver-worker.js");
  console.warn("[AIGUKA Reporting] compatibility Meta snapshot workers explicitly enabled");
} else {
  console.log("[AIGUKA Reporting] Meta snapshot workers disabled; dashboard queries Meta directly");
}

if (v9CoreReady) {
  // The webhook inbox bridge is still required: Meta events currently land in the
  // durable legacy inbox before Core ingestion. It has no outbound authority.
  startDetached("./v9-legacy-inbox-bridge.js");
  startDetached("./v10-mode-compat-worker.js");
  await safeImport("./v10-decision-queue-janitor.js", true);
  startDetached("./v10-direct-core-worker.js");
  startDetached("./v10-customer-profile-worker.js");
  startDetached("./v10-ai-worker.js");
  startDetached("./v10-outbound-worker.js");
  startDetached("./v9-reporting-publisher.js");
  console.log(`[AIGUKA V10] Core workers started via ${v9CoreBridgeState.mode}; AI is the sole customer decision maker`);

  if (reportingReady) {
    startDetached("./v9-reporting-sync-worker.js");
    console.log("[AIGUKA Reporting] reporting sync worker started for Lead history and exports");
  } else {
    console.warn("[AIGUKA Reporting] sync disabled: Reporting URL/service-role missing; Core outbox will retain events");
  }
} else {
  console.warn(`[AIGUKA V10] workers not started: isolated Core connection blocked (${v9CoreBridgeState.error || "unknown"})`);
}
