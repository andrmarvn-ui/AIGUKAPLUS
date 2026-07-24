import { loadActiveMetaConnection } from "./meta-token-store.js";

process.env.META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "AIGUKA_V8_META_VERIFY";

// materialize-v7-dashboard only uses this key for a server-side RPC during
// startup. It is never written into the generated dashboard or sent to the
// browser. Railway already requires SUPABASE_SERVICE_ROLE_KEY for its workers,
// so use it when no publishable/anon key variable was configured separately.
if (
  !process.env.SUPABASE_PUBLISHABLE_KEY &&
  !process.env.SUPABASE_ANON_KEY &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
}

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

await import("./patch-v7-pancake-classifier.js");
await import("./patch-v7-pancake-history.js");
await import("./patch-v7-pancake-tag-parser.js");
await import("./materialize-v7-dashboard.js");
await import("./patch-v7-report-accuracy.js");
await import("./patch-v7-product-detection.js");
await import("./patch-v7-navigation.js");
await import("./patch-v7-pancake-toggle.js");
await import("./patch-v7-lead-filters.js");
await import("./patch-v7-daily-grouped.js");
await import("./patch-v7-daily-staff-history.js");
await import("./patch-v7-daily-layout-sample.js");
await import("./patch-v7-filter-final.js");

await import("./patch-v7-daily-staff-aligned.js");
await import("./patch-v7-daily-runtime-self-contained.js");
await import("./patch-v7-leads-meta-primary.js");
await import("./patch-v7-leads-referral-source.js");
await import("./patch-v7-pancake-tag-completeness.js");
await import("./patch-v7-pancake-tag-final.js");
await import("./patch-v7-daily-final-anchor-fix.js");
await import("./patch-v7-daily-final.js");
await import("./patch-v7-daily-runtime-fallback.js");
await import("./patch-v7-lead-table-v4.js");
await import("./patch-v7-lead-filter-logical.js");
await import("./patch-v7-lead-contact-ui.js");
await import("./patch-v7-null-safety.js");
await import("./patch-v7-runtime-integrity.js");
await import("./patch-v7-lead-meta-insights-truth.js");
await import("./patch-v7-lead-reel-old-ad-attribution.js");
await import("./patch-v7-lead-reel-reply-guard.js");
await import("./patch-v7-split-leads-compat.js");
await import("./patch-v7-split-leads-ad-performance.js");
await import("./patch-v7-lead-filter-status-fix.js");
await import("./patch-v7-lead-account-reconcile.js");

await import("./patch-learning-client.js");
await import("./patch-bot-page-mode-save.js");
await import("./patch-bot-page-support-mode.js");
await import("./patch-bot-clock-24h.js");
await import("./patch-ai-context-nav.js");
await import("./patch-ai-context-card-selection.js");
await import("./patch-ai-context-center-validation.js");
await import("./patch-meta-pages-messaging-scope.js");
await import("./patch-drive-v4-key-compat.js");
await import("./patch-drive-v4-api-key-folder-action.js");
await import("./patch-drive-folder-tree-hierarchy.js");
await import("./patch-catalog-key-rename.js");
await import("./patch-slide-generic-carousel.js");
await import("./seed-tong-hop-context.js");
await import("./patch-mapping-meta-midnight-delivery.js");
await import("./patch-server.js");
await import("./server-fixed.js");
await import("./patch-outbound-human-takeover.js");
await import("./patch-outbound-comment-private-reply.js");
await import("./patch-outbound-binary-image-upload.js");
await import("./patch-outbound-drive-image-proxy-v2.js");
await import("./patch-outbound-marketing-notifications.js");
await import("./patch-ai-brain-internal-auth.js");
await import("./meta-profile-sync-worker.js");
await import("./drive-sync-request-worker.js");
await import("./ai-dispatch-worker.js");
await import("./response-obligation-worker.js");
await import("./outbound-worker.js");
