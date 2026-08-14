import crypto from "node:crypto";
import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v10/core/decision-contract.js";
import { buildKnowledgeAdvisors } from "./v10/core/knowledge-advisor.js";
import { deriveUnresolvedNeeds } from "./v10/core/unresolved-needs.js";
import { deriveProductThreads } from "./v10/core/product-threads.js";
import { deriveMediaScope, explicitMediaRequestFromMessages, mediaExpectedFromMessages } from "./v10/core/media-obligation.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-ai";
const VERSION = "v10_ai_product_threads_v19"; // AIGUKA_PROVIDER_LOAD_BALANCER_V4 // AIGUKA_PROVIDER_RESILIENCE_V1
const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_V10_AI_POLL_MS || 3000));
const BATCH_SIZE = Math.max(1, Math.min(4, Number(process.env.AIGUKA_V10_AI_BATCH_SIZE || 3)));
const PROVIDER_CACHE_MS = Math.max(3000, Number(process.env.AIGUKA_V10_PROVIDER_CACHE_MS || 5000));
const RATE_LIMIT_MAX_COOLDOWN_MS = Math.max(15 * 60_000, Number(process.env.AIGUKA_PROVIDER_RATE_LIMIT_MAX_COOLDOWN_MS || 6 * 60 * 60_000));
const DECISION_ERROR_COOLDOWN_MS = Math.max(60_000, Number(process.env.AIGUKA_PROVIDER_DECISION_ERROR_COOLDOWN_MS || 5 * 60_000));
const LEASE_MS = Math.max(60_000, Number(process.env.AIGUKA_V10_AI_LEASE_MS || 90_000));
const MAX_DECISION_ERRORS = Math.max(3, Number(process.env.AIGUKA_V10_AI_MAX_DECISION_ERRORS || 5));
const GEMINI_MIN_INTERVAL_MS = Math.max(3_000, Number(process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS || 5_000));
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
  const type = String(provider?.provider_type || "").trim().toLowerCase();
  const key = providerName(provider);
  return type === "gemini" || type.includes("gemini") || key.includes("gemini") || key === "google" || key === "gemma";
}

// AIGUKA_V10_GEMINI_PROVIDER_TYPE_V1

function providerSettings(provider = {}) {
  return provider?.settings && typeof provider.settings === "object" ? provider.settings : {};
}

function providerPriority(provider = {}) {
  const value = Number(providerSettings(provider).runtime_order ?? 100);
  return Number.isFinite(value) ? Math.max(1, value) : 100;
}

function providerWeight(provider = {}) {
  const configured = Number(providerSettings(provider).runtime_weight);
  if (Number.isFinite(configured) && configured > 0) return Math.max(0.1, Math.min(20, configured));
  return 1;
}

function providerMinIntervalMs(provider = {}) {
  const configured = Number(providerSettings(provider).min_interval_ms);
  if (Number.isFinite(configured) && configured >= 0) return Math.min(10 * 60_000, configured);
  if (isGemini(provider)) return GEMINI_MIN_INTERVAL_MS;
  const name = providerName(provider);
  if (name.includes("nvidia")) return 1500;
  return 250;
}

function providerTimeoutMs(provider = {}) {
  const configured = Number(providerSettings(provider).request_timeout_ms);
  if (Number.isFinite(configured) && configured >= 3000) return Math.min(55_000, configured);
  const name = providerName(provider);
  if (name.includes("groq")) return 10_000;
  if (name.includes("nvidia")) return 30_000;
  if (isGemini(provider)) return 20_000;
  return 20_000;
}

function parseRetryAfterMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, seconds * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, at - Date.now())) : 0;
}

function providerHttpError(response, payload, fallback) {
  const message = payload?.error?.message || payload?.message || payload?.error_description || fallback;
  const error = new Error(String(message || fallback));
  error.status = Number(response?.status || 0);
  error.code = String(payload?.error?.code || payload?.error?.type || payload?.code || "");
  error.retryAfterMs = parseRetryAfterMs(response?.headers?.get?.("retry-after"));
  return error;
}

function healthFor(provider = {}) {
  const key = providerKey(provider);
  if (!providerHealth.has(key)) providerHealth.set(key, {
    disabledUntil: 0,
    nextAllowedAt: 0,
    reason: null,
    failures: 0,
    rateLimitFailures: 0,
    decisionFailures: 0,
    contextLimitChars: 0,
    successes: 0,
    ewmaLatencyMs: 0,
    currentWeight: 0,
    lastSelectedAt: 0,
  });
  return providerHealth.get(key);
}

function weightedProviderOrder(pool = [], now = Date.now()) {
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

function providerIsStrictLastResort(provider = {}) {
  const role = String(providerSettings(provider).quality_role || "").trim().toLowerCase();
  return role === "penultimate_last_resort" || role === "absolute_last_resort";
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
  const regularPool = pool.filter((provider) => !providerIsStrictLastResort(provider));
  const strictLastResortPool = pool
    .filter((provider) => providerIsStrictLastResort(provider))
    .sort((a, b) => providerPriority(a) - providerPriority(b) || providerKey(a).localeCompare(providerKey(b)));
  const googlePrimary = regularPool.filter((provider) => isGemini(provider));
  const fallback = regularPool.filter((provider) => !isGemini(provider));
  return [
    ...weightedProviderOrder(googlePrimary, now),
    ...weightedProviderOrder(fallback, now),
    ...strictLastResortPool,
  ];
}

// AIGUKA_V10_GOOGLE_PRIMARY_POOL_V1
// AIGUKA_V10_STRICT_LAST_RESORT_PROVIDER_POOL_V1

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
  const rows = await knowledge("ai_providers?select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled,updated_at,settings,connection_status,last_error&is_enabled=eq.true&order=updated_at.desc&limit=50", { timeout: 10000 });
  const usable = (rows || []).filter((row) => row?.api_key_ciphertext && row?.connection_status !== "error");
  if (!usable.length) throw new Error("V10_AI_PROVIDER_NOT_READY");
  providerCache = { rows: usable, expiresAt: Date.now() + PROVIDER_CACHE_MS, lastProviderKey: providerCache.lastProviderKey };
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
  const settings = providerSettings(provider);
  const persistedCooldown = Date.parse(settings.runtime_cooldown_until || settings.cooldown_until || "");
  let readyAt = Math.max(0, Number(health.disabledUntil || 0), Number(health.nextAllowedAt || 0));
  if (Number.isFinite(persistedCooldown)) readyAt = Math.max(readyAt, persistedCooldown);
  return readyAt <= now ? now : readyAt;
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
  const text = (String(error?.code || "") + " " + String(error?.message || error)).toLowerCase();
  const status = Number(error?.status || 0);
  if (status === 413 || /context_length|context window|prompt tokens limit|max.*context|token_limit_exceeded|string_too_long|request entity too large|request body too large/.test(text)) return "context_limit";
  if (status === 401 || status === 403 || /invalid api key|authentication|permission denied|forbidden/.test(text)) return "auth_error";
  if (status === 429 || status === 498 || /resource exhausted|quota|rate limit|too many requests|capacity exceeded|tokens per minute|requests per minute|\btpm\b|\brpm\b|\brpd\b|\btpd\b/.test(text)) return "rate_limit";
  if (status === 402 || /no credits remaining|add credits|insufficient balance|insufficient_quota|payment required/.test(text)) return "no_credit";
  if ([408, 424, 499, 500, 502, 503, 504].includes(status) || /timeout|temporar|unavailable|overloaded|network|fetch failed/.test(text)) return "transient";
  if (/invalid schema|did[_ ]not[_ ]submit|tool[._ ]call|json|decision_invalid|action_invalid|final_reply_required/.test(text)) return "decision_error";
  return "provider_error";
}

function recordProviderFailure(provider, classification, error = null, inputChars = 0) {
  const health = healthFor(provider);
  health.failures += 1;
  health.reason = classification;
  const now = Date.now();
  const retryAfter = Math.max(0, Number(error?.retryAfterMs || 0));
  if (classification === "context_limit") {
    if (inputChars > 0) health.contextLimitChars = health.contextLimitChars > 0 ? Math.min(health.contextLimitChars, inputChars) : inputChars;
    health.nextAllowedAt = Math.max(health.nextAllowedAt, now + 5000);
    return;
  }
  if (classification === "rate_limit") {
    health.rateLimitFailures += 1;
    const steps = isGemini(provider)
      ? [2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000]
      : [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
    const adaptive = steps[Math.min(steps.length - 1, health.rateLimitFailures - 1)];
    const jitter = isGemini(provider) ? Math.floor(Math.random() * 1_000) : 0;
    health.disabledUntil = now + Math.min(RATE_LIMIT_MAX_COOLDOWN_MS, Math.max(retryAfter, adaptive + jitter));
  } else if (classification === "no_credit") {
    health.disabledUntil = now + OPENAI_CREDIT_COOLDOWN_MS;
  } else if (classification === "auth_error") {
    health.disabledUntil = now + 24 * 60 * 60_000;
  } else if (classification === "decision_error") {
    health.decisionFailures += 1;
    health.disabledUntil = now + Math.min(DECISION_ERROR_COOLDOWN_MS, 30_000 * (2 ** Math.min(4, health.decisionFailures - 1)));
  } else if (classification === "transient") {
    health.disabledUntil = now + Math.min(5 * 60_000, 15_000 * (2 ** Math.min(4, health.failures - 1)));
  } else {
    health.disabledUntil = now + Math.min(5 * 60_000, 30_000 * Math.max(1, health.failures));
  }
}

function recordProviderSuccess(provider, latencyMs = 0, inputChars = 0) {
  const health = healthFor(provider);
  health.failures = 0;
  health.rateLimitFailures = 0;
  health.decisionFailures = 0;
  if (inputChars > 0 && health.contextLimitChars > 0 && inputChars >= health.contextLimitChars) health.contextLimitChars = 0;
  health.reason = null;
  health.disabledUntil = 0;
  health.successes += 1;
  if (Number.isFinite(latencyMs) && latencyMs > 0) {
    health.ewmaLatencyMs = health.ewmaLatencyMs > 0 ? Math.round(health.ewmaLatencyMs * 0.75 + latencyMs * 0.25) : Math.round(latencyMs);
  }
  health.nextAllowedAt = Date.now() + providerMinIntervalMs(provider);
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
        ...(providerName(provider) === "gemma" ? {} : { reasoning_effort: "none" }),
      }),
      signal: AbortSignal.timeout(providerTimeoutMs(provider)),
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
    if (!response.ok || payload?.error) throw providerHttpError(response, payload, `GEMINI_HTTP_${response.status}`);
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
    signal: AbortSignal.timeout(providerTimeoutMs(provider)),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
  if (!response.ok || payload?.error) throw providerHttpError(response, payload, `OPENAI_HTTP_${response.status}`);
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


function qualityNormalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s/+_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DECISION_LEAK_PATTERN = /(selected_catalog_keys|selected_products|final_reply|decision_reason|needs_slides|follow_up_plan|tool[_ .-]?call|system prompt|schema|not a valid key|we need|customer mentioned|provide concise|keep reply|internal reasoning|analysis:|assistant to=|developer message|hidden instruction|zddw)/i;
const DECISION_GIBBERISH_PATTERN = /[ŏŎ]|\b(showoom|bèn em|phó keo|gia làm|nŏii)\b/i;

function customerMessagesFrom(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  return messages.filter(function (message) { return message && message.role === "customer"; });
}

function salutationStyle(modelInput) {
  const recent = customerMessagesFrom(modelInput).slice(-12).map(function (message) { return String(message.text || ""); }).join(" \n");
  const normalized = qualityNormalize(recent);
  const customer = modelInput && modelInput.customer ? modelInput.customer : {};
  const preferred = qualityNormalize(customer.preferred_salutation || "");

  function selfRef(term) {
    const firstPersonVerbs = "(?:dang|dag|muon|can|hoi|xem|mua|lay|dat|o|ranh|danh|co nhu cau|quan tam|xin|nhan)";
    const startsSentence = new RegExp("(?:^|[.!?\\n]\\s*)" + term + "\\s+" + firstPersonVerbs + "\\b", "i");
    const addressedAction = new RegExp("\\b(?:goi|gui|nhan|bao|tu van).{0,24}\\bcho\\s+" + term + "\\b", "i");
    return startsSentence.test(normalized) || addressedAction.test(normalized);
  }

  if (selfRef("co") || preferred === "co") return { customer: "cô", self: "cháu" };
  if (selfRef("chu") || preferred === "chu") return { customer: "chú", self: "cháu" };
  if (selfRef("bac") || preferred === "bac") return { customer: "bác", self: "cháu" };
  if (selfRef("chi") || preferred === "chi") return { customer: "chị", self: "em" };
  if (selfRef("anh") || preferred === "anh") return { customer: "anh", self: "em" };
  return { customer: "anh/chị", self: "em" };
}

// AIGUKA_V10_DECISION_INTEGRITY_V6

function cleanProviderMarkup(value) {
  return String(value || "")
    .replace(/<co>/gi, "")
    .replace(/<\/co(?:\s*:\s*[^>]*)?>/gi, "")
    .replace(/<[^>]{1,120}>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// AIGUKA_V10_DECISION_INTEGRITY_V5

function applySalutation(value, style) {
  let text = cleanProviderMarkup(value);
  if (!text) return text;
  if (["cô", "chú", "bác"].includes(style.customer)) {
    text = text
      .replace(/\banh\s*\/\s*chị\b/gi, style.customer)
      .replace(/\banh chị\b/gi, style.customer)
      .replace(/\bchị\b/gi, style.customer)
      .replace(/\banh\b/gi, style.customer)
      .replace(/\bbên em\b/gi, "bên " + style.self)
      .replace(/\bem\b/gi, style.self);
    if (!(new RegExp("\\b" + style.customer + "\\b", "i")).test(text)) {
      text = "Dạ " + style.customer + ", " + text.charAt(0).toLocaleLowerCase("vi-VN") + text.slice(1);
    }
  } else if (style.customer === "chị") {
    text = text.replace(/\banh\s*\/\s*chị\b/gi, "chị").replace(/\banh chị\b/gi, "chị");
  } else if (style.customer === "anh") {
    text = text.replace(/\banh\s*\/\s*chị\b/gi, "anh").replace(/\banh chị\b/gi, "anh");
  } else {
    text = text
      .replace(/\bAnh đang\b/g, "Anh/chị đang")
      .replace(/\bChị đang\b/g, "Anh/chị đang")
      .replace(/\bem gửi anh\b/gi, "em gửi anh/chị")
      .replace(/\bem gửi chị\b/gi, "em gửi anh/chị");
  }
  if (style.customer === "anh/chị") {
    const placeholder = "__AIGUKA_CUSTOMER__";
    text = text
      .replace(/anh\s*\/\s*chị/gi, placeholder)
      .replace(/\banh\b/gi, "anh/chị")
      .replace(/\bchị\b/gi, "anh/chị")
      .replace(new RegExp(placeholder, "g"), "anh/chị");
  }
  text = text
    .replace(/anh\s*\/\s*chị(?:\s*\/\s*(?:anh|chị))+/gi, "anh/chị")
    .replace(/\b(cô|chú|bác|chị|anh)(?:\s*\/\s*\1)+\b/gi, "$1")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([.!?])\s+([a-zà-ỹđ])/g, function (_match, punctuation, letter) { return punctuation + " " + letter.toLocaleUpperCase("vi-VN"); });
  if (text) text = text.charAt(0).toLocaleUpperCase("vi-VN") + text.slice(1);
  return text;
}

function contactIsKnown(modelInput) {
  const state = modelInput && modelInput.state ? modelInput.state : {};
  const customer = modelInput && modelInput.customer ? modelInput.customer : {};
  return Boolean(state.phone || state.zalo || customer.phone || customer.zalo || ["captured", "verified", "known"].includes(String(state.contact_status || "").toLowerCase()));
}

function exactCatalogContext(modelInput) {
  const advisor = modelInput && modelInput.knowledge_advisors ? modelInput.knowledge_advisors : {};
  const catalog = Array.isArray(advisor.catalog) ? advisor.catalog : [];
  const allowed = new Map();
  for (const item of catalog) {
    const key = String(item && item.catalog_key || "").trim();
    if (key) allowed.set(key, item);
  }
  const slideSource = Array.isArray(advisor.slide_catalog)
    ? advisor.slide_catalog
    : catalog.filter(function (item) { return Number(item && item.asset_count || 0) > 0; });
  const slide = new Set(slideSource.map(function (item) { return String(item && item.catalog_key || "").trim(); }).filter(Boolean));
  return { allowed: allowed, slide: slide };
}

function canonicalCatalogKey(value, allowed) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 100 || DECISION_LEAK_PATTERN.test(raw)) return "";
  const clean = raw.replace(/^[\s\[\]\x60'\"]+|[\s\[\]\x60'\".,;:]+$/g, "");
  return allowed.has(clean) ? clean : "";
}

function latestExplicitText(modelInput) {
  const messages = customerMessagesFrom(modelInput);
  const latest = messages.length ? messages[messages.length - 1] : null;
  return qualityNormalize(latest && latest.text || "");
}

function activeProductText(modelInput) {
  return currentCustomerClusterText(modelInput);
}

function scopedSlideKeys(modelInput, slideKeys) {
  const latest = latestExplicitText(modelInput);
  const active = activeProductText(modelInput);
  const output = [];
  function key(value) { return slideKeys.has(value) ? value : null; }
  function add() {
    for (const value of arguments) {
      if (value && !output.includes(value)) output.push(value);
    }
  }

  const sink = /\b(chau|voi rua|bon rua|rua bat|rua chen)\b/.test(latest);
  const stove = /\b(bep tu|hut mui|may hut|hut khoi)\b/.test(latest);
  const broadKitchen = /\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|toan bo.{0,20}bep|bep an)\b/.test(latest || active);
  const bathroom = /\b(phong tam|nha tam|nha ve sinh|thiet bi ve sinh|combo.{0,10}(tam|ve sinh))\b/.test(latest || active);
  const toilet = /\b(bon cau|bet lien khoi|bet thong minh)\b/.test(latest);
  const fan = /\b(quat tran|quat 10(?: canh)?|quat 8(?: canh)?|quat 5(?: canh)?|quat 6(?: canh)?)\b/.test(latest || active);

  if (sink) add(key("chau_voi_rua_bat"));
  else if (stove) add(key("bep_tu_hut_mui"), key("bep_tu"), key("may_hut_mui"));
  else if (broadKitchen) add(key("bep_tu_hut_mui"), key("chau_voi_rua_bat"));

  if (toilet) add(key("bon_cau"), key("bon_cau_lien_khoi"), key("bon_cau_thong_minh"));
  else if (bathroom) add(key("combo_phong_tam_ban_chay"), key("combo_phong_tam_dep_moi"), key("combo_phong_tam"));

  if (fan) add(key("quat_10_canh_gold"), key("quat_10_canh_wood"), key("quat_10_canh_black"), key("quat_10_canh_brown"), key("quat_tran"));
  return output;
}

function verifiedKnowledgeText(modelInput) {
  const advisors = modelInput && modelInput.knowledge_advisors ? modelInput.knowledge_advisors : {};
  return qualityNormalize(JSON.stringify(advisors));
}

function unsupportedPriceReply(reply, modelInput) {
  const priceMatches = String(reply || "").match(/\b\d[\d\s.,-]*(?:k|tr|triệu|trieu|đồng|dong|vnd|₫)\b/gi) || [];
  if (!priceMatches.length) return false;
  const knowledge = verifiedKnowledgeText(modelInput).replace(/\s+/g, "");
  return priceMatches.some(function (match) {
    const normalized = qualityNormalize(match).replace(/\s+/g, "");
    return normalized && !knowledge.includes(normalized);
  });
}


function explicitSlideRequest(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  return explicitMediaRequestFromMessages(messages);
}

function languageLooksCorrupted(value) {
  const text = String(value || "");
  const normalized = qualityNormalize(text);
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text) || /[�åäöüæøßłŁćĆśŚźŹżŻńŃ]/i.test(text)) return true;
  if (/\b(cosi|ldo|showoom|gia lam noii|zddw)\b/i.test(normalized)) return true;
  if (/\b(?:ld|dd|lđ)[a-z]{1,8}\b/i.test(normalized)) return true;
  const words = text.match(/[A-Za-zÀ-ỹĐđ]+/g) || [];
  const endingIWhitelist = new Set(["gi", "thi", "vi", "mi", "li", "ki", "khi"]);
  for (const word of words) {
    const clean = qualityNormalize(word);
    if (/[ìòèù]$/i.test(word) && clean.length > 3 && !endingIWhitelist.has(clean)) return true;
  }
  return false;
}

function priceIntentDetected(decision, modelInput) {
  const latest = latestExplicitText(modelInput);
  const active = activeProductText(modelInput);
  const intents = qualityNormalize((Array.isArray(decision && decision.intents) ? decision.intents : []).join(" "));
  return /\b(price|gia|bao gia|bao nhieu|tien the nao|gia tien|cost)\b/.test(intents + " " + latest + " " + active);
}

function replyContainsVerifiedPrice(reply, modelInput) {
  const priceMatches = String(reply || "").match(/\b\d[\d\s.,-]*(?:k|tr|triệu|trieu|đồng|dong|vnd|₫)\b/gi) || [];
  if (!priceMatches.length) return false;
  const knowledge = verifiedKnowledgeText(modelInput).replace(/\s+/g, "");
  return priceMatches.every(function (match) {
    const normalized = qualityNormalize(match).replace(/\s+/g, "");
    return normalized && knowledge.includes(normalized);
  });
}

function contactRequestDetected(value) {
  const text = qualityNormalize(value);
  return /\b(xin|cho|gui|de lai|nhan|qua).{0,32}\b(sdt|so dien thoai|zalo)\b|\b(sdt|so dien thoai|zalo).{0,24}\b(nhe|a|de|qua)\b/.test(text);
}

function unsupportedTechnicalFacts(value, modelInput) {
  const replyFacts = String(value || "").match(/\b\d+(?:[,.]\d+)?\s*(?:m\d+|m|cm|mm|w|kw|kg|l)\b/gi) || [];
  if (!replyFacts.length) return false;
  const customer = qualityNormalize(customerMessagesFrom(modelInput).map(function (message) { return message.text || ""; }).join(" ")).replace(/\s+/g, "");
  const knowledge = verifiedKnowledgeText(modelInput).replace(/\s+/g, "");
  return replyFacts.some(function (fact) {
    const normalized = qualityNormalize(fact).replace(/\s+/g, "");
    return normalized && !customer.includes(normalized) && !knowledge.includes(normalized);
  });
}

function specificPriceSubject(modelInput) {
  const raw = customerMessagesFrom(modelInput)
    .slice(-6)
    .map(function (message) { return String(message && message.text || ""); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = qualityNormalize(raw);

  let category = "mẫu sản phẩm";
  if (/\b(bon cau|bet ve sinh|bet)\b/.test(normalized)) category = "bồn cầu";
  else if (/\b(quat tran|quat)\b/.test(normalized)) category = "quạt trần";
  else if (/\b(bep tu|bep dien|may hut mui|hut mui)\b/.test(normalized)) category = "sản phẩm phòng bếp";
  else if (/\b(sen tam|sen cay)\b/.test(normalized)) category = "sen tắm";
  else if (/\b(lavabo|chau rua mat)\b/.test(normalized)) category = "lavabo";
  else if (/\b(chau rua bat|voi rua bat)\b/.test(normalized)) category = "chậu/vòi rửa bát";

  const brandModelMatches = raw.match(/[A-Za-zÀ-ỹĐđ]{3,24}\s+[A-Za-z]{1,8}[-_.\/]?\d{2,6}[A-Za-z0-9._\/-]*/g) || [];
  const codeMatches = raw.match(/\b[A-Za-z]{1,8}[-_.\/]?\d{2,6}[A-Za-z0-9._\/-]*\b/g) || [];
  let reference = brandModelMatches.length ? brandModelMatches[brandModelMatches.length - 1] : (codeMatches[codeMatches.length - 1] || "");
  const firstWord = qualityNormalize(reference).split(" ")[0] || "";
  if (["cau", "quat", "bep", "sen", "voi", "chau", "mau", "pham"].includes(firstWord) && codeMatches.length) {
    reference = codeMatches[codeMatches.length - 1];
  }
  reference = String(reference || "").replace(/[.,!?;:]+$/g, "").trim();

  if (reference) return category + " " + reference;
  if (category !== "mẫu sản phẩm") return category + " anh/chị đang quan tâm";
  return "mẫu sản phẩm anh/chị đang quan tâm";
}

// AIGUKA_V10_SPECIFIC_PRICE_CONTACT_V1

function safePriceReply(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = generalSalesSubject(modelInput);
  const text = known
    ? "Dạ, giá của " + subject + " còn phụ thuộc đúng mẫu/phiên bản và ưu đãi tại thời điểm kiểm tra. Em chuyển chuyên viên sản phẩm xác nhận và gửi báo giá chuẩn theo thông tin liên hệ mình đã để lại ạ."
    : "Dạ, giá của " + subject + " còn phụ thuộc đúng mẫu/phiên bản và ưu đãi tại thời điểm kiểm tra. Anh/chị cho em xin SĐT hoặc Zalo, em chuyển chuyên viên sản phẩm xác nhận, gửi mẫu chuẩn và báo giá hiện tại ạ.";
  return applySalutation(text, style);
}

// AIGUKA_V10_DECISION_INTEGRITY_V8

function currentCustomerRawCluster(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1)
    .filter(function (message) { return message && message.role === "customer"; })
    .map(function (message) { return String(message.text || ""); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hardContactRefusalInTurn(modelInput) {
  const text = qualityNormalize(currentCustomerRawCluster(modelInput));
  return /\b(dung xin|dung hoi|khong cho so|khong dua so|khong can goi|khong lien he|khong sdt|khong so dien thoai|khong zalo)\b/.test(text);
}

function commercialProductNeedDetected(decision, modelInput) {
  const raw = currentCustomerRawCluster(modelInput);
  const text = qualityNormalize(raw);
  const intents = qualityNormalize((Array.isArray(decision && decision.intents) ? decision.intents : []).join(" "));
  const advisors = modelInput && modelInput.knowledge_advisors ? modelInput.knowledge_advisors : {};
  const advisorProducts = Array.isArray(advisors.product_candidates) ? advisors.product_candidates : [];
  const selected = Array.isArray(decision && decision.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  const hasProductEvidence = advisorProducts.length > 0 || selected.length > 0 || /\b(bon cau|bet|sen tam|sen cay|lavabo|guong|tu chau|tu lavabo|bon tam|bep tu|hut mui|chau rua|voi rua|phu kien|quat|den|gach|ngoi|combo|phong tam|nha tam|phong bep|nha bep|san pham|mau)\b/.test(text);
  const commercialSignal = /\b(price|gia|bao gia|bao nhieu|samples|sample|xem mau|gui mau|gui anh|catalog|specs|thong so|kich thuoc|cong suat|stock|con hang|co hang|availability|delivery|giao hang|van chuyen|lap dat|bao hanh|xuat xu|thuong hieu|brand|purchase|mua|dat hang|lay hang|chot|uu dai|khuyen mai|giam gia)\b/.test(intents + " " + text);
  return (hasProductEvidence && commercialSignal) || /\b(muon mua|can mua|dat hang|chot don|mua hang)\b/.test(text);
}

function strongCommercialSignal(decision, modelInput) {
  const raw = currentCustomerRawCluster(modelInput);
  const text = qualityNormalize(raw);
  const intents = qualityNormalize((Array.isArray(decision && decision.intents) ? decision.intents : []).join(" "));
  return priceIntentDetected(decision, modelInput)
    || /\b(muon mua|can mua|dat hang|chot|lay hang|bao gia|uu dai|khuyen mai|con hang|giao hang|van chuyen|lap dat|bao hanh|xem mau|gui mau|gui anh|catalog)\b/.test(intents + " " + text)
    || Boolean(decision && (decision.needs_slides || decision.action === "reply_with_slides"));
}

function specificOrComplexProductRequest(modelInput) {
  const raw = currentCustomerRawCluster(modelInput);
  const text = qualityNormalize(raw);
  const codeLike = /\b[A-Za-z]{1,10}[-_.\/]?\d{2,7}[A-Za-z0-9._\/-]*\b/.test(raw);
  const specification = /\b(kich thuoc|cong suat|dong co|chat lieu|xuat xu|thuong hieu|bao hanh|lap dat|phien ban|model|ma san pham|mau sac|sai canh|dien ap)\b/.test(text);
  return codeLike || specification;
}

function containsCjkOrForeignGlyph(value) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(String(value || ""));
}

function stripRepeatedBusinessIntroduction(value) {
  let text = String(value || "").trim();
  text = text
    .replace(/^\s*(?:chào|xin chào)[^.!?]{0,80}[.!?]\s*/i, "")
    .replace(/^\s*(?:dạ[, ]*)?(?:em|cháu)\s+là\s+(?:nhân viên|tư vấn viên|trợ lý|cố vấn|顾问)[^.!?]{0,160}[.!?]?\s*/i, "")
    .replace(/^\s*(?:em|cháu)\s+(?:đến|từ)\s+showroom[^.!?]{0,120}[.!?]?\s*/i, "")
    .trim();
  return text;
}

function specialistHandoffDetected(value) {
  const text = qualityNormalize(value);
  return /\b(chuyen|noi|gui|nhờ).{0,28}\b(sale|nhan vien kinh doanh|tu van vien|chuyen vien|chuyen vien san pham)\b|\b(sale|nhan vien kinh doanh|tu van vien|chuyen vien|chuyen vien san pham).{0,36}\b(kiem tra|bao gia|lien he|tu van|gui mau|xac nhan)\b/.test(text);
}

function unresolvedPromiseWithoutHandoff(value) {
  const text = qualityNormalize(value);
  return /\b(de em|em se|cho em).{0,40}\b(kiem tra|xem lai).{0,40}\b(bao lai|phan hoi lai|tra loi lai)\b/.test(text)
    && !specialistHandoffDetected(value)
    && !contactRequestDetected(value);
}

function sentenceParts(value) {
  return (String(value || "").match(/[^.!?\n]+[.!?]?/g) || []).map(function (part) { return part.trim(); }).filter(Boolean);
}

function removeContactRequestSentences(value) {
  return sentenceParts(value).filter(function (part) { return !contactRequestDetected(part); }).join(" ").trim();
}

function appendSentence(value, sentence) {
  const base = String(value || "").trim();
  const extra = String(sentence || "").trim();
  if (!base) return extra;
  if (!extra) return base;
  return base + (/[.!?]$/.test(base) ? " " : ". ") + extra;
}

function trimReplyWithoutDestroyingAnswer(value, maxSentences, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars && sentenceParts(text).length <= maxSentences) return text;
  const kept = sentenceParts(text).slice(0, maxSentences).join(" ").trim();
  return (kept || text.slice(0, maxChars)).slice(0, maxChars).trim();
}

function replyHasUsefulAnswer(value) {
  const text = qualityNormalize(stripRepeatedBusinessIntroduction(value));
  if (text.length < 28) return false;
  if (/^(da|vang|ok|em ghi nhan|em hieu|de em kiem tra|cho em xin chut thoi gian)\b/.test(text) && text.length < 90) return false;
  return true;
}

function generalSalesSubject(modelInput) {
  const subject = typeof specificPriceSubject === "function" ? specificPriceSubject(modelInput) : "mẫu sản phẩm anh/chị đang quan tâm";
  return String(subject || "mẫu sản phẩm anh/chị đang quan tâm")
    .replace(/\s+/g, " ")
    .trim();
}

function difficultProductCase(decision, modelInput, reply) {
  return containsCjkOrForeignGlyph(reply)
    || languageLooksCorrupted(reply)
    || unsupportedPriceReply(reply, modelInput)
    || unsupportedStockClaim(reply, modelInput)
    || unsupportedTechnicalFacts(reply, modelInput)
    || unresolvedPromiseWithoutHandoff(reply)
    || (priceIntentDetected(decision, modelInput) && !replyContainsVerifiedPrice(reply, modelInput))
    || specificOrComplexProductRequest(modelInput);
}

function smartSpecialistFallback(decision, modelInput, refused) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = generalSalesSubject(modelInput);
  let text;
  if (refused) {
    text = "Dạ, phần " + subject + " còn phụ thuộc đúng mã/phiên bản nên em chưa muốn báo sai. Anh/chị gửi thêm ảnh hoặc mã đầy đủ, em hỗ trợ tiếp ngay tại đây ạ.";
  } else if (known) {
    text = "Dạ, phần " + subject + " còn phụ thuộc đúng mẫu/phiên bản nên em chưa muốn báo sai. Em chuyển chuyên viên sản phẩm kiểm tra và gửi mẫu chuẩn, báo giá cùng ưu đãi hiện tại theo thông tin liên hệ mình đã để lại ạ.";
  } else {
    text = "Dạ, phần " + subject + " còn phụ thuộc đúng mẫu/phiên bản nên em chưa muốn báo sai. Anh/chị cho em xin SĐT hoặc Zalo, em chuyển chuyên viên sản phẩm kiểm tra, gửi mẫu chuẩn, báo giá và ưu đãi hiện tại ạ.";
  }
  return applySalutation(text, style);
}

function smartContactSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Anh/chị cho em xin SĐT hoặc Zalo, em chuyển chuyên viên sản phẩm gửi mẫu chuẩn, báo giá và ưu đãi hiện tại ạ.", style);
}

function smartKnownContactSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Em chuyển chuyên viên sản phẩm kiểm tra đúng mẫu/phiên bản và phản hồi theo thông tin liên hệ mình đã để lại ạ.", style);
}

function smartSpecialistReasonSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Em chuyển chuyên viên sản phẩm kiểm tra đúng mẫu/phiên bản để tư vấn và báo giá chuẩn cho mình ạ.", style);
}

function enforceGeneralProductSalesHandoff(decision, modelInput) {
  if (!commercialProductNeedDetected(decision, modelInput)) return decision;

  const known = contactIsKnown(modelInput);
  const refused = hardContactRefusalInTurn(modelInput);
  const highIntent = strongCommercialSignal(decision, modelInput);
  let reply = stripRepeatedBusinessIntroduction(decision.final_reply || "");
  let repairMode = "preserved";

  const unsafe = containsCjkOrForeignGlyph(reply)
    || languageLooksCorrupted(reply)
    || unsupportedPriceReply(reply, modelInput)
    || unsupportedStockClaim(reply, modelInput)
    || unsupportedTechnicalFacts(reply, modelInput);
  const difficult = difficultProductCase(decision, modelInput, reply);
  const shouldAskContact = !known && !refused && (highIntent || difficult);

  if (unsafe) {
    reply = smartSpecialistFallback(decision, modelInput, refused);
    repairMode = "safe_specialist_fallback";
  } else {
    if (unresolvedPromiseWithoutHandoff(reply)) {
      reply = smartSpecialistFallback(decision, modelInput, refused);
      repairMode = "promise_repaired";
    } else if (known) {
      if (contactRequestDetected(reply)) {
        reply = removeContactRequestSentences(reply);
        repairMode = "removed_duplicate_contact_request";
      }
      if ((highIntent || difficult) && !specialistHandoffDetected(reply)) {
        reply = appendSentence(reply, smartKnownContactSentence(modelInput));
        repairMode = "appended_known_contact_handoff";
      }
    } else if (refused) {
      if (contactRequestDetected(reply)) {
        reply = removeContactRequestSentences(reply);
        repairMode = "honored_contact_refusal";
      }
      if (!replyHasUsefulAnswer(reply) && difficult) {
        reply = smartSpecialistFallback(decision, modelInput, true);
        repairMode = "messenger_clarification_fallback";
      }
    } else if (shouldAskContact) {
      if (!replyHasUsefulAnswer(reply)) {
        reply = smartSpecialistFallback(decision, modelInput, false);
        repairMode = "missing_answer_fallback";
      } else {
        if (!contactRequestDetected(reply)) {
          reply = appendSentence(reply, smartContactSentence(modelInput));
          repairMode = "appended_contact_cta";
        }
        if ((difficult || highIntent) && !specialistHandoffDetected(reply)) {
          reply = appendSentence(reply, smartSpecialistReasonSentence(modelInput));
          repairMode = repairMode === "preserved" ? "appended_specialist_reason" : repairMode + "+specialist_reason";
        }
      }
    }
  }

  reply = stripRepeatedBusinessIntroduction(reply).replace(/\s+/g, " ").trim();
  if (containsCjkOrForeignGlyph(reply) || !reply) {
    reply = smartSpecialistFallback(decision, modelInput, refused);
    repairMode = "final_safe_fallback";
  }
  reply = trimReplyWithoutDestroyingAnswer(reply, 4, 760);

  decision.final_reply = applySalutation(reply, salutationStyle(modelInput));
  decision.contact_state = known ? "known" : "missing";
  decision.should_request_contact = shouldAskContact;
  decision.contact_benefit = known
    ? "chuyên viên sản phẩm kiểm tra đúng mẫu/phiên bản và phản hồi theo liên hệ đã có"
    : refused
      ? "tiếp tục hỗ trợ tại Messenger, xin thêm ảnh hoặc mã đầy đủ khi cần"
      : shouldAskContact
        ? "chuyên viên sản phẩm gửi mẫu chuẩn, báo giá và ưu đãi hiện tại"
        : "trả lời trực tiếp phần dữ liệu đã chắc chắn";
  decision.sales_handoff_required = !refused && (highIntent || difficult);
  decision.specialist_handoff_recommended = !refused && commercialProductNeedDetected(decision, modelInput);
  decision.general_product_sales_guard = true;
  decision.smart_reply_repair = repairMode;
  decision.hard_output_blocking = false;
  return decision;
}

// AIGUKA_V10_GENERAL_PRODUCT_SALES_HANDOFF_V2_SMART_REPAIR

function unsupportedStockClaim(value, modelInput) {
  const text = qualityNormalize(value);
  if (!/\b(co san|con hang|trong kho|san kho|con kho|co mau.{0,20}trong kho)\b/.test(text)) return false;
  const knowledge = verifiedKnowledgeText(modelInput);
  return !/\b(co san|con hang|trong kho|san kho)\b/.test(knowledge);
}

function groundedProductReply(decision, modelInput) {
  const latest = latestExplicitText(modelInput);
  const style = salutationStyle(modelInput);
  const known = contactIsKnown(modelInput);
  const keys = Array.isArray(decision.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  const joined = keys.join(" ");
  let subject = "mẫu sản phẩm anh/chị đang quan tâm";

  const active = activeProductText(modelInput);
  if (/quat_10_canh|quat_tran/.test(joined) || /\bquat.{0,20}10(?: canh)?\b/.test(latest + " " + active)) {
    const color = /\bmau vang\b/.test(latest) ? " màu vàng" : /\bmau den\b/.test(latest) ? " màu đen" : /\bmau nau\b/.test(latest) ? " màu nâu" : /\bvan go\b/.test(latest) ? " màu vân gỗ" : "";
    const size = /\b1\s*[,.]?\s*67\b|\b1m67\b/.test(latest) ? ", sải cánh 1,67 m" : "";
    subject = "mẫu quạt trần 10 cánh" + color + size;
  } else if (keys.includes("bep_tu_hut_mui") && keys.includes("chau_voi_rua_bat")) {
    subject = "các mẫu phòng bếp gồm bếp từ–hút mùi và chậu–vòi";
  } else if (keys.includes("bep_tu_hut_mui")) {
    subject = "các mẫu bếp từ và máy hút mùi";
  } else if (keys.includes("chau_voi_rua_bat")) {
    subject = "các mẫu chậu và vòi rửa bát";
  } else if (/bon_cau/.test(joined)) {
    subject = "các mẫu bồn cầu phù hợp";
  } else if (/combo_phong_tam/.test(joined)) {
    subject = "các mẫu combo phòng tắm";
  }

  let text = "Dạ, " + (decision.needs_slides ? "em gửi anh/chị " : "em đã ghi nhận ") + subject + (decision.needs_slides ? " để tham khảo ạ." : " ạ.");
  if (!known && decision.should_request_contact) {
    text += " Anh/chị cho em xin SĐT hoặc Zalo, bên em kiểm tra đúng mẫu và báo giá chính xác nhé.";
  } else if (known && /\b(mua|lay|dat|1c|1 chiec)\b/.test(latest)) {
    text += " Bên em đã nhận số và chuyển Sale liên hệ tư vấn cho mình ạ.";
  }
  return applySalutation(text, style);
}

// AIGUKA_V10_DECISION_INTEGRITY_V7

function currentFocusTags(message) {
  const text = qualityNormalize(message && message.text || "");
  const tags = [];
  function add(value) { if (value && !tags.includes(value)) tags.push(value); }
  const toilet = /\b(bon cau|bet|bet lien khoi|bet thong minh|bet trung|qua trung|toilet)\b/.test(text);
  const shower = /\b(sen tam|sen cay|voi sen|sen voi)\b/.test(text);
  const bathSink = /\b(lavabo|chau rua mat|bon rua mat|tu lavabo|tu chau|guong lavabo)\b/.test(text);
  const kitchenSink = /\b(chau rua bat|chau rua chen|chau rua bep|voi rua bat|voi rua chen|voi rua bep|chau voi)\b/.test(text);
  const kitchenAppliance = /\b(bep tu|bep dien|hut mui|may hut|hut khoi)\b/.test(text);
  const kitchenFurniture = /\b(tu bep|bo bep|he tu bep|bep dai|tu bep dai|noi that bep theo met)\b/.test(text)
    || /\b(?:bo|tu)\s*bep.{0,24}\b(?:m|met)\b/.test(text);
  const fan = /\b(?:quat|quant)(?:\s+tran)?(?:.{0,22}(?:5|6|8|10)\s*canh)?\b/.test(text);
  const tile = /\b(gach|op lat|lat nen|da op lat)\b/.test(text);
  if (toilet) add("toilet");
  if (shower) add("shower");
  if (bathSink) add("bath_sink");
  if (kitchenSink) add("kitchen_sink");
  if (kitchenAppliance) add("kitchen_appliance");
  if (kitchenFurniture) add("kitchen_furniture");
  if (fan) add("fan");
  if (tile) add("tile");
  if (!(toilet || shower || bathSink) && /\b(phong tam|nha tam|nha ve sinh|nha vs|wc|thiet bi ve sinh|combo.{0,12}(tam|ve sinh))\b/.test(text)) add("bathroom");
  if (!(kitchenSink || kitchenAppliance || kitchenFurniture) && /\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|combo.{0,12}bep|com bo.{0,12}bep|bep an)\b/.test(text)) add("kitchen");
  if (/\b(noi that nha moi|hoan thien nha|trang bi nha moi|xem het|tat ca mau|toan bo san pham)\b/.test(text)) add("whole_home");
  return tags;
}

function focusCurrentCustomerMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages || [];
  let focusIndex = -1;
  let tags = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const found = currentFocusTags(messages[index]);
    if (!found.length) continue;
    focusIndex = index;
    tags = found;
    break;
  }
  if (focusIndex <= 0 || tags.length !== 1 || tags[0] === "whole_home") return messages;
  const target = tags[0];
  const newer = messages.slice(focusIndex + 1).flatMap(currentFocusTags);
  if (newer.some(function (tag) { return tag !== target; })) return messages;
  const earlier = messages.slice(0, focusIndex).flatMap(currentFocusTags);
  if (!earlier.some(function (tag) { return tag !== target; })) return messages;
  return messages.slice(focusIndex);
}

function currentCustomerClusterText(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  const current = messages.slice(boundary + 1).filter(function (message) {
    return message && message.role === "customer" && !["superseded", "cancelled"].includes(String(message.semantic_status || "active").toLowerCase());
  });
  return qualityNormalize(focusCurrentCustomerMessages(current).map(function (message) {
    return message.text || "";
  }).join(" "));
}

// AIGUKA_V10_ACTIVE_INTENT_FOCUS_V1
function currentTurnSlideKeys(modelInput, slideKeys) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  const explicitScope = deriveMediaScope(messages, slideKeys, {
    productCandidates: modelInput?.knowledge_advisors?.product_candidates || [],
  });
  if (explicitScope.length || !explicitMediaRequestFromMessages(messages)) return explicitScope;

  const mappings = modelInput && modelInput.knowledge_advisors && Array.isArray(modelInput.knowledge_advisors.ad_mappings)
    ? modelInput.knowledge_advisors.ad_mappings
    : [];
  if (mappings.length !== 1) return [];
  const mapping = mappings[0] || {};
  const preferred = Array.isArray(mapping.fallback_catalog_keys) && mapping.fallback_catalog_keys.length
    ? mapping.fallback_catalog_keys
    : (Array.isArray(mapping.catalog_keys) ? mapping.catalog_keys : []);
  const available = slideKeys instanceof Set ? slideKeys : new Set(Array.isArray(slideKeys) ? slideKeys.map(String) : []);
  return [...new Set(preferred.map((value) => String(value || "").trim()).filter((value) => available.has(value)))].slice(0, 3);
}

function continuationSlideRequest(modelInput) {
  const latest = latestExplicitText(modelInput);
  return /\b(xem them|mau khac|gui them|gui lai|loai nay|mau nay|mau vang|mau den|mau nau|xin gia|gia sao|bao nhieu|khong mo|khong xem duoc)\b/.test(latest);
}

function previousCustomerProductText(modelInput) {
  const messages = customerMessagesFrom(modelInput);
  if (messages.length < 2) return "";
  return qualityNormalize(messages.slice(Math.max(0, messages.length - 4), -1).map(function (message) {
    return message.text || "";
  }).join(" "));
}

function continuationSlideKeys(modelInput, slideKeys) {
  if (!continuationSlideRequest(modelInput)) return [];
  const previous = previousCustomerProductText(modelInput);
  const synthetic = {
    ...modelInput,
    conversation: {
      ...(modelInput && modelInput.conversation || {}),
      messages: [{ role: "customer", text: previous }],
    },
  };
  return currentTurnSlideKeys(synthetic, slideKeys);
}

function addressIntentInCurrentTurn(modelInput) {
  return /\b(dia chi|o dau|showroom|cua hang|kho o dau|cong ty o dau|dai ly o dau)\b/.test(currentCustomerClusterText(modelInput));
}

function mediaProblemInCurrentTurn(modelInput) {
  return /\b(khong mo|khong xem|khong vao|khong phong to|khong vach|loi anh|anh khong hien)\b/.test(currentCustomerClusterText(modelInput));
}

function currentTurnContainsPhone(modelInput) {
  const raw = customerMessagesFrom(modelInput).slice(-6).map(function (message) { return message.text || ""; }).join(" ");
  return /(?:^|\D)(?:\+?84|0)(?:[\s.()-]*\d){8,10}(?:\D|$)/.test(raw);
}

function verifiedAddressSentence(modelInput) {
  const knowledge = qualityNormalize(JSON.stringify(modelInput && modelInput.knowledge_advisors || {}));
  const current = currentCustomerClusterText(modelInput);
  const addresses = [];
  if (knowledge.includes("254 pho keo kim son gia lam ha noi")) addresses.push("254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội");
  if (knowledge.includes("pho dan tri qua thuan thanh bac ninh")) addresses.push("Phố Dàn, Trí Quả, Thuận Thành, Bắc Ninh");
  if (knowledge.includes("khu do thi dinh to luxury homes thuan thanh bac ninh")) addresses.push("Khu đô thị Đình Tổ Luxury Homes, Thuận Thành, Bắc Ninh");
  if (knowledge.includes("khu do thi khai son long bien ha noi")) addresses.push("Khu đô thị Khai Sơn, Long Biên, Hà Nội");
  if (!addresses.length) return "";

  let selected = addresses;
  if (/\b(bac ninh|thuan thanh|tri qua|pho dan|dinh to)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Bắc Ninh|Thuận Thành/i.test(address); });
  } else if (/\b(long bien|khai son)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Long Biên|Khai Sơn/i.test(address); });
  } else if (/\b(gia lam|kim son|pho keo|hung yen|thuong tin|ha noi)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Gia Lâm|Long Biên/i.test(address); });
  }
  if (!selected.length) selected = addresses;
  return "Showroom ÁNH DƯƠNG có " + selected.map(function (address) { return "cơ sở tại " + address; }).join("; ") + ".";
}

function replyAnswersAddress(value) {
  const text = qualityNormalize(value);
  return /\b(pho keo|pho dan|dinh to|khai son|gia lam|long bien|thuan thanh|bac ninh)\b/.test(text);
}

function replyAcknowledgesContact(value) {
  return /\b(da nhan|ghi nhan|luu so|nhan duoc so|chuyen sale|lien he)\b/.test(qualityNormalize(value));
}

function replyHandlesMediaProblem(value) {
  return /\b(gui lai|anh truc tiep|tren messenger|gui tung anh|mo anh|xem anh)\b/.test(qualityNormalize(value));
}

function enforceCurrentTurnMediaScope(decision, modelInput, slideKeys) {
  const requested = decision.needs_slides || decision.action === "reply_with_slides";
  if (!requested) return decision;

  const current = currentTurnSlideKeys(modelInput, slideKeys);
  const carried = current.length ? [] : continuationSlideKeys(modelInput, slideKeys);
  const resolved = current.length ? current : carried;

  if (resolved.length) {
    decision.selected_catalog_keys = resolved.slice(0, 6);
    decision.needs_slides = true;
    decision.action = "reply_with_slides";
    return decision;
  }

  decision.selected_catalog_keys = [];
  decision.selected_products = [];
  decision.needs_slides = false;
  decision.action = "ask_clarification";
  decision.confidence = Math.min(Number(decision.confidence || 0.6), 0.7);
  decision.final_reply = "Dạ, anh/chị đang muốn xem mẫu sản phẩm nào để em gửi đúng nhóm ạ?";
  decision.decision_reason = String(decision.decision_reason || "") + " | media_scope_blocked_without_current_customer_product_evidence";
  return decision;
}

function ensureCurrentTurnCoverage(decision, modelInput) {
  let text = String(decision.final_reply || "").trim();
  const prefixes = [];
  const known = contactIsKnown(modelInput);

  if (addressIntentInCurrentTurn(modelInput) && !replyAnswersAddress(text)) {
    const address = verifiedAddressSentence(modelInput);
    if (address) prefixes.push(address);
  }
  if (mediaProblemInCurrentTurn(modelInput) && !replyHandlesMediaProblem(text)) {
    prefixes.push("Em gửi lại ảnh trực tiếp trên Messenger để anh/chị mở và xem rõ hơn ạ.");
  }
  if (known && currentTurnContainsPhone(modelInput) && !replyAcknowledgesContact(text)) {
    prefixes.push("Dạ, em đã nhận số điện thoại của anh/chị rồi ạ.");
  }

  if (addressIntentInCurrentTurn(modelInput) && !currentTurnSlideKeys(modelInput, exactCatalogContext(modelInput).slide).length) {
    decision.needs_slides = false;
    if (decision.action === "reply_with_slides") decision.action = "reply_text";
    decision.selected_catalog_keys = [];
    decision.selected_products = [];
  }

  if (prefixes.length) text = prefixes.join(" ") + (text ? " " + text : "");
  decision.final_reply = applySalutation(text.slice(0, 640), salutationStyle(modelInput));
  return decision;
}

// AIGUKA_V10_DECISION_INTEGRITY_V10

function enforceDecisionIntegrity(input, modelInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("V10_DECISION_INTEGRITY_OBJECT_REQUIRED");
  const decision = structuredClone(input);
  const modelValueText = [
    decision.final_reply,
    decision.decision_reason,
    decision.contact_benefit,
    ...(Array.isArray(decision.intents) ? decision.intents : []),
    ...(Array.isArray(decision.selected_products) ? decision.selected_products : []),
    ...(Array.isArray(decision.selected_catalog_keys) ? decision.selected_catalog_keys : []),
    ...(Array.isArray(decision.follow_up_plan) ? decision.follow_up_plan : []),
  ].map(function (value) { return String(value || ""); }).join(" ");
  if (DECISION_LEAK_PATTERN.test(modelValueText)) throw new Error("V10_DECISION_INTERNAL_TEXT_REJECTED");

  const reply = String(decision.final_reply || "").trim();
  if (DECISION_GIBBERISH_PATTERN.test(reply)) throw new Error("V10_DECISION_GIBBERISH_REJECTED");
  if (reply === "final_reply" || reply === "reply" || reply.length > 650) throw new Error("V10_DECISION_REPLY_INVALID");

  const catalogContext = exactCatalogContext(modelInput);
  const allowed = catalogContext.allowed;
  const slide = catalogContext.slide;
  const selected = [];
  const rawKeys = Array.isArray(decision.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  for (const value of rawKeys) {
    const selectedKey = canonicalCatalogKey(value, allowed);
    if (selectedKey && !selected.includes(selectedKey)) selected.push(selectedKey);
  }

  const scope = currentTurnSlideKeys(modelInput, slide);
  const slideRequested = explicitSlideRequest(modelInput);
  const messagesForMedia = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  const mediaExpected = mediaExpectedFromMessages(messagesForMedia, scope);
  if (scope.length && (mediaExpected || decision.needs_slides || decision.action === "reply_with_slides")) {
    if (mediaExpected) {
      decision.needs_slides = true;
      decision.action = "reply_with_slides";
      decision.decision_reason = String(decision.decision_reason || "") + " | customer_media_obligation_preserved";
    }
    decision.selected_catalog_keys = scope.slice(0, 6);
  } else {
    decision.selected_catalog_keys = selected.filter(function (selectedKey) { return slide.has(selectedKey); }).slice(0, 6);
  }

  if (decision.needs_slides || decision.action === "reply_with_slides") {
    if (!decision.selected_catalog_keys.length) {
      decision.needs_slides = false;
      if (decision.action === "reply_with_slides") decision.action = "reply_text";
    } else {
      decision.needs_slides = true;
      decision.action = "reply_with_slides";
    }
  }

  enforceCurrentTurnMediaScope(decision, modelInput, slide);
  decision.selected_products = decision.selected_catalog_keys.map(function (selectedKey) {
    const item = allowed.get(selectedKey);
    return String(item && item.display_name || selectedKey);
  });

  const known = contactIsKnown(modelInput);
  const latestIntentText = latestExplicitText(modelInput);
  if (/\b(gia|bao gia|bao nhieu|cost)\b/.test(latestIntentText) && unsupportedPriceReply(decision.final_reply, modelInput)) {
    decision.final_reply = known
      ? "Dạ giá mẫu này còn tùy màu và phiên bản. Bên em đã nhận số của anh/chị và sẽ kiểm tra đúng mẫu để báo giá chính xác ạ."
      : "Dạ giá mẫu này còn tùy màu và phiên bản. Anh/chị cho em xin SĐT hoặc Zalo, bên em kiểm tra đúng mẫu và báo giá chính xác ạ.";
  }
  if (known) {
    decision.contact_state = "known";
    decision.should_request_contact = false;
  }

  const latest = latestExplicitText(modelInput);
  const style = salutationStyle(modelInput);
  if (known && /\b(goi di|goi cho co|dang ranh|co dang ranh)\b/.test(latest)) {
    decision.action = "reply_text";
    decision.needs_slides = false;
    decision.selected_catalog_keys = [];
    decision.selected_products = [];
    decision.contact_state = "known";
    decision.should_request_contact = false;
    decision.final_reply = "Dạ " + style.customer + ", " + style.self + " đã ghi nhận số và chuyển yêu cầu gọi tư vấn ngay ạ.";
  } else {
    decision.final_reply = applySalutation(decision.final_reply || reply, style);
  }

  const knownAtFinal = contactIsKnown(modelInput);
  if (priceIntentDetected(decision, modelInput) && !replyContainsVerifiedPrice(decision.final_reply, modelInput)) {
    decision.final_reply = safePriceReply(decision, modelInput);
    decision.contact_state = knownAtFinal ? "known" : "missing";
    decision.should_request_contact = !knownAtFinal;
    decision.contact_benefit = knownAtFinal
      ? "gửi mẫu, báo giá chính xác và ưu đãi hiện tại theo thông tin liên hệ đã có"
      : "gửi mẫu, báo giá chính xác và ưu đãi hiện tại";
  } else if (unsupportedStockClaim(decision.final_reply, modelInput) || unsupportedTechnicalFacts(decision.final_reply, modelInput) || languageLooksCorrupted(decision.final_reply) || (knownAtFinal && contactRequestDetected(decision.final_reply))) {
    decision.final_reply = groundedProductReply(decision, modelInput);
  }
  if (knownAtFinal) {
    decision.contact_state = "known";
    decision.should_request_contact = false;
  }
  ensureCurrentTurnCoverage(decision, modelInput);
  enforceGeneralProductSalesHandoff(decision, modelInput);
  enforceConversationContinuity(decision, modelInput);
  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");
  return decision;
}
// AIGUKA_V10_DECISION_INTEGRITY_V3

async function persistProviderRuntimeState(provider, state, classification = null, error = null) {
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

  await knowledge(`ai_providers?provider_key=eq.${encodeURIComponent(providerKey(provider))}`, {
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


function continuityTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function continuityContactRequestDetected(value) {
  const text = qualityNormalize(value);
  return /\b(xin|cho|gui|de lai|nhan|qua).{0,40}\b(sdt|so dien thoai|zalo|so lien he)\b|\b(sdt|so dien thoai|zalo|so lien he).{0,30}\b(nhe|a|de|qua|cho em|gui em)\b/.test(text);
}

function continuitySentenceParts(value) {
  return (String(value || "").match(/[^.!?\n]+[.!?]?/g) || [])
    .map(function (part) { return part.trim(); })
    .filter(Boolean);
}

function continuityRemoveContactRequests(value) {
  return continuitySentenceParts(value)
    .filter(function (part) { return !continuityContactRequestDetected(part); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function continuityCurrentCustomerCluster(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1)
    .filter(function (message) { return message && message.role === "customer"; })
    .map(function (message) { return String(message.text || ""); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function continuityContactCooldown(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? [...modelInput.conversation.messages]
    : [];
  messages.sort(function (a, b) { return continuityTime(a?.occurred_at) - continuityTime(b?.occurred_at); });
  let lastRequestIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "customer") continue;
    if (continuityContactRequestDetected(message.text || "")) lastRequestIndex = index;
  }
  if (lastRequestIndex < 0) return { active: false, customerMessagesSince: 999, lastRequestAt: null };
  const after = messages.slice(lastRequestIndex + 1);
  const customerMessagesSince = after.filter(function (message) { return message && message.role === "customer"; }).length;
  const requestAt = messages[lastRequestIndex]?.occurred_at || null;
  return { active: customerMessagesSince < 2, customerMessagesSince, lastRequestAt: requestAt };
}

function continuityPriorPageReply(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role !== "customer" && String(message.text || "").trim()) return message;
  }
  return null;
}

function continuityPruneIrrelevantSalesTangents(value, modelInput) {
  const current = qualityNormalize(continuityCurrentCustomerCluster(modelInput));
  if (!current) return String(value || "").trim();
  const explicitlyAskedPromo = /\b(khuyen mai|uu dai|giam gia|qua tang|ho tro chi phi|chi phi di lai|dat coc)\b/.test(current);
  const productQuestion = /\b(gia|bao gia|mau|san pham|phong bep|nha bep|phong tam|nha tam|bon cau|sen|lavabo|bep tu|hut mui|chau|voi rua|quat|den|gach|ngoi|mua|dat hang)\b/.test(current);
  const locationContext = /\b(dia chi|showroom|o gan|gan|khu vuc|nga tu|ha noi|hn|van chuyen|giao hang|o dau)\b/.test(current);
  const locationStatement = locationContext && !/\b(dia chi|showroom|o dau|cho xin dia chi)\b/.test(current);
  if (!locationContext || productQuestion || explicitlyAskedPromo) return String(value || "").trim();

  const previous = continuityPriorPageReply(modelInput);
  const previousText = qualityNormalize(previous?.text || "");
  const previousAlreadyGaveAddress = /\b(pho keo|gia lam|showroom|hotline)\b/.test(previousText);

  return continuitySentenceParts(value)
    .filter(function (part) {
      const text = qualityNormalize(part);
      if (/\b(dat coc|chi phi di lai|ho tro di lai|khuyen mai|uu dai|giam gia|qua tang)\b/.test(text)) return false;
      if (locationStatement && previousAlreadyGaveAddress && /\b(showroom|pho keo|gia lam|hotline|dia chi)\b/.test(text)) return false;
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function continuityFallbackReply(modelInput) {
  const style = salutationStyle(modelInput);
  const current = qualityNormalize(continuityCurrentCustomerCluster(modelInput));
  let text = "Dạ, em đã ghi nhận thông tin mình vừa gửi và tiếp tục hỗ trợ đúng nội dung này ạ.";
  if (/\bnga tu so\b/.test(current)) {
    text = "Dạ, em ghi nhận chị ở gần Ngã Tư Sở, Hà Nội ạ. Em sẽ tư vấn theo đúng khu vực này cho chị.";
  } else if (/\b(o gan|khu vuc|ha noi|hn|nga tu)\b/.test(current)) {
    text = "Dạ, em ghi nhận khu vực của anh/chị rồi ạ. Em sẽ tư vấn và kiểm tra vận chuyển theo đúng khu vực này.";
  } else if (/\b(dia chi|showroom|o dau)\b/.test(current) && typeof verifiedAddressSentence === "function") {
    text = verifiedAddressSentence(modelInput) || text;
  }
  return applySalutation(text, style);
}

function enforceConversationContinuity(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const cooldown = continuityContactCooldown(modelInput);
  let reply = continuityPruneIrrelevantSalesTangents(decision.final_reply || "", modelInput);

  if (known) {
    decision.contact_state = "known";
    decision.should_request_contact = false;
    reply = continuityRemoveContactRequests(reply);
  } else if (cooldown.active) {
    decision.contact_state = "missing_recently_requested";
    decision.should_request_contact = false;
    decision.contact_benefit = "đã vừa xin SĐT/Zalo; chờ ít nhất 2 tin nhắn mới của khách trước khi nhắc lại";
    decision.contact_cooldown_guard = true;
    decision.customer_messages_since_contact_request = cooldown.customerMessagesSince;
    decision.last_contact_request_at = cooldown.lastRequestAt;
    reply = continuityRemoveContactRequests(reply);
  }

  if (!reply) reply = continuityFallbackReply(modelInput);
  reply = applySalutation(reply, salutationStyle(modelInput));
  const parts = continuitySentenceParts(reply);
  if (parts.length > 3) reply = parts.slice(0, 3).join(" ");
  decision.final_reply = String(reply || "").replace(/\s+/g, " ").trim().slice(0, 650);
  decision.conversation_continuity_guard = true;
  return decision;
}

function continuityMessageKey(message) {
  const id = String(message?.id || "").trim();
  if (id) return "id:" + id;
  const text = qualityNormalize(message?.text || "").slice(0, 180);
  const time = continuityTime(message?.occurred_at);
  return "text:" + text + ":" + Math.floor(time / 5000);
}

async function enrichConversationWithDeliveredReplies(claimed, baseConversation) {
  const conversation = baseConversation && typeof baseConversation === "object" ? structuredClone(baseConversation) : {};
  const original = Array.isArray(conversation.messages) ? conversation.messages : [];
  const pageId = String(claimed?.page_id || claimed?.input_snapshot?.page_id || "").trim();
  const senderId = String(claimed?.sender_id || claimed?.input_snapshot?.sender_id || "").trim();
  if (!pageId || !senderId) return conversation;

  const path = "v9_decisions?select=id,status,output,created_at,updated_at&page_id=eq." + encodeURIComponent(pageId)
    + "&sender_id=eq." + encodeURIComponent(senderId)
    + "&id=neq." + encodeURIComponent(claimed.id)
    + "&order=created_at.desc&limit=30";
  const rows = await core(path).catch(function () { return []; });

  const existingKeys = new Set(original.map(continuityMessageKey));
  const additions = [];
  const originalTimes = original.map(function (message) { return continuityTime(message?.occurred_at); }).filter(Boolean);
  const earliestOriginal = originalTimes.length ? Math.min(...originalTimes) : 0;
  const lowerBound = earliestOriginal ? earliestOriginal - 6 * 60 * 60_000 : 0;

  for (const row of rows || []) {
    const output = row && row.output && typeof row.output === "object" ? row.output : {};
    const text = String(output.final_reply || "").trim();
    const deliveredAt = output.delivered_at || output.sent_at || null;
    const deliveredTime = continuityTime(deliveredAt);
    if (!text || !deliveredTime || (lowerBound && deliveredTime < lowerBound)) continue;
    const mediaCatalogKeys = [...new Set([
      ...(Array.isArray(output.media_catalog_keys_resolved) ? output.media_catalog_keys_resolved : []),
      ...(Array.isArray(output.selected_catalog_keys) ? output.selected_catalog_keys : []),
    ].map(function (value) { return String(value || "").trim(); }).filter(Boolean))];
    const message = {
      id: "decision:" + row.id,
      role: "bot",
      event_type: "bot_message",
      text,
      attachments: mediaCatalogKeys.length ? [{ type: "carousel", catalog_keys: mediaCatalogKeys }] : [],
      media_catalog_keys: mediaCatalogKeys,
      referral: null,
      occurred_at: deliveredAt,
      source: "v9_delivered_decision",
    };
    const key = continuityMessageKey(message);
    if (existingKeys.has(key)) continue;
    const duplicateByTextAndTime = original.concat(additions).some(function (item) {
      return item && item.role !== "customer"
        && qualityNormalize(item.text || "") === qualityNormalize(text)
        && Math.abs(continuityTime(item.occurred_at) - deliveredTime) <= 5000;
    });
    if (duplicateByTextAndTime) continue;
    additions.push(message);
    existingKeys.add(key);
  }

  const merged = original.concat(additions)
    .map(function (message, order) { return { ...message, __order: order }; })
    .sort(function (a, b) { return continuityTime(a.occurred_at) - continuityTime(b.occurred_at) || a.__order - b.__order; })
    .map(function ({ __order, ...message }) { return message; })
    .slice(-60);

  conversation.messages = merged;
  conversation.continuity = {
    source: "v9_delivered_decisions",
    delivered_bot_replies_added: additions.length,
    contact_cooldown_enforced: true,
    min_customer_messages_before_contact_retry: 2,
  };
  return conversation;
}

// AIGUKA_V10_CONVERSATION_CONTINUITY_V2


function sovereignRecentPageReply(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role !== "customer" && String(message.text || "").trim()) return message;
  }
  return null;
}

function sovereignCustomerAskedRepeat(modelInput) {
  const text = qualityNormalize(typeof continuityCurrentCustomerCluster === "function"
    ? continuityCurrentCustomerCluster(modelInput)
    : currentCustomerClusterText(modelInput));
  return /\b(gui lai|nhac lai|noi lai|lap lai|gui them|mau khac|xem lai)\b/.test(text);
}

function sovereignReplyPromisesMedia(value) {
  const text = qualityNormalize(value);
  return /\b(gui|dua|cho xem).{0,32}\b(mau|anh|hinh|catalog)\b/.test(text);
}

function sovereignCatalogIsAncestor(ancestorKey, descendantKey, allowed) {
  if (!ancestorKey || !descendantKey) return false;
  let cursor = String(descendantKey);
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    if (cursor === String(ancestorKey)) return true;
    visited.add(cursor);
    cursor = String(allowed.get(cursor)?.parent_key || "").trim();
  }
  return false;
}

function sovereignCatalogCovers(selectedKey, requiredKey, allowed) {
  if (!selectedKey || !requiredKey) return false;
  if (selectedKey === requiredKey) return true;
  return sovereignCatalogIsAncestor(selectedKey, requiredKey, allowed)
    || sovereignCatalogIsAncestor(requiredKey, selectedKey, allowed);
}

function sovereignDecisionViolations(decision, modelInput) {
  const violations = [];
  const reply = String(decision?.final_reply || "").trim();
  const replyNorm = qualityNormalize(reply);
  const catalogContext = exactCatalogContext(modelInput);
  const allowed = catalogContext.allowed;
  const slide = catalogContext.slide;
  const selected = Array.isArray(decision?.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  const known = contactIsKnown(modelInput) || (typeof currentTurnContainsPhone === "function" && currentTurnContainsPhone(modelInput));
  const asksContact = Boolean(decision?.should_request_contact) || contactRequestDetected(reply);
  const cooldown = typeof continuityContactCooldown === "function"
    ? continuityContactCooldown(modelInput)
    : { active: false, customerMessagesSince: 999 };

  if (DECISION_LEAK_PATTERN.test([reply, decision?.decision_reason, decision?.contact_benefit].join(" "))) {
    violations.push("INTERNAL_TEXT_LEAK");
  }
  if (DECISION_GIBBERISH_PATTERN.test(reply) || languageLooksCorrupted(reply)) {
    violations.push("CORRUPTED_LANGUAGE");
  }
  if (unsupportedPriceReply(reply, modelInput)) violations.push("UNVERIFIED_PRICE_CLAIM");
  if (unsupportedStockClaim(reply, modelInput)) violations.push("UNVERIFIED_STOCK_CLAIM");
  if (unsupportedTechnicalFacts(reply, modelInput)) violations.push("UNVERIFIED_TECHNICAL_CLAIM");

  if (known && decision?.contact_state !== "known") violations.push("CONTACT_ALREADY_KNOWN_STATE_REQUIRED");
  if (known && asksContact) violations.push("CONTACT_ALREADY_KNOWN_DO_NOT_REQUEST_AGAIN");
  if (!known && cooldown.active && asksContact) violations.push("CONTACT_COOLDOWN_" + cooldown.customerMessagesSince + "_CUSTOMER_MESSAGES");
  if (!known && hardContactRefusalInTurn(modelInput) && asksContact) violations.push("CUSTOMER_REFUSED_CONTACT");
  if (decision?.should_request_contact && !contactRequestDetected(reply)) violations.push("CONTACT_FLAG_WITHOUT_CONTACT_SENTENCE");
  if (!decision?.should_request_contact && contactRequestDetected(reply)) violations.push("CONTACT_SENTENCE_WITHOUT_CONTACT_FLAG");

  const invalidKeys = selected.filter((key) => !allowed.has(String(key)));
  if (invalidKeys.length) violations.push("UNKNOWN_CATALOG_KEYS:" + invalidKeys.join(","));
  if (decision?.needs_slides || decision?.action === "reply_with_slides") {
    if (!selected.length) violations.push("MEDIA_REQUEST_WITHOUT_CATALOG");
    const noMediaKeys = selected.filter((key) => !slide.has(String(key)));
    if (noMediaKeys.length) violations.push("CATALOG_WITHOUT_PUBLISHED_MEDIA:" + noMediaKeys.join(","));
  }
  if (sovereignReplyPromisesMedia(reply) && !decision?.needs_slides) violations.push("REPLY_PROMISES_MEDIA_BUT_MEDIA_DISABLED");

  const unresolved = Array.isArray(modelInput?.unresolved_needs) ? modelInput.unresolved_needs : [];
  const pendingMedia = unresolved.filter((need) => need?.status === "pending_media" && Array.isArray(need.catalog_keys) && need.catalog_keys.length);
  if (pendingMedia.length && !(decision?.needs_slides && decision?.action === "reply_with_slides")) {
    violations.push("UNRESOLVED_MEDIA_NEEDS_NOT_SCHEDULED");
  }
  for (const need of pendingMedia) {
    const covered = need.catalog_keys.some((requiredKey) => selected.some((selectedKey) => sovereignCatalogCovers(String(selectedKey), String(requiredKey), allowed)));
    if (!covered) violations.push("UNRESOLVED_PRODUCT_DROPPED:" + (need.topic || need.catalog_keys.join(",")));
  }

  const prior = sovereignRecentPageReply(modelInput);
  if (prior && !sovereignCustomerAskedRepeat(modelInput)) {
    const previous = qualityNormalize(prior.text || "");
    if (previous && replyNorm && previous === replyNorm) violations.push("EXACT_DUPLICATE_RECENT_PAGE_REPLY");
  }

  return [...new Set(violations)];
}

function sovereignValidationError(error) {
  const message = String(error?.message || error || "V10_DECISION_INVALID").replace(/\s+/g, " ").trim();
  return message.slice(0, 300);
}

async function sovereignProviderDecision(provider, modelInput) {
  let feedback = [];
  let firstRawDecision = null;
  let finalRawDecision = null;
  let lastAttempt = null;

  for (let round = 0; round < 2; round += 1) {
    const attemptInput = round === 0
      ? modelInput
      : {
          ...modelInput,
          validation_feedback: {
            validator: "v10_sovereign_feedback_v1",
            instruction: "Correct these validation failures yourself. Preserve all unresolved customer needs and do not repeat the rejected reply.",
            violations: feedback,
          },
        };

    const attempt = await providerCall(provider, attemptInput);
    lastAttempt = attempt;
    if (!firstRawDecision) firstRawDecision = structuredClone(attempt.decision);
    finalRawDecision = structuredClone(attempt.decision);

    let decision = null;
    let violations = [];
    try {
      decision = validateDecision(attempt.decision);
      violations = sovereignDecisionViolations(decision, attemptInput);
    } catch (error) {
      violations = [sovereignValidationError(error)];
    }

    if (!violations.length) {
      return {
        ...attempt,
        decision,
        rawDecision: firstRawDecision,
        finalRawDecision,
        validationFeedbackRounds: round,
        validationFeedback: feedback,
      };
    }

    feedback = violations;
    if (round === 0) {
      const interval = Math.max(250, Math.min(5000, providerMinIntervalMs(provider)));
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  const error = new Error("V10_DECISION_INVALID:" + feedback.join("|"));
  error.code = "decision_invalid";
  error.provider = providerKey(provider);
  error.responseId = lastAttempt?.responseId || null;
  throw error;
}

async function processOne(row, availableProviders, knowledgeSnapshot) {
  const claimed = await claim(row);
  if (!claimed) return { processed: 0, retried: 0, reviewRequired: 0, providerErrors: [] };
  const baseConversation = claimed.input_snapshot?.conversation || {};
  const conversation = await enrichConversationWithDeliveredReplies(claimed, baseConversation);
  const knowledgeAdvisors = buildKnowledgeAdvisors(knowledgeSnapshot, conversation, { maxDocuments: 8, maxCatalog: 20, maxAssetsPerCatalog: 5 });
  const unresolvedNeeds = deriveUnresolvedNeeds(conversation, knowledgeAdvisors);
  const productThreads = deriveProductThreads(unresolvedNeeds, knowledgeAdvisors);
  const modelInput = {
    architecture: ARCHITECTURE,
    authority: {
      ai_is_sole_business_decision_maker: true,
      rules_mapping_catalog_locks_are_advisory_only: true,
      validators_may_reject_but_never_rewrite_business_output: true,
      validation_feedback_returns_to_ai: true,
      product_threads_preserve_independent_product_groups: true,
      hard_safety_already_applied: true,
    },
    conversation,
    customer: claimed.input_snapshot?.customer || {},
    state: claimed.input_snapshot?.state || {},
    unresolved_needs: unresolvedNeeds,
    product_threads: productThreads,
    knowledge_advisors: knowledgeAdvisors,
  };
  const modelInputChars = JSON.stringify(modelInput).length;
  const providerErrors = [];
  const classifications = [];
  const startedAt = Date.now();

  try {
    let result = null;
    const orderedProviders = providerOrder(availableProviders, Date.now(), modelInputChars);
    for (const provider of orderedProviders) {
      const callStartedAt = Date.now();
      try {
        result = await sovereignProviderDecision(provider, modelInput);
        recordProviderSuccess(provider, Date.now() - callStartedAt, modelInputChars);
        await persistProviderRuntimeState(provider, "ready");
        providerCache.lastProviderKey = result.provider;
        break;
      } catch (error) {
        const classification = classifyProviderError(provider, error);
        recordProviderFailure(provider, classification, error, modelInputChars);
        await persistProviderRuntimeState(provider, "cooldown", classification, error);
        classifications.push(classification);
        providerErrors.push(providerKey(provider) + ":" + classification + ":" + String(error?.message || error).slice(0, 260));
      }
    }
    if (!result) throw new Error(providerErrors.join(" | ") || "V10_ALL_AVAILABLE_PROVIDERS_FAILED");

    const decision = result.decision;
    await core("v9_decisions?id=eq." + claimed.id + "&status=eq.shadow_ai_processing", {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_ai_completed",
        action: decision.action,
        confidence: decision.confidence,
        knowledge_version: String(knowledgeSnapshot.version_no) + ":" + String(knowledgeSnapshot.checksum),
        latency_ms: Date.now() - startedAt,
        output: {
          ...decision,
          should_send: decision.action !== "suppress",
          transport_locked: true,
          provider_key: result.provider,
          model_input_chars: modelInputChars,
          model: result.model,
          response_id: result.responseId,
          provider_errors: providerErrors,
          processing_attempts: processingAttempts(claimed),
          decision_errors: decisionErrors(claimed),
          architecture: ARCHITECTURE,
          advisors_were_non_binding: true,
          validator_version: "v10_sovereign_feedback_v1",
          validator_rewrites_business_output: false,
          validator_feedback_rounds: result.validationFeedbackRounds || 0,
          validator_feedback: result.validationFeedback || [],
          raw_ai_decision: result.rawDecision || null,
          final_raw_ai_decision: result.finalRawDecision || null,
          unresolved_needs: unresolvedNeeds,
    product_threads: productThreads,
          legacy_smart_reply_repair_applied: false,
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

// AIGUKA_V10_AI_SOVEREIGN_VALIDATOR_V1

function providerHealthSnapshot() {
  return [...providerHealth.entries()].map(([key, health]) => ({
    provider: key,
    disabled_until: health.disabledUntil ? new Date(health.disabledUntil).toISOString() : null,
    next_allowed_at: health.nextAllowedAt ? new Date(health.nextAllowedAt).toISOString() : null,
    reason: health.reason,
    failures: health.failures,
    successes: health.successes,
    rate_limit_failures: health.rateLimitFailures,
    decision_failures: health.decisionFailures,
    context_limit_chars: health.contextLimitChars || null,
    ewma_latency_ms: health.ewmaLatencyMs || null,
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
        batch_size: BATCH_SIZE,
        load_balancing: "google_primary_then_weighted_fallback",
        google_primary_pool: true,
        google_rate_limit_scope: "per_independent_provider_project",
        circuit_breaker: true,
        retry_after_respected: true,
        lease_ms: LEASE_MS,
        gemini_min_interval_ms: GEMINI_MIN_INTERVAL_MS,
        gemini_cooldown_until: null,
        provider_cooldown_is_per_key: true,
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
    ready.sort(function (left, right) {
      const leftMessages = left?.input_snapshot?.conversation?.messages || [];
      const rightMessages = right?.input_snapshot?.conversation?.messages || [];
      const leftMedia = explicitMediaRequestFromMessages(leftMessages);
      const rightMedia = explicitMediaRequestFromMessages(rightMessages);
      if (leftMedia !== rightMedia) return leftMedia ? -1 : 1;
      const leftTime = Date.parse(left?.created_at || "") || 0;
      const rightTime = Date.parse(right?.created_at || "") || 0;
      return leftMedia ? rightTime - leftTime : leftTime - rightTime;
    }); // explicit_media_backlog_first

    if (ready.length) {
      const providerRows = await providers();
      let snapshot = null;
      for (const row of ready.slice(0, BATCH_SIZE)) {
        const availability = providerAvailability(providerRows, Date.now());
        if (!availability.available.length) {
          providerWait = true;
          await scheduleWithoutClaim(row, availability.nextAvailableAt, "NO_AI_PROVIDER_CURRENTLY_AVAILABLE");
          continue;
        }
        snapshot ||= await publishedKnowledge();
        const result = await processOne(row, availability.available, snapshot);
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
      provider_failover_enabled: true,
      queue_retry_guarantee: true,
    });
  } catch (error) {
    await heartbeat("degraded", error?.message || error, {
      processed_last_tick: processed,
      stale_processing_found: recovery.stale,
      operational_fallback_enabled: false,
      provider_failover_enabled: true,
      queue_retry_guarantee: true,
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

// AIGUKA_V10_DECISION_INTEGRITY_V9

// AIGUKA_V10_DECISION_INTEGRITY_V10

// AIGUKA_V10_MEDIA_OBLIGATION_INTEGRITY_V1

// AIGUKA_PROVIDER_RESILIENCE_V1

// AIGUKA_V10_GENERAL_PRODUCT_SALES_FINALIZED_V2_SMART_REPAIR

// AIGUKA_V10_PRODUCT_THREAD_AI_V1

// AIGUKA_V10_ACTIVE_INTENT_FOCUS_V1
