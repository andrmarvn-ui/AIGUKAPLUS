// Stable V10 AI entrypoint. Provider configuration, readiness and priority are owned by
// /ai-providers. Compatibility adapters install transport behavior only; they do not
// rewrite worker source. The worker implementation is a committed, checksummed artifact.
async function reportStartupFailure(error) {
  try {
    const base = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
    const key = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
    if (!base || !key) return;
    const now = new Date().toISOString();
    await fetch(`${base}/rest/v1/v9_worker_heartbeats?on_conflict=worker_name`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        worker_name: "aiguka-v10-ai",
        worker_version: "v10_ai_quality_guard_v13",
        status: "degraded",
        mode: "ACTIVE",
        details: {
          final_worker_artifact: true,
          runtime_source_patching: false,
          ai_decision_authority: "sole",
        },
        last_error: String(error instanceof Error ? error.message : error).slice(0, 800),
        last_seen_at: now,
        updated_at: now,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

await import("./v10-provider-runtime-policy.js");
await import("./v10-cohere-schema-sanitizer.js");
await import("./v10-huggingface-runtime-adapter.js");
await import("./v10-openai-compatible-adapter.js");
await import("./v10-sambanova-runtime-adapter.js");

try {
  await import("./v10-ai-worker-final.js");
} catch (error) {
  console.error(`[AIGUKA V10] final AI worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await reportStartupFailure(error);
  throw error;
}
