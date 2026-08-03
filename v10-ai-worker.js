// Stable startup entrypoint. The implementation lives in v10-ai-worker-v2.js so the
// provider scheduler can evolve without reintroducing runtime source patching.
await import("./v10-ai-worker-v2.js");
