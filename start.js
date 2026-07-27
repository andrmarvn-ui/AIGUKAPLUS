// Install database-pressure protection before any module can call Supabase.
await import("./patch-supabase-load-shed-fetch.js");
const { loadActiveMetaConnection } = await import("./meta-token-store.js");

process.env.META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "AIGUKA_V8_META_VERIFY";

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

async function databaseReady() {
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/v8_pages?select=id&limit=1`, {
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

const dbReadyAtStartup = await databaseReady();
if (!dbReadyAtStartup) {
  console.error(
    "[AIGUKA startup] Supabase is saturated/unavailable. Starting the realtime service in degraded mode; dashboard materialization and background patches are deferred until the next healthy deploy.",
  );
}

if (dbReadyAtStartup) {
  try {
    const connection = await loadActiveMetaConnection();
    if (connection?.accessToken) {
      process.env.META_ACCESS_TOKEN = connection.accessToken;
      process.env.META_AUTO_AD_ACCOUNTS = process.env.META_AUTO_AD_ACCOUNTS || "true";
      console.log(
        `[AIGUKA] Loaded Meta OAuth connection for ${connection.facebookUserName || connection.facebookUserId}`,
      );
    } else {
      console.log("[AIGUKA] No saved Meta OAuth connection; using Railway variables");
    }
  } catch (error) {
    console.error("[AIGUKA] Could not load saved Meta OAuth connection:", error.message);
  }

  const dashboardPatches = [
    "./patch-v7-pancake-classifier.js",
    "./patch-v7-pancake-history.js",
    "./patch-v7-pancake-tag-parser.js",
    "./materialize-v7-dashboard.js",
    "./patch-v7-report-accuracy.js",
    "./patch-v7-product-detection.js",
    "./patch-v7-navigation.js",
    "./patch-v7-pancake-toggle.js",
    "./patch-v7-lead-filters.js",
    "./patch-v7-daily-grouped.js",
    "./patch-v7-daily-staff-history.js",
    "./patch-v7-daily-layout-sample.js",
    "./patch-v7-filter-final.js",
    "./patch-v7-daily-staff-aligned.js",
    "./patch-v7-daily-runtime-self-contained.js",
    "./patch-v7-leads-meta-primary.js",
    "./patch-v7-leads-referral-source.js",
    "./patch-v7-pancake-tag-completeness.js",
    "./patch-v7-pancake-tag-final.js",
    "./patch-v7-daily-final-anchor-fix.js",
    "./patch-v7-daily-final.js",
    "./patch-v7-daily-runtime-fallback.js",
    "./patch-v7-lead-table-v4.js",
    "./patch-v7-lead-filter-logical.js",
    "./patch-v7-lead-contact-ui.js",
    "./patch-v7-null-safety.js",
    "./patch-v7-runtime-integrity.js",
    "./patch-v7-lead-meta-insights-truth.js",
    "./patch-v7-lead-reel-old-ad-attribution.js",
    "./patch-v7-lead-reel-reply-guard.js",
    "./patch-v7-split-leads-compat.js",
    "./patch-v7-split-leads-ad-performance.js",
    "./patch-v7-lead-filter-status-fix.js",
    "./patch-v7-lead-account-reconcile.js",
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
  ];
  for (const patch of dashboardPatches) await safeImport(patch);
}

await safeImport("./patch-server.js");
await safeImport("./patch-outbound-human-takeover.js");
await safeImport("./patch-outbound-comment-private-reply.js");
await safeImport("./patch-outbound-binary-image-upload.js");
await safeImport("./patch-outbound-drive-image-proxy-v2.js");
await safeImport("./patch-outbound-marketing-notifications.js");
await safeImport("./patch-ai-brain-internal-auth.js");
await safeImport("./server-fixed.js", true);

await safeImport("./meta-profile-sync-worker.js");
await safeImport("./meta-recovery-loader.js");
await safeImport("./drive-sync-request-worker.js");
await safeImport("./ai-dispatch-worker.js");
await safeImport("./response-obligation-worker.js");
await safeImport("./outbound-worker.js");
await safeImport("./report-v21-worker.js");
