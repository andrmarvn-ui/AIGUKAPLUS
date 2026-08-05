// Stable startup entrypoint. Provider configuration, readiness and priority are owned by
// /ai-providers; the runtime policy enforces that contract before any decision is claimed.
async function reportQualityPatchFailure(error) {
  try {
    const base = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
    const key = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
    if (!base || !key) return;
    const now = new Date().toISOString();
    await fetch(`${base}/rest/v1/v9_worker_heartbeats?on_conflict=worker_name`, {
      method: "POST",
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        worker_name: "aiguka-v10-quality-patch",
        worker_version: "quality_patch_diagnostic_v1",
        status: "degraded",
        mode: "ACTIVE",
        details: { decision_integrity_required: true },
        last_error: String(error instanceof Error ? error.message : error).slice(0, 800),
        last_seen_at: now,
        updated_at: now,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

await import("./v10-provider-runtime-policy.js");
await import("./v10-cohere-schema-sanitizer.js");
await import("./v10-openai-compatible-adapter.js");
await import("./v10-sambanova-runtime-adapter.js");
await import("./patch-v10-provider-load-balancer.js").catch((error) => {
  console.error(`[AIGUKA V10] quota-aware load balancer patch failed; continuing with legacy scheduler: ${error instanceof Error ? error.message : String(error)}`);
});
await import("./patch-v10-provider-load-balancer-v4.js").catch((error) => {
  console.error(`[AIGUKA V10] load balancer v4 refinements failed; continuing with v3: ${error instanceof Error ? error.message : String(error)}`);
});
await import("./patch-v10-provider-load-balancer-v5.js").catch((error) => {
  console.error(`[AIGUKA V10] load balancer v5 tuning failed; continuing with v4: ${error instanceof Error ? error.message : String(error)}`);
});
await import("./patch-v10-provider-load-balancer-v6.js").catch((error) => {
  console.error(`[AIGUKA V10] load balancer v6 routing failed; continuing with v5: ${error instanceof Error ? error.message : String(error)}`);
});
for (const patch of [
  "./patch-v10-decision-integrity-v4.js",
  "./patch-v10-decision-integrity-v5.js",
  "./patch-v10-decision-integrity-v6.js",
  "./patch-v10-decision-integrity-v7.js",
  "./patch-v10-decision-integrity-v8.js",
  "./patch-v10-decision-integrity-v9.js",
]) {
  await import(patch).catch(async (error) => {
    console.error(`[AIGUKA V10] ${patch} failed; worker will not start unsafely: ${error instanceof Error ? error.message : String(error)}`);
    await reportQualityPatchFailure(error);
    throw error;
  });
}
await import("./v10-ai-worker-v2.js");
