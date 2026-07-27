const SUPABASE_URL = String(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
).replace(/\/$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const DIAG_URL = `${SUPABASE_URL}/rest/v1/v8_config_hub?on_conflict=scope,key`;

async function writeDiagnostic(stage, error = null, extra = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  const payload = {
    scope: "runtime",
    key: "meta_recent_recovery_worker_diagnostic",
    value: {
      stage,
      error: error ? String(error).slice(0, 900) : null,
      has_supabase_url: Boolean(SUPABASE_URL),
      has_service_role_key: Boolean(SERVICE_KEY),
      has_meta_access_token: Boolean(process.env.META_ACCESS_TOKEN),
      has_meta_app_secret: Boolean(process.env.META_APP_SECRET),
      updated_at: new Date().toISOString(),
      ...extra,
    },
    description: "Chẩn đoán khởi động worker đối soát Meta Conversations trực tiếp; không lưu token hoặc khóa bí mật.",
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(DIAG_URL, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          authorization: `Bearer ${SERVICE_KEY}`,
          "content-type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(6_000),
        cache: "no-store",
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
}

await writeDiagnostic("loader_started");
try {
  const loaded = await import("./meta-recent-conversation-recovery-worker.js");
  await writeDiagnostic("worker_imported", null, {
    exported_symbols: Object.keys(loaded),
  });
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : String(error);
  console.error("[AIGUKA Meta recovery loader]", message);
  await writeDiagnostic("worker_import_failed", message);
}
