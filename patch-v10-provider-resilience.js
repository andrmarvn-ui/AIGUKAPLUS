import fs from "node:fs";

const file = "v10-ai-worker-final.js";
const marker = "AIGUKA_PROVIDER_RESILIENCE_V1";

function replaceOrThrow(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`PROVIDER_RESILIENCE_TARGET_MISSING:${label}`);
  return source.replace(before, after);
}

if (!fs.existsSync(file)) {
  throw new Error("V10_AI_WORKER_FINAL_MISSING");
}

let source = fs.readFileSync(file, "utf8");
if (!source.includes(marker)) {
  source = replaceOrThrow(
    source,
    'const VERSION = "v10_ai_quality_guard_v13"; // AIGUKA_PROVIDER_LOAD_BALANCER_V4',
    `const VERSION = "v10_ai_quality_guard_v14"; // AIGUKA_PROVIDER_LOAD_BALANCER_V4 // ${marker}`,
    "version",
  );

  source = replaceOrThrow(
    source,
    'const GEMINI_MIN_INTERVAL_MS = Math.max(30_000, Number(process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS || 60_000));',
    'const GEMINI_MIN_INTERVAL_MS = Math.max(3_000, Number(process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS || 5_000));',
    "gemini_interval",
  );

  source = replaceOrThrow(
    source,
    'ai_providers?select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled,updated_at,settings,connection_status,last_error&is_enabled=eq.true&order=updated_at.desc&limit=10',
    'ai_providers?select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled,updated_at,settings,connection_status,last_error&is_enabled=eq.true&order=updated_at.desc&limit=50',
    "provider_limit",
  );

  source = replaceOrThrow(
    source,
`function providerReadyAt(provider, now = Date.now()) {
  const health = healthFor(provider);
  let readyAt = Math.max(0, Number(health.disabledUntil || 0), Number(health.nextAllowedAt || 0));
  if (isGemini(provider)) readyAt = Math.max(readyAt, gemini.nextAllowedAt, gemini.cooldownUntil);
  return readyAt <= now ? now : readyAt;
}`,
`function providerReadyAt(provider, now = Date.now()) {
  const health = healthFor(provider);
  const settings = providerSettings(provider);
  const persistedCooldown = Date.parse(settings.runtime_cooldown_until || settings.cooldown_until || "");
  let readyAt = Math.max(0, Number(health.disabledUntil || 0), Number(health.nextAllowedAt || 0));
  if (Number.isFinite(persistedCooldown)) readyAt = Math.max(readyAt, persistedCooldown);
  return readyAt <= now ? now : readyAt;
}`,
    "provider_ready_at",
  );

  source = replaceOrThrow(
    source,
`  if (isGemini(provider) && classification === "rate_limit") {
    gemini.consecutive429 += 1;
    gemini.cooldownUntil = Math.max(gemini.cooldownUntil, health.disabledUntil);
    gemini.nextAllowedAt = Math.max(gemini.nextAllowedAt, gemini.cooldownUntil);
  }
}`,
`}`,
    "remove_global_gemini_failure",
  );

  source = replaceOrThrow(
    source,
`  if (isGemini(provider)) {
    gemini.consecutive429 = 0;
    gemini.cooldownUntil = 0;
    gemini.nextAllowedAt = health.nextAllowedAt;
  }
}`,
`}`,
    "remove_global_gemini_success",
  );

  source = replaceOrThrow(
    source,
    '        gemini_cooldown_until: gemini.cooldownUntil ? new Date(gemini.cooldownUntil).toISOString() : null,',
    '        gemini_cooldown_until: null,\n        provider_cooldown_is_per_key: true,',
    "heartbeat_cooldown",
  );

  const processMarker = 'async function processOne(row, availableProviders, knowledgeSnapshot) {';
  const persistenceHelpers = `async function persistProviderRuntimeState(provider, state, classification = null, error = null) {
  const current = providerSettings(provider);
  const health = healthFor(provider);
  const now = new Date().toISOString();
  const cooldownUntil = state === "cooldown" && health.disabledUntil > Date.now()
    ? new Date(health.disabledUntil).toISOString()
    : null;

  if (state === "ready"
      && provider.connection_status === "production_ready"
      && current.runtime_state !== "cooldown"
      && !current.runtime_cooldown_until
      && !provider.last_error) return;

  const settings = {
    ...current,
    runtime_state: state,
    runtime_error_class: state === "ready" ? null : classification,
    runtime_cooldown_until: cooldownUntil,
    runtime_auto_recover: true,
    runtime_state_updated_at: now,
  };
  const connectionStatus = state === "ready" ? "production_ready" : "cooldown";
  const lastError = state === "ready" ? null : String(error?.message || error || classification || "provider_cooldown").slice(0, 800);

  provider.settings = settings;
  provider.connection_status = connectionStatus;
  provider.last_error = lastError;

  await knowledge(\`ai_providers?provider_key=eq.\${encodeURIComponent(providerKey(provider))}\`, {
    method: "PATCH",
    prefer: "return=minimal",
    timeout: 10000,
    body: {
      connection_status: connectionStatus,
      last_error: lastError,
      settings,
      updated_at: now,
    },
  }).catch(() => {});
}

${processMarker}`;
  source = replaceOrThrow(source, processMarker, persistenceHelpers, "persistence_helpers");

  source = replaceOrThrow(
    source,
`        recordProviderSuccess(provider, Date.now() - callStartedAt, modelInputChars);
        providerCache.lastProviderKey = result.provider;`,
`        recordProviderSuccess(provider, Date.now() - callStartedAt, modelInputChars);
        await persistProviderRuntimeState(provider, "ready");
        providerCache.lastProviderKey = result.provider;`,
    "persist_success",
  );

  source = replaceOrThrow(
    source,
`        recordProviderFailure(provider, classification, error, modelInputChars);
        classifications.push(classification);`,
`        recordProviderFailure(provider, classification, error, modelInputChars);
        await persistProviderRuntimeState(provider, "cooldown", classification, error);
        classifications.push(classification);`,
    "persist_failure",
  );

  source += `\n// ${marker}\n`;
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] per-provider cooldown, immediate failover and automatic recovery enabled");
}
