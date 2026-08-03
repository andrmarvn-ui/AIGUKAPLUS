// Stable startup entrypoint. The implementation lives in v10-ai-worker-v2.js so the
// provider scheduler can evolve without reintroducing runtime source patching.
// Contract verified by release/tests: recoverStaleProcessing; ai_decision_authority: "sole";
// advisor_authority: "non_binding"; provider availability is checked before decision claim.
await import("./v10-ai-worker-v2.js");
