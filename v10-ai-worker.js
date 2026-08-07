// Stable V10 AI entrypoint. Provider configuration, readiness and priority are owned by
// /ai-providers. Compatibility adapters install transport behavior. Legacy repair layers
// load first for source compatibility; the sovereign validator is the final authority and
// bypasses business-output rewriting before the final worker starts.
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
        worker_version: "v10_ai_sovereign_validator_v18",
        status: "degraded",
        mode: "ACTIVE",
        details: {
          final_worker_artifact: true,
          runtime_source_patching: true,
          ai_decision_authority: "sole",
          validator_authority: "reject_and_feedback_only",
          validator_rewrites_business_output: false,
          unresolved_needs_enabled: true,
          recursive_catalog_advisory: true,
          provider_cooldown_is_per_key: true,
          provider_auto_recovery: true,
          customer_turn_supersession_guard: true,
          contact_request_cooldown_messages: 2,
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
await import("./v10-cerebras-runtime-adapter.js");
await import("./v10-mistral-runtime-adapter.js");
await import("./v10-openai-compatible-adapter.js");
await import("./v10-beeknoee-runtime-adapter.js");
await import("./v10-tokenrouter-runtime-adapter.js");
await import("./v10-together-runtime-adapter.js");
await import("./v10-sambanova-runtime-adapter.js");
await import("./patch-v10-gemini-provider-type.js");
await import("./patch-v10-provider-resilience.js");
await import("./patch-v10-google-primary-pool.js");
await import("./patch-v10-specific-price-contact.js");
await import("./patch-v10-general-product-sales-handoff.js");
await import("./patch-v10-general-product-sales-finalize.js");
await import("./v10-conversation-continuity-runtime.js");
await import("./patch-v10-ai-sovereign-validator.js");

try {
  await import("./v10-ai-worker-final.js");
  await import("./v10-pancake-contact-guard-worker.js");
  await import("./v10-followup-worker.js");
} catch (error) {
  console.error(`[AIGUKA V10] final AI/follow-up worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await reportStartupFailure(error);
  throw error;
}
