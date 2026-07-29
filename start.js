// Protect database pressure and customer-facing Meta transport before any worker.
await import("./patch-supabase-load-shed-fetch.js");
await import("./patch-meta-price-language-fetch.js");
const { loadActiveMetaConnection } = await import("./meta-token-store.js");

process.env.META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "AIGUKA_V8_META_VERIFY";
process.env.AIGUKA_REPORT_V21_DEFAULT = "false";

if (!process.env.SUPABASE_PUBLISHABLE_KEY && !process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
await safeImport("./server-fixed.js", true);

// V8 continues reading the legacy database. Only v9_* REST/RPC calls are routed to the isolated Core project.
await safeImport("./v9-core-fetch-router.js");

startDetached("./webhook-inbox-worker.js");
startDetached("./meta-recovery-loader.js");
startDetached("./ai-dispatch-worker.js");
startDetached("./outbound-worker.js");
startDetached("./meta-profile-sync-worker.js");
startDetached("./v9-shadow-worker.js");
startDetached("./v9-ai-shadow-worker.js");
