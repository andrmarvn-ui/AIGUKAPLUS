import crypto from "node:crypto";
import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v10/core/decision-contract.js";
import { buildKnowledgeAdvisors } from "./v10/core/knowledge-advisor.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-ai";
const VERSION = "v10_ai_sovereign_scheduler_v2";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V10_AI_POLL_MS || 5000));
const LEASE_MS = Math.max(60_000, Number(process.env.AIGUKA_V10_AI_LEASE_MS || 90_000));
const MAX_DECISION_ERRORS = Math.max(3, Number(process.env.AIGUKA_V10_AI_MAX_DECISION_ERRORS || 5));
const GEMINI_MIN_INTERVAL_MS = Math.max(30_000, Number(process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS || 60_000));
const GEMINI_MIN_COOLDOWN_MS = Math.max(120_000, Number(process.env.AIGUKA_GEMINI_FREE_MIN_COOLDOWN_MS || 120_000));
const GEMINI_MAX_COOLDOWN_MS = Math.max(GEMINI_MIN_COOLDOWN_MS, Number(process.env.AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS || 300_000));
const OPENAI_CREDIT_COOLDOWN_MS = Math.max(30 * 60_000, Number(process.env.AIGUKA_OPENAI_CREDIT_COOLDOWN_MS || 6 * 60 * 60_000));
const ARCHITECTURE = "v10_ai_sovereign_advisory";

let running = false;
let timer;
let providerCache = { expiresAt: 0, rows: [], lastProviderKey: null };
let knowledgeCache = { expiresAt: 0, snapshot: null };
const providerHealth = new Map();
const gemini = { nextAllowedAt: 0, cooldownUntil: 0, consecutive429: 0 };

async function request(base, key, path, options = {}) {
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 30000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`);
  return data;
}

const core = (path, options = {}) => request(CORE_BASE, CORE_KEY, path, options);
const knowledge = (path, options = {}) => request(KNOWLEDGE_BASE, KNOWLEDGE_KEY, path, options);

function providerKey(provider = {}) {
  return String(provider.provider_key || provider.provider_type || "unknown");
}

function providerName(provider = {}) {
  return providerKey(provider).toLowerCase();
}

function isGemini(provider = {}) {
  return providerName(provider).includes("gemini");
}

function healthFor(provider = {}) {
  const key = providerKey(provider);
  if (!providerHealth.has(key)) providerHealth.set(key, { disabledUntil: 0, reason: null, failures: 0 });
  return providerHealth.get(key);
}

function decryptProviderKey(value) {
  const [iv, tag, body] = String(value || "").split(".");
  if (!iv || !tag || !body) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
  const key = crypto.createHash("sha256").update(`${KNOWLEDGE_KEY}|${KNOWLEDGE_BASE}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

async function providers() {
  if (providerCache.rows.length && providerCache.expiresAt > Date.now()) return providerCache.rows;
  const rows = await knowledge("ai_providers?select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled,updated_at&is_enabled=eq.true&order=updated_at.desc&limit=10", { timeout: 10000 });
  const usable = (rows || []).filter((row) => row?.api_key_ciphertext);
  usable.sort((a, b) => Number(!isGemini(a)) - Number(!isGemini(b)));
  if (!usable.length) throw new Error("V10_AI_PROVIDER_NOT_READY");
  providerCache = { rows: usable, expiresAt: Date.now() + 60_000, lastProviderKey: providerCache.lastProviderKey };
  return usable;
}

async function publishedKnowledge() {
  if (knowledgeCache.snapshot && knowledgeCache.expiresAt > Date.now()) return knowledgeCache.snapshot;
  const configs = await knowledge("ai_runtime_config?select=mode,published_snapshot_id,cache_ttl_seconds&id=eq.1&limit=1", { timeout: 10000 });
  const config = configs?.[0];
  if (!config || config.mode === "OFF") throw new Error("V10_KNOWLEDGE_DISABLED");
  if (!config.published_snapshot_id) throw new Error("V10_KNOWLEDGE_SNAPSHOT_NOT_PUBLISHED");
  const rows = await knowledge(`ai_published_snapshots?select=id,version_no,checksum,content,status&id=eq.${encodeURIComponent(config.published_snapshot_id)}&status=eq.published&limit=1`, { timeout: 15000 });
  const snapshot = rows?.[0];
  if (!snapshot?.content) throw new Error("V10_KNOWLEDGE_SNAPSHOT_NOT_FOUND");
  const ttl = Math.max(30_000, Math.min(3_600_000, Number(config.cache_ttl_seconds || 300) * 1000));
  knowledgeCache = { snapshot, expiresAt: Date.now() + ttl };
  return snapshot;
}

function parseChatDecision(payload) {
  const message = payload?.choices?.[0]?.message || {};
  for (const item of message.tool_calls || []) {
    if (item?.function?.name === "submit_v10_decision") return JSON.parse(item.function.arguments || "{}");
  }
  const text = Array.isArray(message.content) ? message.content.map((item) => item?.text || "").join("") : String(message.content || "");
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) return JSON.parse(cleaned);
  throw new Error("V10_CHAT_MODEL_DID_NOT_SUBMIT_DECISION");
}

function parseResponsesDecision(payload) {
  for (const item of payload?.output || []) {
    if (item?.type === "function_call" && item?.name === "submit_v10_decision") return JSON.parse(item.arguments || "{}");
  }
  throw new Error("V10_MODEL_DID_NOT_SUBMIT_DECISION");
}

function providerReadyAt(provider, now = Date.now()) {
  const health = healthFor(provider);
  let readyAt = Math.max(0, Number(health.disabledUntil || 0));
  if (isGemini(provider)) readyAt = Math.max(readyAt, gemini.nextAllowedAt, gemini.cooldownUntil);
  return Math.max(now, readyAt);
}

function providerAvailability(providerRows, now = Date.now()) {
  const available = [];
  let nextAvailableAt = Number.POSITIVE_INFINITY;
  for (const provider of providerRows || []) {
    const readyAt = providerReadyAt(provider, now);
    if (readyAt <= now) available.push(provider);
    else nextAvailableAt = Math.min(nextAvailableAt, readyAt);
  }
  return {
    available,
    nextAvailableAt: Number.isFinite(nextAvailableAt) ? nextAvailableAt : now + 60_000,
  };
}

function classifyProviderError(provider, error) {
  const text = String(error?.message || error).toLowerCase();
  if (/429|resource exhausted|quota|rate limit|too many requests/.test(text)) return "rate_limit";
  if (/no credits remaining|add credits|insufficient_quota|billing/.test(text)) return "no_credit";
  if (/timeout|temporar|unavailable|503|502|504|network|fetch failed/.test(text)) return "transient";
  if (/invalid schema|did not submit|json|decision_invalid|action_invalid|final_reply_required/.test(text)) return "decision_error";
  return "provider_error";
}

function recordProviderFailure(provider, classification) {
  const health = healthFor(provider);
  health.failures += 1;
  health.reason = classification;
  const now = Date.now();
  if (classification === "no_credit") {
    health.disabledUntil = now + OPENAI_CREDIT_COOLDOWN_MS;
  } else if (classification === "transient") {
    health.disabledUntil = now + Math.min(5 * 60_000, 30_000 * Math.max(1, health.failures));
  } else if (classification === "provider_error") {
    health.disabledUntil = now + 60_000;
  }
  if (isGemini(provider) && classification === "rate_limit") {
    gemini.consecutive429 += 1;
    const cooldown = Math.min(GEMINI_MAX_COOLDOWN_MS, GEMINI_MIN_COOLDOWN_MS * (2 ** Math.max(0, gemini.consecutive429 - 1)));
    gemini.cooldownUntil = now + cooldown;
    gemini.nextAllowedAt = Math.max(gemini.nextAllowedAt, gemini.cooldownUntil);
    health.disabledUntil = Math.max(health.disabledUntil, gemini.cooldownUntil);
  }
}

function recordProviderSuccess(provider) {
  const health = healthFor(provider);
  health.failures = 0;
  health.reason = null;
  health.disabledUntil = 0;
  if (isGemini(provider)) {
    gemini.consecutive429 = 0;
    gemini.cooldownUntil = 0;
    gemini.nextAllowedAt = Date.now() + GEMINI_MIN_INTERVAL_MS;
  }
}

async function providerCall(provider, modelInput) {
  const apiKey = decryptProviderKey(provider.api_key_ciphertext);
  if (isGemini(provider)) {
    let base = String(provider.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    if (!/\/openai$/i.test(base)) base = `${base}/openai`;
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: provider.model_name,
        messages: [
          { role: "system", content: buildDecisionInstructions() },
          { role: "user", content: JSON.stringify(modelInput) },
        ],
        tools: [{ type: "function", function: { name: "submit_v10_decision", description: "Submit the sole AI business decision", parameters: decisionSchema() } }],
        tool_choice: "required",
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `GEMINI_HTTP_${response.status}`);
    return { decision: parseChatDecision(payload), responseId: payload.id || null, model: provider.model_name, provider: providerKey(provider) };
  }

  const endpoint = `${String(provider.base_url || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: provider.model_name,
      instructions: buildDecisionInstructions(),
      tools: [{ type: "function", name: "submit_v10_decision", strict: true, description: "Submit the sole AI business decision", parameters: decisionSchema() }],
      tool_choice: "required",
      parallel_tool_calls: false,
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(modelInput) }] }],
    }),
    signal: AbortSignal.timeout(55_000),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
  if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `OPENAI_HTTP_${response.status}`);
  return { decision: parseResponsesDecision(payload), responseId: payload.id || null, model: provider.model_name, provider: providerKey(provider) };
}

function processingAttempts(row) {
  return Math.max(0, Number(row?.output?.processing_attempts || 0));
}

function decisionErrors(row) {
  return Math.max(0, Number(row?.output?.decision_errors || 0));
}

async function recoverStaleProcessing() {
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();
  const stale = await core(`v9_decisions?select=id,output,input_snapshot,updated_at&status=eq.shadow_ai_processing&updated_at=lt.${encodeURIComponent(cutoff)}&order=updated_at.asc&limit=100`);
  let reset = 0;
  for (const row of stale || []) {
    if (row?.input_snapshot?.architecture !== ARCHITECTURE) continue;
    await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_ai_processing`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_context_ready",
        output: {
          ...(row.output || {}),
          should_send: false,
          transport_locked: true,
          processing_attempts: Math.max(0, processingAttempts(row) - 1),
          last_error: "AI_PROCESSING_LEASE_EXPIRED",
          retry_not_before: new Date(Date.now() + 30_000).toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
    });
    reset += 1;
  }
  return { stale: stale?.length || 0, reset };
}

async function scheduleWithoutClaim(row, retryAt, reason) {
  await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_context_ready`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      output: {
        ...(row.output || {}),
        should_send: false,
        transport_locked: true,
        provider_wait_reason: reason,
        retry_not_before: new Date(Math.max(Date.now() + 5_000, retryAt)).toISOString(),
      },
      updated_at: new Date().toISOString(),
    },
  });
}

async function claim(row) {
  const claimed = await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_context_ready`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "shadow_ai_processing",
      output: {
        ...(row.output || {}),
        should_send: false,
        transport_locked: true,
        processing_attempts: processingAttempts(row) + 1,
        processing_started_at: new Date().toISOString(),
        processing_worker: NAME,
      },
      updated_at: new Date().toISOString(),
    },
  });
  return claimed?.[0] || null;
}

async function retryDecision(row, error, options = {}) {
  const classification = options.classification || "provider_error";
  const consumeDecisionError = classification === "decision_error";
  const errors = decisionErrors(row) + (consumeDecisionError ? 1 : 0);
  const attempts = options.consumeAttempt === false ? Math.max(0, processingAttempts(row) - 1) : processingAttempts(row);
  if (errors >= MAX_DECISION_ERRORS) {
    await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_ai_processing`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_ai_error",
        action: "ai_review_required",
        output: {
          ...(row.output || {}),
          should_send: false,
          transport_locked: true,
          processing_attempts: attempts,
          decision_errors: errors,
          last_error: String(error?.message || error).slice(0, 800),
          ai_review_required: true,
        },
        updated_at: new Date().toISOString(),
      },
    });
    return "review_required";
  }

  const retryAt = Number(options.retryAt || Date.now() + 60_000);
  await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_ai_processing`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "shadow_context_ready",
      output: {
        ...(row.output || {}),
        should_send: false,
        transport_locked: true,
        processing_attempts: attempts,
        decision_errors: errors,
        last_error: String(error?.message || error).slice(0, 800),
        retry_not_before: new Date(Math.max(Date.now() + 5_000, retryAt)).toISOString(),
      },
      updated_at: new Date().toISOString(),
    },
  });
  return "retry";
}

async function processOne(row, availableProviders, knowledgeSnapshot) {
  const claimed = await claim(row);
  if (!claimed) return { processed: 0, retried: 0, reviewRequired: 0, providerErrors: [] };
  const conversation = claimed.input_snapshot?.conversation || {};
  const knowledgeAdvisors = buildKnowledgeAdvisors(knowledgeSnapshot, conversation, { maxDocuments: 8, maxCatalog: 12, maxAssetsPerCatalog: 6 });
  const modelInput = {
    architecture: ARCHITECTURE,
    authority: {
      ai_is_sole_business_decision_maker: true,
      rules_mapping_catalog_locks_are_advisory_only: true,
      hard_safety_already_applied: true,
    },
    conversation,
    customer: claimed.input_snapshot?.customer || {},
    state: claimed.input_snapshot?.state || {},
    knowledge_advisors: knowledgeAdvisors,
  };
  const providerErrors = [];
  const classifications = [];
  const startedAt = Date.now();

  try {
    let result = null;
    for (const provider of availableProviders) {
      try {
        result = await providerCall(provider, modelInput);
        recordProviderSuccess(provider);
        providerCache.lastProviderKey = result.provider;
        break;
      } catch (error) {
        const classification = classifyProviderError(provider, error);
        recordProviderFailure(provider, classification);
        classifications.push(classification);
        providerErrors.push(`${providerKey(provider)}:${String(error?.message || error).slice(0, 300)}`);
      }
    }
    if (!result) throw new Error(providerErrors.join(" | ") || "V10_ALL_AVAILABLE_PROVIDERS_FAILED");
    const decision = validateDecision(result.decision);
    await core(`v9_decisions?id=eq.${claimed.id}&status=eq.shadow_ai_processing`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_ai_completed",
        action: decision.action,
        confidence: decision.confidence,
        knowledge_version: `${knowledgeSnapshot.version_no}:${knowledgeSnapshot.checksum}`,
        latency_ms: Date.now() - startedAt,
        output: {
          ...decision,
          should_send: decision.action !== "suppress",
          transport_locked: true,
          provider_key: result.provider,
          model: result.model,
          response_id: result.responseId,
          provider_errors: providerErrors,
          processing_attempts: processingAttempts(claimed),
          decision_errors: decisionErrors(claimed),
          architecture: ARCHITECTURE,
          advisors_were_non_binding: true,
          knowledge_snapshot: { id: knowledgeSnapshot.id, version_no: knowledgeSnapshot.version_no, checksum: knowledgeSnapshot.checksum },
        },
        updated_at: new Date().toISOString(),
      },
    });
    return { processed: 1, retried: 0, reviewRequired: 0, providerErrors };
  } catch (error) {
    const transientOnly = classifications.length > 0 && classifications.every((value) => ["rate_limit", "no_credit", "transient", "provider_error"].includes(value));
    const classification = classifications.includes("decision_error") ? "decision_error" : (classifications[0] || "provider_error");
    const next = providerAvailability(providerCache.rows, Date.now()).nextAvailableAt;
    const outcome = await retryDecision(claimed, error, {
      classification,
      consumeAttempt: !transientOnly,
      retryAt: next,
    });
    return {
      processed: 0,
      retried: outcome === "retry" ? 1 : 0,
      reviewRequired: outcome === "review_required" ? 1 : 0,
      providerErrors,
    };
  }
}

function providerHealthSnapshot() {
  return [...providerHealth.entries()].map(([key, health]) => ({
    provider: key,
    disabled_until: health.disabledUntil ? new Date(health.disabledUntil).toISOString() : null,
    reason: health.reason,
    failures: health.failures,
  }));
}

async function heartbeat(status, error = null, details = {}) {
  const configs = await core("v9_runtime_config?select=mode&id=eq.1&limit=1").catch(() => []);
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: configs?.[0]?.mode || "OFF",
      details: {
        ...details,
        ai_decision_authority: "sole",
        advisor_authority: "non_binding",
        batch_size: 1,
        lease_ms: LEASE_MS,
        gemini_min_interval_ms: GEMINI_MIN_INTERVAL_MS,
        gemini_cooldown_until: gemini.cooldownUntil ? new Date(gemini.cooldownUntil).toISOString() : null,
        provider_health: providerHealthSnapshot(),
      },
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function tick() {
  if (!CORE_BASE || !CORE_KEY || !KNOWLEDGE_BASE || !KNOWLEDGE_KEY || running) return;
  running = true;
  let processed = 0;
  let retried = 0;
  let reviewRequired = 0;
  let providerErrorCount = 0;
  let providerWait = false;
  let recovery = { stale: 0, reset: 0 };
  try {
    recovery = await recoverStaleProcessing();
    const rows = await core("v9_decisions?select=id,input_snapshot,output,status,created_at,updated_at&status=eq.shadow_context_ready&order=created_at.asc&limit=50");
    const now = Date.now();
    const ready = (rows || []).filter((row) => {
      if (row?.input_snapshot?.architecture !== ARCHITECTURE) return false;
      const retryAt = Date.parse(row?.output?.retry_not_before || "");
      return !Number.isFinite(retryAt) || retryAt <= now;
    });

    if (ready.length) {
      const providerRows = await providers();
      const availability = providerAvailability(providerRows, now);
      if (!availability.available.length) {
        providerWait = true;
        await scheduleWithoutClaim(ready[0], availability.nextAvailableAt, "NO_AI_PROVIDER_CURRENTLY_AVAILABLE");
      } else {
        const snapshot = await publishedKnowledge();
        const result = await processOne(ready[0], availability.available, snapshot);
        processed += result.processed;
        retried += result.retried;
        reviewRequired += result.reviewRequired;
        providerErrorCount += result.providerErrors.length;
      }
    }

    const backlog = (rows || []).filter((row) => row?.input_snapshot?.architecture === ARCHITECTURE).length;
    const degraded = recovery.stale > 0 || retried > 0 || reviewRequired > 0 || providerErrorCount > 0 || providerWait || backlog > 10;
    await heartbeat(degraded ? "degraded" : "healthy", degraded ? `recovered=${recovery.stale}, retried=${retried}, review=${reviewRequired}, provider_wait=${providerWait}, provider_errors=${providerErrorCount}, backlog=${backlog}` : null, {
      processed_last_tick: processed,
      retried_last_tick: retried,
      ai_review_required_last_tick: reviewRequired,
      stale_processing_found: recovery.stale,
      stale_processing_reset: recovery.reset,
      ready_backlog: backlog,
      provider_wait: providerWait,
      provider_errors_last_tick: providerErrorCount,
      provider_key: providerCache.lastProviderKey,
      provider_priority: providerCache.rows.map((row) => providerKey(row)),
      transport_locked_at_decision_stage: true,
      operational_fallback_enabled: false,
    });
  } catch (error) {
    await heartbeat("degraded", error?.message || error, {
      processed_last_tick: processed,
      stale_processing_found: recovery.stale,
      operational_fallback_enabled: false,
      transport_locked_at_decision_stage: true,
    }).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!CORE_BASE || !CORE_KEY || !KNOWLEDGE_BASE || !KNOWLEDGE_KEY) {
  console.warn("[AIGUKA V10 AI v2] Core or Knowledge configuration missing; disabled");
} else {
  console.log("[AIGUKA V10 AI v2] provider-aware scheduler started; AI sole decision; no operational customer fallback");
  tick().catch(() => {});
}
