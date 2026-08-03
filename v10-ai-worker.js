// Stable startup entrypoint. Provider configuration, readiness and priority are owned by
// /ai-providers; the runtime policy enforces that contract before any decision is claimed.
await import("./v10-provider-runtime-policy.js");
await import("./v10-openai-compatible-adapter.js");
await import("./v10-ai-worker-v2.js");
