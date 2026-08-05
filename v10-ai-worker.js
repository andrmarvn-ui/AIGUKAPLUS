// Stable startup entrypoint. Provider configuration, readiness and priority are owned by
// /ai-providers; the runtime policy enforces that contract before any decision is claimed.
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
await import("./patch-v10-decision-integrity-v1.js").catch((error) => {
  console.error(`[AIGUKA V10] decision integrity patch failed; worker will not start safely: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
});
await import("./patch-v10-decision-integrity-v2.js").catch((error) => {
  console.error(`[AIGUKA V10] corrected integrity scanner failed; worker will not start safely: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
});
await import("./patch-v10-quality-observability-v1.js").catch((error) => {
  console.error(`[AIGUKA V10] quality observability failed; worker will not start safely: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
});
await import("./v10-ai-worker-v2.js");
