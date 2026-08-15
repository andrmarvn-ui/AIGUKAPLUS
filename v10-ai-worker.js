// Stable V10 AI entrypoint. Provider adapters affect transport only; all business,
// contact, product-thread and media behavior is committed in v10-ai-worker-final.js.
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
        worker_version: "v10_ai_commerce_integrity_v22",
        status: "degraded",
        mode: "ACTIVE",
        details: {
          final_worker_artifact: true,
          runtime_source_patching: false,
          ai_decision_authority: "proposal_with_hard_commerce_guard",
          validator_authority: "mandatory_grounding_and_deterministic_repair",
          validator_rewrites_business_output: true,
          comment_private_reply_enabled: true,
          specific_product_request_contact_handoff: true,
          group_price_range_scoped_to_product_line: true,
          corrupted_vietnamese_output_blocked: true,
          unresolved_needs_enabled: true,
          product_threads_enabled: true,
          active_intent_focus_enabled: true,
          separate_media_bundle_per_product_group: true,
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

try {
  await import("./v10-ai-worker-final.js");
  await import("./v10-pancake-contact-guard-worker.js");
  await import("./v10-followup-worker.js");
} catch (error) {
  console.error(`[AIGUKA V10] final AI/follow-up worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await reportStartupFailure(error);
  throw error;
}
