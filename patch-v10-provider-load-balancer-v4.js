import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const fromMarker = "AIGUKA_PROVIDER_LOAD_BALANCER_V3";
const toMarker = "AIGUKA_PROVIDER_LOAD_BALANCER_V4";
if (!fs.existsSync(file)) {
  console.error("[AIGUKA V10] load balancer v4 patch skipped: worker file missing");
} else {
  let source = fs.readFileSync(file, "utf8");

  function replaceOnce(label, before, after) {
    if (!source.includes(before)) throw new Error(`V10_LOAD_BALANCER_V4_TARGET_MISSING:${label}`);
    source = source.replace(before, after);
  }

  if (source.includes(fromMarker) && !source.includes(toMarker)) {
    source = source.replace(fromMarker, toMarker).replace("v10_ai_quota_aware_balancer_v3", "v10_ai_quota_aware_balancer_v4");

    replaceOnce(
      "health_fields",
      "    rateLimitFailures: 0,\n    successes: 0,",
      "    rateLimitFailures: 0,\n    decisionFailures: 0,\n    contextLimitChars: 0,\n    successes: 0,",
    );

    replaceOnce(
      "provider_order_input_gate",
      "function providerOrder(rows = [], now = Date.now()) {\n  const scored = [];\n  let totalWeight = 0;\n  for (const provider of rows || []) {",
      "function providerOrder(rows = [], now = Date.now(), inputChars = 0) {\n  const eligible = (rows || []).filter((provider) => {\n    const limit = Number(healthFor(provider).contextLimitChars || 0);\n    return !limit || !inputChars || inputChars < limit;\n  });\n  const pool = eligible.length ? eligible : (rows || []);\n  const scored = [];\n  let totalWeight = 0;\n  for (const provider of pool) {",
    );

    replaceOnce(
      "classification",
      "  if (/context_length|context window|prompt tokens limit|max.*token|token_limit_exceeded|string_too_long/.test(text)) return \"context_limit\";\n  if (status === 401 || status === 403 || /invalid api key|authentication|permission denied|forbidden/.test(text)) return \"auth_error\";\n  if (status === 402 || /no credits remaining|add credits|insufficient balance|insufficient_quota|billing|payment required/.test(text)) return \"no_credit\";\n  if (status === 429 || status === 498 || /resource exhausted|quota|rate limit|too many requests|capacity exceeded/.test(text)) return \"rate_limit\";\n  if ([408, 424, 499, 500, 502, 503, 504].includes(status) || /timeout|temporar|unavailable|overloaded|network|fetch failed/.test(text)) return \"transient\";\n  if (/invalid schema|did not submit|tool.call|json|decision_invalid|action_invalid|final_reply_required/.test(text)) return \"decision_error\";",
      "  if (status === 413 || /context_length|context window|prompt tokens limit|max.*context|token_limit_exceeded|string_too_long|request entity too large|request body too large/.test(text)) return \"context_limit\";\n  if (status === 401 || status === 403 || /invalid api key|authentication|permission denied|forbidden/.test(text)) return \"auth_error\";\n  if (status === 429 || status === 498 || /resource exhausted|quota|rate limit|too many requests|capacity exceeded|tokens per minute|requests per minute|\\btpm\\b|\\brpm\\b|\\brpd\\b|\\btpd\\b/.test(text)) return \"rate_limit\";\n  if (status === 402 || /no credits remaining|add credits|insufficient balance|insufficient_quota|payment required/.test(text)) return \"no_credit\";\n  if ([408, 424, 499, 500, 502, 503, 504].includes(status) || /timeout|temporar|unavailable|overloaded|network|fetch failed/.test(text)) return \"transient\";\n  if (/invalid schema|did[_ ]not[_ ]submit|tool[._ ]call|json|decision_invalid|action_invalid|final_reply_required/.test(text)) return \"decision_error\";",
    );

    replaceOnce(
      "failure_signature",
      "function recordProviderFailure(provider, classification, error = null) {",
      "function recordProviderFailure(provider, classification, error = null, inputChars = 0) {",
    );
    replaceOnce(
      "context_memory",
      "  if (classification === \"context_limit\") {\n    health.nextAllowedAt = Math.max(health.nextAllowedAt, now + 1000);\n    return;\n  }",
      "  if (classification === \"context_limit\") {\n    if (inputChars > 0) health.contextLimitChars = health.contextLimitChars > 0 ? Math.min(health.contextLimitChars, inputChars) : inputChars;\n    health.nextAllowedAt = Math.max(health.nextAllowedAt, now + 5000);\n    return;\n  }",
    );
    replaceOnce(
      "decision_cooldown",
      "  } else if (classification === \"decision_error\") {\n    health.disabledUntil = now + DECISION_ERROR_COOLDOWN_MS;",
      "  } else if (classification === \"decision_error\") {\n    health.decisionFailures += 1;\n    health.disabledUntil = now + Math.min(DECISION_ERROR_COOLDOWN_MS, 30_000 * (2 ** Math.min(4, health.decisionFailures - 1)));",
    );

    replaceOnce(
      "success_signature",
      "function recordProviderSuccess(provider, latencyMs = 0) {",
      "function recordProviderSuccess(provider, latencyMs = 0, inputChars = 0) {",
    );
    replaceOnce(
      "success_reset",
      "  health.rateLimitFailures = 0;\n  health.reason = null;",
      "  health.rateLimitFailures = 0;\n  health.decisionFailures = 0;\n  if (inputChars > 0 && health.contextLimitChars > 0 && inputChars >= health.contextLimitChars) health.contextLimitChars = 0;\n  health.reason = null;",
    );

    replaceOnce(
      "model_input_size",
      "  const providerErrors = [];\n  const classifications = [];\n  const startedAt = Date.now();",
      "  const modelInputChars = JSON.stringify(modelInput).length;\n  const providerErrors = [];\n  const classifications = [];\n  const startedAt = Date.now();",
    );
    source = source
      .replace("providerOrder(availableProviders, Date.now())", "providerOrder(availableProviders, Date.now(), modelInputChars)")
      .replace("recordProviderSuccess(provider, Date.now() - callStartedAt)", "recordProviderSuccess(provider, Date.now() - callStartedAt, modelInputChars)")
      .replace("recordProviderFailure(provider, classification, error)", "recordProviderFailure(provider, classification, error, modelInputChars)");

    replaceOnce(
      "health_snapshot",
      "    rate_limit_failures: health.rateLimitFailures,\n    ewma_latency_ms:",
      "    rate_limit_failures: health.rateLimitFailures,\n    decision_failures: health.decisionFailures,\n    context_limit_chars: health.contextLimitChars || null,\n    ewma_latency_ms:",
    );

    replaceOnce(
      "decision_observability",
      "          provider_key: result.provider,\n          model: result.model,",
      "          provider_key: result.provider,\n          model_input_chars: modelInputChars,\n          model: result.model,",
    );

    fs.writeFileSync(file, source, "utf8");
    console.log("[AIGUKA V10] quota-aware load balancer v4 refinements installed");
  }
}
