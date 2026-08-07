import fs from "node:fs";

const AI_FILE = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_GOOGLE_PRIMARY_POOL_V1";

if (!fs.existsSync(AI_FILE)) throw new Error("V10_GOOGLE_PRIMARY_AI_WORKER_MISSING");
let source = fs.readFileSync(AI_FILE, "utf8");

if (!source.includes(MARK)) {
  const oldOrder = `function providerOrder(rows = [], now = Date.now(), inputChars = 0) {
  const eligible = (rows || []).filter((provider) => {
    const learned = Number(healthFor(provider).contextLimitChars || 0);
    const configured = Number(providerSettings(provider).max_input_chars || 0);
    const limits = [learned, configured].filter((value) => Number.isFinite(value) && value > 0);
    const limit = limits.length ? Math.min(...limits) : 0;
    return !limit || !inputChars || inputChars < limit;
  });
  const pool = eligible.length ? eligible : (rows || []);
  const scored = [];
  let totalWeight = 0;
  for (const provider of pool) {
    const health = healthFor(provider);
    const baseWeight = providerWeight(provider);
    const latencyPenalty = health.ewmaLatencyMs > 0 ? Math.min(0.65, health.ewmaLatencyMs / 45_000) : 0;
    const failurePenalty = Math.min(0.7, health.failures * 0.15);
    const effectiveWeight = Math.max(0.1, baseWeight * (1 - latencyPenalty) * (1 - failurePenalty));
    health.currentWeight += effectiveWeight;
    totalWeight += effectiveWeight;
    scored.push({ provider, health, effectiveWeight, priority: providerPriority(provider) });
  }
  if (!scored.length) return [];
  let winner = scored[0];
  for (const item of scored.slice(1)) {
    if (item.health.currentWeight > winner.health.currentWeight) winner = item;
    else if (item.health.currentWeight === winner.health.currentWeight && item.priority < winner.priority) winner = item;
  }
  winner.health.currentWeight -= totalWeight;
  winner.health.lastSelectedAt = now;
  const rest = scored
    .filter((item) => item !== winner)
    .sort((a, b) => b.health.currentWeight - a.health.currentWeight || a.priority - b.priority)
    .map((item) => item.provider);
  return [winner.provider, ...rest];
}`;

  const newOrder = `function weightedProviderOrder(pool = [], now = Date.now()) {
  const scored = [];
  let totalWeight = 0;
  for (const provider of pool || []) {
    const health = healthFor(provider);
    const baseWeight = providerWeight(provider);
    const latencyPenalty = health.ewmaLatencyMs > 0 ? Math.min(0.65, health.ewmaLatencyMs / 45_000) : 0;
    const failurePenalty = Math.min(0.7, health.failures * 0.15);
    const effectiveWeight = Math.max(0.1, baseWeight * (1 - latencyPenalty) * (1 - failurePenalty));
    health.currentWeight += effectiveWeight;
    totalWeight += effectiveWeight;
    scored.push({ provider, health, effectiveWeight, priority: providerPriority(provider) });
  }
  if (!scored.length) return [];
  let winner = scored[0];
  for (const item of scored.slice(1)) {
    if (item.health.currentWeight > winner.health.currentWeight) winner = item;
    else if (item.health.currentWeight === winner.health.currentWeight && item.priority < winner.priority) winner = item;
  }
  winner.health.currentWeight -= totalWeight;
  winner.health.lastSelectedAt = now;
  const rest = scored
    .filter((item) => item !== winner)
    .sort((a, b) => b.health.currentWeight - a.health.currentWeight || a.priority - b.priority)
    .map((item) => item.provider);
  return [winner.provider, ...rest];
}

function providerOrder(rows = [], now = Date.now(), inputChars = 0) {
  const eligible = (rows || []).filter((provider) => {
    const learned = Number(healthFor(provider).contextLimitChars || 0);
    const configured = Number(providerSettings(provider).max_input_chars || 0);
    const limits = [learned, configured].filter((value) => Number.isFinite(value) && value > 0);
    const limit = limits.length ? Math.min(...limits) : 0;
    return !limit || !inputChars || inputChars < limit;
  });
  const pool = eligible.length ? eligible : (rows || []);
  const googlePrimary = pool.filter((provider) => isGemini(provider));
  const fallback = pool.filter((provider) => !isGemini(provider));
  return [
    ...weightedProviderOrder(googlePrimary, now),
    ...weightedProviderOrder(fallback, now),
  ];
}

// ${MARK}`;

  if (!source.includes(oldOrder)) throw new Error("V10_GOOGLE_PRIMARY_PROVIDER_ORDER_TARGET_MISSING");
  source = source.replace(oldOrder, newOrder);

  const oldBackoff = `    const steps = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
    const adaptive = steps[Math.min(steps.length - 1, health.rateLimitFailures - 1)];
    health.disabledUntil = now + Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, Math.max(retryAfter, adaptive));`;
  const newBackoff = `    const steps = isGemini(provider)
      ? [2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000]
      : [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
    const adaptive = steps[Math.min(steps.length - 1, health.rateLimitFailures - 1)];
    const jitter = isGemini(provider) ? Math.floor(Math.random() * 1_000) : 0;
    health.disabledUntil = now + Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, Math.max(retryAfter, adaptive + jitter));`;
  if (!source.includes(oldBackoff)) throw new Error("V10_GOOGLE_PRIMARY_BACKOFF_TARGET_MISSING");
  source = source.replace(oldBackoff, newBackoff);

  const reasoning = '        reasoning_effort: "none",';
  const reasoningFixed = '        ...(providerName(provider) === "gemma" ? {} : { reasoning_effort: "none" }),' ;
  if (!source.includes(reasoning)) throw new Error("V10_GOOGLE_PRIMARY_REASONING_TARGET_MISSING");
  source = source.replace(reasoning, reasoningFixed);

  source = source.replace(
    '        load_balancing: "smooth_weighted_round_robin",',
    '        load_balancing: "google_primary_then_weighted_fallback",\n        google_primary_pool: true,\n        google_rate_limit_scope: "per_independent_provider_project",',
  );

  fs.writeFileSync(AI_FILE, source, "utf8");
}

console.log("[AIGUKA V10] Google primary pool enabled: independent Gemini/Gemma providers first, per-provider backoff with jitter, non-Google providers as fallback");
