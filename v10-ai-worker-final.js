import crypto from "node:crypto";
import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v10/core/decision-contract.js";
import { buildKnowledgeAdvisors } from "./v10/core/knowledge-advisor.js";
import { deriveUnresolvedNeeds } from "./v10/core/unresolved-needs.js";
import { deriveProductThreads } from "./v10/core/product-threads.js";
import { deriveMediaScope, explicitMediaRequestFromMessages, mediaExpectedFromMessages } from "./v10/core/media-obligation.js";
import {
  commerceDecisionViolations,
  commerceRequestContext,
  enforceCommerceIntegrity,
  vietnameseLanguageIssue,
} from "./v10/core/commerce-integrity.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-ai";
const VERSION = "v10_ai_commerce_integrity_v20"; // AIGUKA_PROVIDER_LOAD_BALANCER_V4 // AIGUKA_PROVIDER_RESILIENCE_V1
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
const ARCHITECTURE = "v10_ai_hard_commerce_integrity";
const ACCEPTED_INPUT_ARCHITECTURES = new Set([ARCHITECTURE, "v10_ai_sovereign_advisory"]);

function acceptedInputArchitecture(value) {
  return ACCEPTED_INPUT_ARCHITECTURES.has(String(value || ""));
}

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
    if (!acceptedInputArchitecture(row?.input_snapshot?.architecture)) continue;
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
    .replace(/ƒë/g, "d")
    .replace(/ƒê/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s/+_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DECISION_LEAK_PATTERN = /(selected_catalog_keys|selected_products|final_reply|decision_reason|needs_slides|follow_up_plan|tool[_ .-]?call|system prompt|schema|not a valid key|we need|customer mentioned|provide concise|keep reply|internal reasoning|analysis:|assistant to=|developer message|hidden instruction|zddw)/i;
const DECISION_GIBBERISH_PATTERN = /[≈è≈é]|\b(showoom|b√®n em|ph√≥ keo|gia l√†m|n≈èii)\b/i;

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

  if (selfRef("co") || preferred === "co") return { customer: "c√¥", self: "ch√°u" };
  if (selfRef("chu") || preferred === "chu") return { customer: "ch√∫", self: "ch√°u" };
  if (selfRef("bac") || preferred === "bac") return { customer: "b√°c", self: "ch√°u" };
  if (selfRef("chi") || preferred === "chi") return { customer: "ch·ªã", self: "em" };
  if (selfRef("anh") || preferred === "anh") return { customer: "anh", self: "em" };
  return { customer: "anh/ch·ªã", self: "em" };
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
  if (["c√¥", "ch√∫", "b√°c"].includes(style.customer)) {
    text = text
      .replace(/\banh\s*\/\s*ch·ªã\b/gi, style.customer)
      .replace(/\banh ch·ªã\b/gi, style.customer)
      .replace(/\bch·ªã\b/gi, style.customer)
      .replace(/\banh\b/gi, style.customer)
      .replace(/\bb√™n em\b/gi, "b√™n " + style.self)
      .replace(/\bem\b/gi, style.self);
    if (!(new RegExp("\\b" + style.customer + "\\b", "i")).test(text)) {
      text = "D·∫° " + style.customer + ", " + text.charAt(0).toLocaleLowerCase("vi-VN") + text.slice(1);
    }
  } else if (style.customer === "ch·ªã") {
    text = text.replace(/\banh\s*\/\s*ch·ªã\b/gi, "ch·ªã").replace(/\banh ch·ªã\b/gi, "ch·ªã");
  } else if (style.customer === "anh") {
    text = text.replace(/\banh\s*\/\s*ch·ªã\b/gi, "anh").replace(/\banh ch·ªã\b/gi, "anh");
  } else {
    text = text
      .replace(/\bAnh ƒëang\b/g, "Anh/ch·ªã ƒëang")
      .replace(/\bCh·ªã ƒëang\b/g, "Anh/ch·ªã ƒëang")
      .replace(/\bem g·ª≠i anh\b/gi, "em g·ª≠i anh/ch·ªã")
      .replace(/\bem g·ª≠i ch·ªã\b/gi, "em g·ª≠i anh/ch·ªã");
  }
  if (style.customer === "anh/ch·ªã") {
    const placeholder = "__AIGUKA_CUSTOMER__";
    text = text
      .replace(/anh\s*\/\s*ch·ªã/gi, placeholder)
      .replace(/\banh\b/gi, "anh/ch·ªã")
      .replace(/\bch·ªã\b/gi, "anh/ch·ªã")
      .replace(new RegExp(placeholder, "g"), "anh/ch·ªã");
  }
  text = text
    .replace(/anh\s*\/\s*ch·ªã(?:\s*\/\s*(?:anh|ch·ªã))+/gi, "anh/ch·ªã")
    .replace(/\b(c√¥|ch√∫|b√°c|ch·ªã|anh)(?:\s*\/\s*\1)+\b/gi, "$1")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([.!?])\s+([a-z√†-·ªπƒë])/g, function (_match, punctuation, letter) { return punctuation + " " + letter.toLocaleUpperCase("vi-VN"); });
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
  const priceMatches = String(reply || "").match(/\b\d[\d\s.,-]*(?:k|tr|tri·ªáu|trieu|ƒë·ªìng|dong|vnd|‚Ç´)\b/gi) || [];
  if (!priceMatches.length) return false;
  const knowledge = verifiedKnowledgeText(modelInput).replace(/[\s.,/_+‚Äì‚Äî-]+/g, "");
  return priceMatches.some(function (match) {
    const normalized = qualityNormalize(match).replace(/[\s.,/_+‚Äì‚Äî-]+/g, "");
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
  if (vietnameseLanguageIssue(text)) return true;
  const normalized = qualityNormalize(text);
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text) || /[ÔøΩ√•√§√∂√º√¶√∏√ü≈Ç≈ÅƒáƒÜ≈õ≈ö≈∫≈π≈º≈ª≈Ñ≈É]/i.test(text)) return true;
  if (/\b(cosi|ldo|showoom|gia lam noii|zddw)\b/i.test(normalized)) return true;
  if (/\b(?:ld|dd|lƒë)[a-z]{1,8}\b/i.test(normalized)) return true;
  const words = text.match(/[A-Za-z√Ä-·ªπƒêƒë]+/g) || [];
  const endingIWhitelist = new Set(["gi", "thi", "vi", "mi", "li", "ki", "khi"]);
  for (const word of words) {
    const clean = qualityNormalize(word);
    if (/[√¨√≤√®√π]$/i.test(word) && clean.length > 3 && !endingIWhitelist.has(clean)) return true;
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
  const priceMatches = String(reply || "").match(/\b\d[\d\s.,-]*(?:k|tr|tri·ªáu|trieu|ƒë·ªìng|dong|vnd|‚Ç´)\b/gi) || [];
  if (!priceMatches.length) return false;
  const knowledge = verifiedKnowledgeText(modelInput).replace(/[\s.,/_+‚Äì‚Äî-]+/g, "");
  return priceMatches.every(function (match) {
    const normalized = qualityNormalize(match).replace(/[\s.,/_+‚Äì‚Äî-]+/g, "");
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

  let category = "m·∫´u s·∫£n ph·∫©m";
  if (/\b(bon cau|bet ve sinh|bet)\b/.test(normalized)) category = "b·ªìn c·∫ßu";
  else if (/\b(quat tran|quat)\b/.test(normalized)) category = "qu·∫°t tr·∫ßn";
  else if (/\b(bep tu|bep dien|may hut mui|hut mui)\b/.test(normalized)) category = "s·∫£n ph·∫©m ph√≤ng b·∫øp";
  else if (/\b(sen tam|sen cay)\b/.test(normalized)) category = "sen t·∫Øm";
  else if (/\b(lavabo|chau rua mat)\b/.test(normalized)) category = "lavabo";
  else if (/\b(chau rua bat|voi rua bat)\b/.test(normalized)) category = "ch·∫≠u/v√≤i r·ª≠a b√°t";

  const brandModelMatches = raw.match(/[A-Za-z√Ä-·ªπƒêƒë]{3,24}\s+[A-Za-z]{1,8}[-_.\/]?\d{2,6}[A-Za-z0-9._\/-]*/g) || [];
  const codeMatches = raw.match(/\b[A-Za-z]{1,8}[-_.\/]?\d{2,6}[A-Za-z0-9._\/-]*\b/g) || [];
  let reference = brandModelMatches.length ? brandModelMatches[brandModelMatches.length - 1] : (codeMatches[codeMatches.length - 1] || "");
  const firstWord = qualityNormalize(reference).split(" ")[0] || "";
  if (["cau", "quat", "bep", "sen", "voi", "chau", "mau", "pham"].includes(firstWord) && codeMatches.length) {
    reference = codeMatches[codeMatches.length - 1];
  }
  reference = String(reference || "").replace(/[.,!?;:]+$/g, "").trim();

  if (reference) return category + " " + reference;
  if (category !== "m·∫´u s·∫£n ph·∫©m") return category + " anh/ch·ªã ƒëang quan t√¢m";
  return "m·∫´u s·∫£n ph·∫©m anh/ch·ªã ƒëang quan t√¢m";
}

// AIGUKA_V10_SPECIFIC_PRICE_CONTACT_V1

function safePriceReply(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = generalSalesSubject(modelInput);
  const text = known
    ? "D·∫°, gi√° c·ªßa " + subject + " c√≤n ph·ª• thu·ªôc ƒë√∫ng m·∫´u/phi√™n b·∫£n v√† ∆∞u ƒë√£i t·∫°i th·ªùi ƒëi·ªÉm ki·ªÉm tra. Em chuy·ªÉn chuy√™n vi√™n s·∫£n ph·∫©m x√°c nh·∫≠n v√† g·ª≠i b√°o gi√° chu·∫©n theo th√¥ng tin li√™n h·ªá m√¨nh ƒë√£ ƒë·ªÉ l·∫°i ·∫°."
    : "D·∫°, gi√° c·ªßa " + subject + " c√≤n ph·ª• thu·ªôc ƒë√∫ng m·∫´u/phi√™n b·∫£n v√† ∆∞u ƒë√£i t·∫°i th·ªùi ƒëi·ªÉm ki·ªÉm tra. Anh/ch·ªã cho em xin SƒêT ho·∫∑c Zalo, em chuy·ªÉn chuy√™n vi√™n s·∫£n ph·∫©m x√°c nh·∫≠n, g·ª≠i m·∫´u chu·∫©n v√† b√°o gi√° hi·ªán t·∫°i ·∫°.";
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
    .replace(/^\s*(?:ch√†o|xin ch√†o)[^.!?]{0,80}[.!?]\s*/i, "")
    .replace(/^\s*(?:d·∫°[, ]*)?(?:em|ch√°u)\s+l√†\s+(?:nh√¢n vi√™n|t∆∞ v·∫•n vi√™n|tr·ª£ l√Ω|c·ªë v·∫•n|È°æÈóÆ)[^.!?]{0,160}[.!?]?\s*/i, "")
    .replace(/^\s*(?:em|ch√°u)\s+(?:ƒë·∫øn|t·ª´)\s+showroom[^.!?]{0,120}[.!?]?\s*/i, "")
    .trim();
  return text;
}

function specialistHandoffDetected(value) {
  const text = qualityNormalize(value);
  return /\b(chuyen|noi|gui|nh·ªù).{0,28}\b(sale|nhan vien kinh doanh|tu van vien|chuyen vien|chuyen vien san pham)\b|\b(sale|nhan vien kinh doanh|tu van vien|chuyen vien|chuyen vien san pham).{0,36}\b(kiem tra|bao gia|lien he|tu van|gui mau|xac nhan)\b/.test(text);
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
  const subject = typeof specificPriceSubject === "function" ? specificPriceSubject(modelInput) : "m·∫´u s·∫£n ph·∫©m anh/ch·ªã ƒëang quan t√¢m";
  return String(subject || "m·∫´u s·∫£n ph·∫©m anh/ch·ªã ƒëang quan t√¢m")
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
    text = "D·∫°, ph·∫ßn " + subject + " c√≤n ph·ª• thu·ªôc ƒë√∫ng m√£/phi√™n b·∫£n n√™n em ch∆∞a mu·ªën b√°o sai. Anh/ch·ªã g·ª≠i th√™m ·∫£nh ho·∫∑c m√£ ƒë·∫ßy ƒë·ªß, em h·ªó tr·ª£ ti·∫øp ngay t·∫°i ƒë√¢y ·∫°.";
  } else if (known) {
    text = "D·∫°, ph·∫ßn " + subject + " c√≤n ph·ª• thu·ªôc ƒë√∫ng m·∫´u/phi√™n b·∫£n n√™n em ch∆∞a mu·ªën b√°o sai. Em chuy·ªÉn chuy√™n vi√™n s·∫£n ph·∫©m ki·ªÉm tra v√† g·ª≠i m·∫´u chu·∫©n, b√°o gi√° c√πng ∆∞u ƒë√£i hi·ªán t·∫°i theo th√¥ng tin li√™n h·ªá m√¨nh ƒë√£ ƒë·ªÉ l·∫°i ·∫°.";
  } else {
    text = "D·∫°, ph·∫ßn " + subject + " c√≤n ph·ª• thu·ªôc ƒë√∫ng m·∫´u/phi√™n b·∫£n n√™n em ch∆∞a mu·ªën b√°o sai. Anh/ch·ªã cho em xin SƒêT ho·∫∑c Zalo, em chuy·ªÉn chuy√™n vi√™n s·∫£n ph·∫©m ki·ªÉm tra, g·ª≠i m·∫´u chu·∫©n, b√°o gi√° v√† ∆∞u ƒë√£i hi·ªán t·∫°i ·∫°.";
  }
  return applySalutation(text, style);
}

function smartContactSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Anh/ch·ªã cho em xin SƒêT ho·∫∑c Zalo, em chuy·ªÉn chuy√™n vi√™n s·∫£n ph·∫©m g·ª≠i m·∫´u chu·∫©n, b√°o gi√° v√† ∆∞u ƒë√£i hi·ªán t·∫°i ·∫°.", style);
}

function smartKnownContactSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Em chuy·ªÉn chuy√™n vi√™n s·∫£n ph·∫©m ki·ªÉm tra ƒë√∫ng m·∫´u/phi√™n b·∫£n v√† ph·∫£n h·ªìi theo th√¥ng tin li√™n h·ªá m√¨nh ƒë√£ ƒë·ªÉ l·∫°i ·∫°.", style);
}

function smartSpecialistReasonSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Em chuy·ªÉn chuy√™n vi√™n s·∫£n ph·∫©m ki·ªÉm tra ƒë√∫ng m·∫´u/phi√™n b·∫£n ƒë·ªÉ t∆∞ v·∫•n v√† b√°o gi√° chu·∫©n cho m√¨nh ·∫°.", style);
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
    ? "chuy√™n vi√™n s·∫£n ph·∫©m ki·ªÉm tra ƒë√∫ng m·∫´u/phi√™n b·∫£n v√† ph·∫£n h·ªìi theo li√™n h·ªá ƒë√£ c√≥"
    : refused
      ? "ti·∫øp t·ª•c h·ªó tr·ª£ t·∫°i Messenger, xin th√™m ·∫£nh ho·∫∑c m√£ ƒë·∫ßy ƒë·ªß khi c·∫ßn"
      : shouldAskContact
        ? "chuy√™n vi√™n s·∫£n ph·∫©m g·ª≠i m·∫´u chu·∫©n, b√°o gi√° v√† ∆∞u ƒë√£i hi·ªán t·∫°i"
        : "tr·∫£ l·ªùi tr·ª±c ti·∫øp ph·∫ßn d·ªØ li·ªáu ƒë√£ ch·∫Øc ch·∫Øn";
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
  let subject = "m·∫´u s·∫£n ph·∫©m anh/ch·ªã ƒëang quan t√¢m";

  const active = activeProductText(modelInput);
  if (/quat_10_canh|quat_tran/.test(joined) || /\bquat.{0,20}10(?: canh)?\b/.test(latest + " " + active)) {
    const color = /\bmau vang\b/.test(latest) ? " m√†u v√†ng" : /\bmau den\b/.test(latest) ? " m√†u ƒëen" : /\bmau nau\b/.test(latest) ? " m√†u n√¢u" : /\bvan go\b/.test(latest) ? " m√†u v√¢n g·ªó" : "";
    const size = /\b1\s*[,.]?\s*67\b|\b1m67\b/.test(latest) ? ", s·∫£i c√°nh 1,67 m" : "";
    subject = "m·∫´u qu·∫°t tr·∫ßn 10 c√°nh" + color + size;
  } else if (keys.includes("bep_tu_hut_mui") && keys.includes("chau_voi_rua_bat")) {
    subject = "c√°c m·∫´u ph√≤ng b·∫øp g·ªìm b·∫øp t·ª´‚Äìh√∫t m√πi v√† ch·∫≠u‚Äìv√≤i";
  } else if (keys.includes("bep_tu_hut_mui")) {
    subject = "c√°c m·∫´u b·∫øp t·ª´ v√† m√°y h√∫t m√πi";
  } else if (keys.includes("chau_voi_rua_bat")) {
    subject = "c√°c m·∫´u ch·∫≠u v√† v√≤i r·ª≠a b√°t";
  } else if (/bon_cau/.test(joined)) {
    subject = "c√°c m·∫´u b·ªìn c·∫ßu ph√π h·ª£p";
  } else if (/combo_phong_tam/.test(joined)) {
    subject = "c√°c m·∫´u combo ph√≤ng t·∫Øm";
  }

  let text = "D·∫°, " + (decision.needs_slides ? "em g·ª≠i anh/ch·ªã " : "em ƒë√£ ghi nh·∫≠n ") + subject + (decision.needs_slides ? " ƒë·ªÉ tham kh·∫£o ·∫°." : " ·∫°.");
  if (!known && decision.should_request_contact) {
    text += " Anh/ch·ªã cho em xin SƒêT ho·∫∑c Zalo, b√™n em ki·ªÉm tra ƒë√∫ng m·∫´u v√† b√°o gi√° ch√≠nh x√°c nh√©.";
  } else if (known && /\b(mua|lay|dat|1c|1 chiec)\b/.test(latest)) {
    text += " B√™n em ƒë√£ nh·∫≠n s·ªë v√† chuy·ªÉn Sale li√™n h·ªá t∆∞ v·∫•n cho m√¨nh ·∫°.";
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
  if (knowledge.includes("254 pho keo kim son gia lam ha noi")) addresses.push("254 Ph·ªë Keo, Kim S∆°n, Gia L√¢m, H√† N·ªôi");
  if (knowledge.includes("pho dan tri qua thuan thanh bac ninh")) addresses.push("Ph·ªë D√†n, Tr√≠ Qu·∫£, Thu·∫≠n Th√†nh, B·∫Øc Ninh");
  if (knowledge.includes("khu do thi dinh to luxury homes thuan thanh bac ninh")) addresses.push("Khu ƒë√¥ th·ªã ƒê√¨nh T·ªï Luxury Homes, Thu·∫≠n Th√†nh, B·∫Øc Ninh");
  if (knowledge.includes("khu do thi khai son long bien ha noi")) addresses.push("Khu ƒë√¥ th·ªã Khai S∆°n, Long Bi√™n, H√† N·ªôi");
  if (!addresses.length) return "";

  let selected = addresses;
  if (/\b(bac ninh|thuan thanh|tri qua|pho dan|dinh to)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /B·∫Øc Ninh|Thu·∫≠n Th√†nh/i.test(address); });
  } else if (/\b(long bien|khai son)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Long Bi√™n|Khai S∆°n/i.test(address); });
  } else if (/\b(gia lam|kim son|pho keo|hung yen|thuong tin|ha noi)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Gia L√¢m|Long Bi√™n/i.test(address); });
  }
  if (!selected.length) selected = addresses;
  return "Showroom √ÅNH D∆Ø∆†NG c√≥ " + selected.map(function (address) { return "c∆° s·ªü t·∫°i " + address; }).join("; ") + ".";
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
  decision.final_reply = "D·∫°, anh/ch·ªã ƒëang mu·ªën xem m·∫´u s·∫£n ph·∫©m n√†o ƒë·ªÉ em g·ª≠i ƒë√∫ng nh√≥m ·∫°?";
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
    prefixes.push("Em g·ª≠i l·∫°i ·∫£nh tr·ª±c ti·∫øp tr√™n Messenger ƒë·ªÉ anh/ch·ªã m·ªü v√† xem r√µ h∆°n ·∫°.");
  }
  if (known && currentTurnContainsPhone(modelInput) && !replyAcknowledgesContact(text)) {
    prefixes.push("D·∫°, em ƒë√£ nh·∫≠n s·ªë ƒëi·ªán tho·∫°i c·ªßa anh/ch·ªã r·ªìi ·∫°.");
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
      ? "D·∫° gi√° m·∫´u n√†y c√≤n t√πy m√†u v√† phi√™n b·∫£n. B√™n em ƒë√£ nh·∫≠n s·ªë c·ªßa anh/ch·ªã v√† s·∫Ω ki·ªÉm tra ƒë√∫ng m·∫´u ƒë·ªÉ b√°o gi√° ch√≠nh x√°c ·∫°."
      : "D·∫° gi√° m·∫´u n√†y c√≤n t√πy m√†u v√† phi√™n b·∫£n. Anh/ch·ªã cho em xin SƒêT ho·∫∑c Zalo, b√™n em ki·ªÉm tra ƒë√∫ng m·∫´u v√† b√°o gi√° ch√≠nh x√°c ·∫°.";
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
    decision.final_reply = "D·∫° " + style.customer + ", " + style.self + " ƒë√£ ghi nh·∫≠n s·ªë v√† chuy·ªÉn y√™u c·∫ßu g·ªçi t∆∞ v·∫•n ngay ·∫°.";
  } else {
    decision.final_reply = applySalutation(decision.final_reply || reply, style);
  }

  const knownAtFinal = contactIsKnown(modelInput);
  if (priceIntentDetected(decision, modelInput) && !replyContainsVerifiedPrice(decision.final_reply, modelInput)) {
    decision.final_reply = safePriceReply(decision, modelInput);
    decision.contact_state = knownAtFinal ? "known" : "missing";
    decision.should_request_contact = !knownAtFinal;
    decision.contact_benefit = knownAtFinal
      ? "g·ª≠i m·∫´u, b√°o gi√° ch√≠nh x√°c v√† ∆∞u ƒë√£i hi·ªán t·∫°i theo th√¥ng tin li√™n h·ªá ƒë√£ c√≥"
      : "g·ª≠i m·∫´u, b√°o gi√° ch√≠nh x√°c v√† ∆∞u ƒë√£i hi·ªán t·∫°i";
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
  let text = "D·∫°, em ƒë√£ ghi nh·∫≠n th√¥ng tin m√¨nh v·ª´a g·ª≠i v√† ti·∫øp t·ª•c h·ªó tr·ª£ ƒë√∫ng n·ªôi dung n√†y ·∫°.";
  if (/\bnga tu so\b/.test(current)) {
    text = "D·∫°, em ghi nh·∫≠n ch·ªã ·ªü g·∫ßn Ng√£ T∆∞ S·ªü, H√† N·ªôi ·∫°. Em s·∫Ω t∆∞ v·∫•n theo ƒë√∫ng khu v·ª±c n√†y cho ch·ªã.";
  } else if (/\b(o gan|khu vuc|ha noi|hn|nga tu)\b/.test(current)) {
    text = "D·∫°, em ghi nh·∫≠n khu v·ª±c c·ªßa anh/ch·ªã r·ªìi ·∫°. Em s·∫Ω t∆∞ v·∫•n v√† ki·ªÉm tra v·∫≠n chuy·ªÉn theo ƒë√∫ng khu v·ª±c n√†y.";
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
    decision.contact_benefit = "ƒë√£ v·ª´a xin SƒêT/Zalo; ch·ªù √≠t nh·∫•t 2 tin nh·∫Øn m·ªõi c·ªßa kh√°ch tr∆∞·ªõc khi nh·∫Øc l·∫°i";
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
  violations.push(...commerceDecisionViolations(decision, modelInput));

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

  const commerceContext = commerceRequestContext(modelInput);
  const unresolved = Array.isArray(modelInput?.unresolved_needs) ? modelInput.unresolved_needs : [];
  const pendingMedia = unresolved.filter((need) => need?.status === "pending_media" && Array.isArray(need.catalog_keys) && need.catalog_keys.length);
  const mediaHandoffRequired = commerceContext.specific || Boolean(commerceContext.comment);
  if (!mediaHandoffRequired && pendingMedia.length && !(decision?.needs_slides && decision?.action === "reply_with_slides")) {
    violations.push("UNRESOLVED_MEDIA_NEEDS_NOT_SCHEDULED");
  }
  for (const need of mediaHandoffRequired ? [] : pendingMedia) {
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
            instruction: "Correct these validation failures yourself. Preserve all unresolve◊æ˚“⁄$z{-ÆÈ‹j◊ùî†°¡…Ωë’ç–§ÄÙ¯Å¡…Ωë’ç–ÄòòÄ°—ï·–π•πç±’ëïÃ°¡…Ωë’ç–§ÅÒÅ¡…Ωë’ç–π•πç±’ëïÃ°πΩ…µÖ±•ÈïY•ï—πÖµïÕî°πΩëîπçÖ—Ö±Ωù}≠ï‰§§§§§ÅçΩπ—•π’îÏ(ÄÄÄÄÄÅçΩπÕ–Å…ΩΩ–ÄÙÅM—…•πú°πΩëîπ…ΩΩ—}≠ï‰ÅÒÄàà§π—…•¥†§Ï(ÄÄÄÄÄÅÖëëMçΩ¡î°πΩëï	Â-ï‰π°ÖÃ°…ΩΩ–§Ä¸Å…ΩΩ–ÄËÅπΩëîπçÖ—Ö±Ωù}≠ï‰§Ï(ÄÄÄÅÙ(ÄÅÙ((ÄÅô’πç—•Ω∏Å•Õ]•—°•πMçΩ¡î°πΩëî∞ÅÕçΩ¡ï-ï‰§ÅÏ(ÄÄÄÅ±ï–Åç’……ïπ—-ï‰ÄÙÅM—…•πú°πΩëî¸πçÖ—Ö±Ωù}≠ï‰ÅÒÄàà§π—…•¥†§Ï(ÄÄÄÅçΩπÕ–ÅŸ•Õ•—ïêÄÙÅπï‹ÅMï–†§Ï(ÄÄÄÅ›°•±îÄ°ç’……ïπ—-ï‰ÄòòÄÖŸ•Õ•—ïêπ°ÖÃ°ç’……ïπ—-ï‰§§ÅÏ(ÄÄÄÄÄÅ•òÄ°ç’……ïπ—-ï‰ÄÙÙÙÅÕçΩ¡ï-ï‰§Å…ï—’…∏Å—…’îÏ(ÄÄÄÄÄÅŸ•Õ•—ïêπÖëê°ç’……ïπ—-ï‰§Ï(ÄÄÄÄÄÅç’……ïπ—-ï‰ÄÙÅM—…•πú°πΩëï	Â-ï‰πùï–°ç’……ïπ—-ï‰§¸π¡Ö…ïπ—}≠ï‰ÅÒÄàà§π—…•¥†§Ï(ÄÄÄÅÙ(ÄÄÄÅ…ï—’…∏ÅôÖ±ÕîÏ(ÄÅÙ((ÄÅô’πç—•Ω∏ÅÖπçïÕ—…‰°≠ï‰§ÅÏ(ÄÄÄÅçΩπÕ–ÅΩ’—¡’–ÄÙÅmtÏ(ÄÄÄÅ±ï–Åç’…ÕΩ»ÄÙÅM—…•πú°≠ï‰ÅÒÄàà§π—…•¥†§Ï(ÄÄÄÅçΩπÕ–ÅŸ•Õ•—ïêÄÙÅπï‹ÅMï–†§Ï(ÄÄÄÅ›°•±îÄ°ç’…ÕΩ»ÄòòÄÖŸ•Õ•—ïêπ°ÖÃ°ç’…ÕΩ»§§ÅÏ(ÄÄÄÄÄÅΩ’—¡’–π¡’Õ†°ç’…ÕΩ»§Ï(ÄÄÄÄÄÅŸ•Õ•—ïêπÖëê°ç’…ÕΩ»§Ï(ÄÄÄÄÄÅç’…ÕΩ»ÄÙÅM—…•πú°πΩëï	Â-ï‰πùï–°ç’…ÕΩ»§¸π¡Ö…ïπ—}≠ï‰ÅÒÄàà§π—…•¥†§Ï(ÄÄÄÅÙ(ÄÄÄÅ…ï—’…∏ÅΩ’—¡’–Ï(ÄÅÙ((ÄÅô’πç—•Ω∏Å¡…Ωë’ç—…Ω’¿°ÕçΩ¡ï-ï‰§ÅÏ(ÄÄÄÅçΩπÕ–Å¡Ö—†ÄÙÅÖπçïÕ—…‰°ÕçΩ¡ï-ï‰§Ï(ÄÄÄÅ•òÄ°¡Ö—†π•πç±’ëïÃ†â¡°Ωπù}—Ö¥à§§Å…ï—’…∏Äâ¡°Ωπù}—Ö¥àÏ(ÄÄÄÅ•òÄ°¡Ö—†π•πç±’ëïÃ†â¡°Ωπù}âï¿à§§Å…ï—’…∏Äâ¡°Ωπù}âï¿àÏ(ÄÄÄÅ•òÄ°¡Ö—†π•πç±’ëïÃ†âùÖç°}πùΩ§à§ÅÒÅ¡Ö—†π•πç±’ëïÃ†âùÖç°}ëÖ}Ω¡}±Ö–à§§Å…ï—’…∏ÄâùÖç°}Ω¡}±Ö–àÏ(ÄÄÄÅ•òÄ°¡Ö—†π•πç±’ëïÃ†â≈’Ö—}—…Ö∏à§ÅÒÅ¡Ö—†πÕΩµî†°≠ï‰§ÄÙ¯Å≠ï‰πÕ—Ö…—Õ]•—††â≈’Ö—|à§§§Å…ï—’…∏Äâ≈’Ö—}—…Ö∏àÏ(ÄÄÄÅ…ï—’…∏Å¡Ö—†πÖ–†¥ƒ§ÅÒÅM—…•πú°ÕçΩ¡ï-ï‰ÅÒÄâΩ—°ï»à§Ï(ÄÅÙ((ÄÅô’πç—•Ω∏Å¡…Ωë’ç—…Ω’¡1Öâï∞°ù…Ω’¡-ï‰§ÅÏ(ÄÄÄÅ•òÄ°ù…Ω’¡-ï‰ÄÙÙÙÄâ¡°Ωπù}—Ö¥à§Å…ï—’…∏ÄâQ°ßÜÍ˝–ÅãÜÓ,Å¡£…πúÅ”ÜÍΩ¥àÏ(ÄÄÄÅ•òÄ°ù…Ω’¡-ï‰ÄÙÙÙÄâ¡°Ωπù}âï¿à§Å…ï—’…∏ÄâQ°ßÜÍ˝–ÅãÜÓ,Åπ£ÄÅãÜÍ˝¿àÏ(ÄÄÄÅ•òÄ°ù…Ω’¡-ï‰ÄÙÙÙÄâùÖç°}Ω¡}±Ö–à§Å…ï—’…∏ÄâÜÍÖç†ÉÜÓE¿Å≥Ö–àÏ(ÄÄÄÅ•òÄ°ù…Ω’¡-ï‰ÄÙÙÙÄâ≈’Ö—}—…Ö∏à§Å…ï—’…∏ÄâE◊ÜÍÖ–Å—ÀÜÍù∏àÏ(ÄÄÄÅ…ï—’…∏ÅM—…•πú°πΩëï	Â-ï‰πùï–°ù…Ω’¡-ï‰§¸πë•Õ¡±ÖÂ}πÖµîÅÒÅù…Ω’¡-ï‰ÅÒÄâ7ÜÍ≠‘ÅœÜÍç∏Å¡£ÜÍ•¥à§Ï(ÄÅÙ((ÄÅçΩπÕ–ÅÕçΩ¡ïÃÄÙÅ…ï≈’ïÕ—ïëMçΩ¡ïÃπô•±—ï»†°ÕçΩ¡ï-ï‰§ÄÙ¯ÄÖ…ï≈’ïÕ—ïëMçΩ¡ïÃπÕΩµî†°Ω—°ï…-ï‰§ÄÙ¯ÅÏ(ÄÄÄÅ•òÄ°Ω—°ï…-ï‰ÄÙÙÙÅÕçΩ¡ï-ï‰§Å…ï—’…∏ÅôÖ±ÕîÏ(ÄÄÄÅ…ï—’…∏Å•Õ]•—°•πMçΩ¡î°πΩëï	Â-ï‰πùï–°ÕçΩ¡ï-ï‰§∞ÅΩ—°ï…-ï‰§Ï(ÄÅÙ§§Ï((ÄÅçΩπÕ–ÅÕïï∏ÄÙÅπï‹ÅMï–†§Ï(ÄÅçΩπÕ–Å…ïÕΩ±ŸïëMçΩ¡ïÃÄÙÅmtÏ(ÄÅçΩπÕ–Åâ’πë±ï5Ö¿ÄÙÅπï‹Å5Ö¿†§Ï((ÄÅôΩ»Ä°çΩπÕ–ÅÕçΩ¡ï-ï‰ÅΩòÅÕçΩ¡ïÃ§ÅÏ(ÄÄÄÅçΩπÕ–Åç°•±ë…Ω’¡ÃÄÙÅmtÏ(ÄÄÄÅôΩ»Ä°çΩπÕ–ÅπΩëîÅΩòÅπΩëïÃπô•±—ï»†°çÖπë•ëÖ—î§ÄÙ¯Å•Õ]•—°•πMçΩ¡î°çÖπë•ëÖ—î∞ÅÕçΩ¡ï-ï‰§§§ÅÏ(ÄÄÄÄÄÅçΩπÕ–ÅÖÕÕï—ÃÄÙÅmtÏ(ÄÄÄÄÄÅôΩ»Ä°çΩπÕ–ÅÖÕÕï–ÅΩòÅ……Ö‰π•Õ……Ö‰°πΩëîπÖÕÕï—Ã§Ä¸ÅπΩëîπÖÕÕï—ÃÄËÅmt§ÅÏ(ÄÄÄÄÄÄÄÅçΩπÕ–ÅÕΩ’…çïU…∞ÄÙÅŸÖ±•ë!——¡U…∞°ÖÕÕï–πÕΩ’…çï}’…∞§Ï(ÄÄÄÄÄÄÄÅ•òÄ†ÖÕΩ’…çïU…∞ÅÒÄΩë…•ŸïpπùΩΩù±ïpπçΩµpΩë…•ŸïpΩôΩ±ëï…ÕpºΩ§π—ïÕ–°ÕΩ’…çïU…∞§ÅÒÅÕïï∏π°ÖÃ°ÕΩ’…çïU…∞§§ÅçΩπ—•π’îÏ(ÄÄÄÄÄÄÄÅÕïï∏πÖëê°ÕΩ’…çïU…∞§Ï(ÄÄÄÄÄÄÄÅÖÕÕï—Ãπ¡’Õ†°Ï(ÄÄÄÄÄÄÄÄÄÅÖÕÕï—}•êËÅÖÕÕï–πÖÕÕï—}•êÅÒÅπ’±∞∞(ÄÄÄÄÄÄÄÄÄÅçÖ—Ö±Ωù}≠ï‰ËÅÕçΩ¡ï-ï‰∞(ÄÄÄÄÄÄÄÄÄÅÕΩ’…çï}çÖ—Ö±Ωù}≠ï‰ËÅπΩëîπçÖ—Ö±Ωù}≠ï‰∞(ÄÄÄÄÄÄÄÄÄÅ—•—±îËÅÖÕÕï–π—•—±îÅÒÅπΩëîπë•Õ¡±ÖÂ}πÖµîÅÒÄâ7ÜÍ≠‘ÅœÜÍç∏Å¡£ÜÍ•¥à∞(ÄÄÄÄÄÄÄÄÄÅÕΩ’…çï}’…∞ËÅÕΩ’…çïU…∞∞(ÄÄÄÄÄÄÄÄÄÅÕΩ…—}Ω…ëï»ËÅ9’µâï»°ÖÕÕï–πÕΩ…—}Ω…ëï»ÅÒÄ¿§∞(ÄÄÄÄÄÄÄÅÙ§Ï(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅÖÕÕï—ÃπÕΩ…–†°Ñ∞Åà§ÄÙ¯ÅÑπÕΩ…—}Ω…ëï»Ä¥ÅàπÕΩ…—}Ω…ëï»§Ï(ÄÄÄÄÄÅ•òÄ°ÖÕÕï—Ãπ±ïπù—†§Åç°•±ë…Ω’¡Ãπ¡’Õ†°ÏÅçÖ—Ö±Ωù}≠ï‰ËÅπΩëîπçÖ—Ö±Ωù}≠ï‰∞ÅÖÕÕï—ÃÅÙ§Ï(ÄÄÄÅÙ((ÄÄÄÅçΩπÕ–ÅÕçΩ¡ïÕÕï—ÃÄÙÅ…Ω’πëIΩâ•πÕÕï—Ã°ç°•±ë…Ω’¡Ã§Ï(ÄÄÄÅ•òÄ†ÖÕçΩ¡ïÕÕï—Ãπ±ïπù—†§ÅçΩπ—•π’îÏ(ÄÄÄÅ…ïÕΩ±ŸïëMçΩ¡ïÃπ¡’Õ†°ÕçΩ¡ï-ï‰§Ï((ÄÄÄÅçΩπÕ–Åù…Ω’¡-ï‰ÄÙÅ¡…Ωë’ç—…Ω’¿°ÕçΩ¡ï-ï‰§Ï(ÄÄÄÅ•òÄ†Öâ’πë±ï5Ö¿π°ÖÃ°ù…Ω’¡-ï‰§§ÅÏ(ÄÄÄÄÄÅâ’πë±ï5Ö¿πÕï–°ù…Ω’¡-ï‰∞ÅÏ(ÄÄÄÄÄÄÄÅâ’πë±ï}≠ï‰ËÄâµïë•ÑËàÄ¨Åù…Ω’¡-ï‰∞(ÄÄÄÄÄÄÄÅù…Ω’¡}≠ï‰ËÅù…Ω’¡-ï‰∞(ÄÄÄÄÄÄÄÅ±Öâï∞ËÅ¡…Ωë’ç—…Ω’¡1Öâï∞°ù…Ω’¡-ï‰§∞(ÄÄÄÄÄÄÄÅçÖ—Ö±Ωù}≠ïÂÃËÅmt∞(ÄÄÄÄÄÄÄÅÕçΩ¡ï}ù…Ω’¡ÃËÅmt∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÅÙ(ÄÄÄÅçΩπÕ–Åâ’πë±îÄÙÅâ’πë±ï5Ö¿πùï–°ù…Ω’¡-ï‰§Ï(ÄÄÄÅâ’πë±îπçÖ—Ö±Ωù}≠ïÂÃπ¡’Õ†°ÕçΩ¡ï-ï‰§Ï(ÄÄÄÅâ’πë±îπÕçΩ¡ï}ù…Ω’¡Ãπ¡’Õ†°ÏÅçÖ—Ö±Ωù}≠ï‰ËÅÕçΩ¡ï-ï‰∞ÅÖÕÕï—ÃËÅÕçΩ¡ïÕÕï—ÃÅÙ§Ï(ÄÅÙ((ÄÅçΩπÕ–Åµïë•Ö	’πë±ïÃÄÙÅl∏∏πâ’πë±ï5Ö¿πŸÖ±’ïÃ†•tπµÖ¿†°â’πë±î§ÄÙ¯ÅÏ(ÄÄÄÅçΩπÕ–ÅÖÕÕï—ÃÄÙÅ…Ω’πëIΩâ•πÕÕï—Ã°â’πë±îπÕçΩ¡ï}ù…Ω’¡Ã§Ï(ÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÅâ’πë±ï}≠ï‰ËÅâ’πë±îπâ’πë±ï}≠ï‰∞(ÄÄÄÄÄÅù…Ω’¡}≠ï‰ËÅâ’πë±îπù…Ω’¡}≠ï‰∞(ÄÄÄÄÄÅ±Öâï∞ËÅâ’πë±îπ±Öâï∞∞(ÄÄÄÄÄÅçÖ—Ö±Ωù}≠ïÂÃËÅl∏∏ππï‹ÅMï–°â’πë±îπçÖ—Ö±Ωù}≠ïÂÃ•t∞(ÄÄÄÄÄÅÖÕÕï—Ã∞(ÄÄÄÄÄÅÖÕÕï—}çΩ’π–ËÅÖÕÕï—Ãπ±ïπù—†∞(ÄÄÄÄÄÅµÖ·}ÖÕÕï—ÃËÅ5a}5%}MMQL∞(ÄÄÄÅÙÏ(ÄÅÙ§πô•±—ï»†°â’πë±î§ÄÙ¯Åâ’πë±îπÖÕÕï—Ãπ±ïπù—†§Ï((ÄÅ…ï—’…∏ÅÏ(ÄÄÄÅÖÕÕï—ÃËÅµïë•Ö	’πë±ïÃπô±Ö—5Ö¿†°â’πë±î§ÄÙ¯Åâ’πë±îπÖÕÕï—Ã§∞(ÄÄÄÅçÖ—Ö±Ωù}≠ïÂÃËÅ…ïÕΩ±ŸïëMçΩ¡ïÃ∞(ÄÄÄÅ…ï≈’ïÕ—ïë}çÖ—Ö±Ωù}≠ïÂÃËÅÕçΩ¡ïÃ∞(ÄÄÄÅµ•ÕÕ•πù}çÖ—Ö±Ωù}≠ïÂÃËÅÕçΩ¡ïÃπô•±—ï»†°ÕçΩ¡ï-ï‰§ÄÙ¯ÄÖ…ïÕΩ±ŸïëMçΩ¡ïÃπ•πç±’ëïÃ°ÕçΩ¡ï-ï‰§§∞(ÄÄÄÅµïë•Ö}â’πë±ïÃËÅµïë•Ö	’πë±ïÃ∞(ÄÅÙÏ)Ù()ô’πç—•Ω∏Å•Õô—ï…=…≈’Ö∞°Ñ∞Åà§ÅÏ(ÄÅçΩπÕ–Å±ïô–ÄÙÅÖ—îπ¡Ö…Õî°ÑÅÒÄàà§Ï(ÄÅçΩπÕ–Å…•ù°–ÄÙÅÖ—îπ¡Ö…Õî°àÅÒÄàà§Ï(ÄÅ…ï—’…∏Å9’µâï»π•Õ•π•—î°±ïô–§ÄòòÅ9’µâï»π•Õ•π•—î°…•ù°–§ÄòòÅ±ïô–Ä¯ÙÅ…•ù°–Ï)Ù()ô’πç—•Ω∏ÅÕ—…•¡Iï¡ïÖ—ïëΩπ—Öç—Iï≈’ïÕ–°ŸÖ±’î§ÅÏ(ÄÅ…ï—’…∏ÅM—…•πú°ŸÖ±’îÅÒÄàà§(ÄÄÄÄπ…ï¡±Öçî†Ωmx∏Ñ˝qπt®†¸ÈÕë—ÒœÜÓDÉEßÜÓ∏Å—°øÜÍÖ•ÒÈÖ±º•mx∏Ñ˝qπt©l∏Ñ˝t¸Ωù§∞ÄàÄà§(ÄÄÄÄπ…ï¡±Öçî†ΩqÃ¨Ωú∞ÄàÄà§(ÄÄÄÄπ—…•¥†§Ï)Ù()ô’πç—•Ω∏Å±Ö—ïÕ—’Õ—Ωµï…–°ëïç•Õ•Ω∏§ÅÏ(ÄÅçΩπÕ–ÅµïÕÕÖùïÃÄÙÅëïç•Õ•Ω∏¸π•π¡’—}ÕπÖ¡Õ°Ω–¸πçΩπŸï…ÕÖ—•Ω∏¸πµïÕÕÖùïÃÅÒÅmtÏ(ÄÅ…ï—’…∏Å5Ö—†πµÖ‡†¿∞Ä∏∏πµïÕÕÖùïÃπô•±—ï»†°µïÕÕÖùî§ÄÙ¯ÅµïÕÕÖùîπ…Ω±îÄÙÙÙÄâç’Õ—Ωµï»à§πµÖ¿†°µïÕÕÖùî§ÄÙ¯ÅÖ—îπ¡Ö…Õî°µïÕÕÖùîπΩçç’……ïë}Ö–ÅÒÄàà§§πô•±—ï»°9’µâï»π•Õ•π•—î§§Ï)Ù()ô’πç—•Ω∏Å¡ÖùïIï¡±Âô—ï…1Ö—ïÕ—’Õ—Ωµï…%π=…ëï»°µïÕÕÖùïÃÄÙÅmt§ÅÏ(ÄÅ±ï–Å±Ö—ïÕ—’Õ—Ωµï…%πëï‡ÄÙÄ¥ƒÏ(ÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÅµïÕÕÖùïÃπ±ïπù—†Ä¥ÄƒÏÅ•πëï‡Ä¯ÙÄ¿ÏÅ•πëï‡Ä¥ÙÄƒ§ÅÏ(ÄÄÄÅ•òÄ°µïÕÕÖùïÕm•πëï·tÄòòÅµïÕÕÖùïÕm•πëï·tπ…Ω±îÄÙÙÙÄâç’Õ—Ωµï»à§ÅÏ(ÄÄÄÄÄÅ±Ö—ïÕ—’Õ—Ωµï…%πëï‡ÄÙÅ•πëï‡Ï(ÄÄÄÄÄÅâ…ïÖ¨Ï(ÄÄÄÅÙ(ÄÅÙ(ÄÅ•òÄ°±Ö—ïÕ—’Õ—Ωµï…%πëï‡ÄÄ¿§Å…ï—’…∏ÅôÖ±ÕîÏ(ÄÅ…ï—’…∏ÅµïÕÕÖùïÃπÕ±•çî°±Ö—ïÕ—’Õ—Ωµï…%πëï‡Ä¨Äƒ§πÕΩµî°ô’πç—•Ω∏Ä°µïÕÕÖùî§ÅÏ(ÄÄÄÅ…ï—’…∏ÅµïÕÕÖùîÄòòÅlâ°’µÖ∏à∞ÄââΩ–à∞ÄâÖ’—ΩµÖ—•Ω∏à∞Äâ¡Öùîâtπ•πç±’ëïÃ°µïÕÕÖùîπ…Ω±î§Ï(ÄÅÙ§Ï)Ù((ººÅ%U-}Xƒ¡}=UQ	=U9}IA1e}=II}Xƒ(()ô’πç—•Ω∏Åµï…ùïQ•µî°ŸÖ±’î§ÅÏ(ÄÅçΩπÕ–Å¡Ö…ÕïêÄÙÅÖ—îπ¡Ö…Õî°M—…•πú°ŸÖ±’îÅÒÄàà§§Ï(ÄÅ…ï—’…∏Å9’µâï»π•Õ•π•—î°¡Ö…Õïê§Ä¸Å¡Ö…ÕïêÄËÄ¿Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏ÅïπÕ’…ï1Ö—ïÕ—’Õ—Ωµï…±’Õ—ï…)Ωà°ëïç•Õ•Ω∏∞ÅÕ—Ö—î∞ÅçΩπô•ú§ÅÏ(ÄÅçΩπÕ–ÅÕΩ’…çïŸïπ—%êÄÙÅM—…•πú°Õ—Ö—î¸π±ÖÕ—}ÕΩ’…çï}ïŸïπ—}•êÅÒÄàà§π—…•¥†§Ï(ÄÅ•òÄ†ÖÕΩ’…çïŸïπ—%ê§Å…ï—’…∏ÅÏÅïπÕ’…ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ1QMQ}M=UI}Y9Q}U9-9=]8àÅÙÏ((ÄÅçΩπÕ–Åëïç•Õ•ΩπÃÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}ëïç•Õ•ΩπÃ˝Õï±ïç–ı•ê±Õ—Ö—’Ã±ÕΩ’…çï}ïŸïπ—}•êôÕΩ’…çï}ïŸïπ—}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ÕΩ’…çïŸïπ—%ê§(ÄÄÄÄÄÄ¨Äàô¡Öùï}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏π¡Öùï}•ê§(ÄÄÄÄÄÄ¨ÄàôÕïπëï…}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏πÕïπëï…}•ê§(ÄÄÄÄÄÄ¨ÄàôΩ…ëï»ıç…ïÖ—ïë}Ö–πëïÕåô±•µ•–Ù‘à(ÄÄ§πçÖ—ç†††§ÄÙ¯Åmt§Ï(ÄÅçΩπÕ–Åëïç•Õ•Ωπ·•Õ—ÃÄÙÄ°ëïç•Õ•ΩπÃÅÒÅmt§πÕΩµî†°…Ω‹§ÄÙ¯Ål(ÄÄÄÄâÕ°ÖëΩ›}çΩπ—ï·—}…ïÖë‰à∞ÄâÕ°ÖëΩ›}Ö•}¡…ΩçïÕÕ•πúà∞ÄâÕ°ÖëΩ›}Ö•}çΩµ¡±ï—ïêà∞(ÄÄÄÄâ±•Ÿï}ëï±•Ÿï…Â}¡…ΩçïÕÕ•πúà∞Äâ±•Ÿï}ëï±•Ÿï…Â}ôÖ•±ïêà∞Äâ±•Ÿï}ëï±•Ÿï…ïêà∞Äâ±•Ÿï}ëï±•Ÿï…ïë}¡Ö…—•Ö∞à∞(ÄÅtπ•πç±’ëïÃ°M—…•πú°…Ω‹¸πÕ—Ö—’ÃÅÒÄàà§§§Ï(ÄÅ•òÄ°ëïç•Õ•Ωπ·•Õ—Ã§Å…ï—’…∏ÅÏÅïπÕ’…ïêËÅ—…’î∞ÅÕΩ’…çï}ïŸïπ—}•êËÅÕΩ’…çïŸïπ—%ê∞ÅŸ•ÑËÄâëïç•Õ•Ω∏àÅÙÏ((ÄÅçΩπÕ–Å©ΩâÃÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}©ΩâÃ˝Õï±ïç–ı•ê±Õ—Ö—’Ã±ÕΩ’…çï}ïŸïπ—}•ê±…’π}Öô—ï»ôÕΩ’…çï}ïŸïπ—}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ÕΩ’…çïŸïπ—%ê§(ÄÄÄÄÄÄ¨Äàô©Ωâ}—Â¡îıïƒπëïç•Õ•Ωπ}Õ°ÖëΩ‹ô±•µ•–Ùƒà(ÄÄ§πçÖ—ç†††§ÄÙ¯Åmt§Ï(ÄÅçΩπÕ–ÅÖç—•Ÿï)ΩàÄÙÄ°©ΩâÃÅÒÅmt§πô•πê†°…Ω‹§ÄÙ¯Ålâ≈’ï’ïêà∞Äâ¡…ΩçïÕÕ•πúâtπ•πç±’ëïÃ°M—…•πú°…Ω‹¸πÕ—Ö—’ÃÅÒÄàà§§§Ï(ÄÅ•òÄ°Öç—•Ÿï)Ωà§Å…ï—’…∏ÅÏÅïπÕ’…ïêËÅ—…’î∞ÅÕΩ’…çï}ïŸïπ—}•êËÅÕΩ’…çïŸïπ—%ê∞ÅŸ•ÑËÄâ©Ωàà∞Å©Ωâ}•êËÅÖç—•Ÿï)Ωàπ•êÅÙÏ((ÄÅçΩπÕ–ÅïŸïπ—ÃÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}ïŸïπ—Ã˝Õï±ïç–ı•ê±ÕΩ’…çï}ïŸïπ—}•ê±…ïçï•Ÿïë}Ö–ô¡Öùï}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏π¡Öùï}•ê§(ÄÄÄÄÄÄ¨Äàôç’Õ—Ωµï…}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏πÕïπëï…}•ê§(ÄÄÄÄÄÄ¨ÄàôÕΩ’…çï}ïŸïπ—}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ÕΩ’…çïŸïπ—%ê§(ÄÄÄÄÄÄ¨Äàô±•µ•–Ùƒà(ÄÄ§πçÖ—ç†††§ÄÙ¯Åmt§Ï(ÄÅçΩπÕ–ÅïŸïπ–ÄÙÅïŸïπ—Ã¸πl¡tÏ(ÄÅ•òÄ†ÖïŸïπ–¸π•ê§Å…ï—’…∏ÅÏÅïπÕ’…ïêËÅôÖ±Õî∞ÅÕΩ’…çï}ïŸïπ—}•êËÅÕΩ’…çïŸïπ—%ê∞Å…ïÖÕΩ∏ËÄâ1QMQ}Y9Q}9=Q}=U9àÅÙÏ((ÄÅçΩπÕ–ÅëïâΩ’πçï5ÃÄÙÅ5Ö—†πµÖ‡†¿∞Å9’µâï»°çΩπô•ú¸πëïâΩ’πçï}ÕïçΩπëÃÅÒÄ»¿§Ä®Äƒ¿¿¿§Ï(ÄÅçΩπÕ–Åë’ï–ÄÙÅπï‹ÅÖ—î°5Ö—†πµÖ‡°Ö—îππΩ‹†§∞Åµï…ùïQ•µî°ïŸïπ–π…ïçï•Ÿïë}Ö–§Ä¨ÅëïâΩ’πçï5Ã§§π—Ω%M=M—…•πú†§Ï(ÄÅçΩπÕ–Å…Ω›ÃÄÙÅÖ›Ö•–ÅçΩ…î†âÿÂ}©ΩâÃ˝Ωπ}çΩπô±•ç–ıÕΩ’…çï}ïŸïπ—}•ê±©Ωâ}—Â¡îà∞ÅÏ(ÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÅ¡…ïôï»ËÄâ…ïÕΩ±’—•Ω∏ıµï…ùîµë’¡±•çÖ—ïÃ±…ï—’…∏ı…ï¡…ïÕïπ—Ö—•Ω∏à∞(ÄÄÄÅâΩë‰ËÅÏ(ÄÄÄÄÄÅÕΩ’…çï}ïŸïπ—}•êËÅÕΩ’…çïŸïπ—%ê∞(ÄÄÄÄÄÅïŸïπ—}•êËÅïŸïπ–π•ê∞(ÄÄÄÄÄÅ©Ωâ}—Â¡îËÄâëïç•Õ•Ωπ}Õ°ÖëΩ‹à∞(ÄÄÄÄÄÅëïë’¡ï}≠ï‰ËÅM—…•πú°ëïç•Õ•Ω∏π¡Öùï}•ê§Ä¨ÄàËàÄ¨ÅM—…•πú°ëïç•Õ•Ω∏πÕïπëï…}•ê§Ä¨ÄàËàÄ¨ÅÕΩ’…çïŸïπ—%ê∞(ÄÄÄÄÄÅ¡Öùï}•êËÅM—…•πú°ëïç•Õ•Ω∏π¡Öùï}•ê§∞(ÄÄÄÄÄÅÕïπëï…}•êËÅM—…•πú°ëïç•Õ•Ω∏πÕïπëï…}•ê§∞(ÄÄÄÄÄÅÕ—Ö—’ÃËÄâ≈’ï’ïêà∞(ÄÄÄÄÄÅ…’π}Öô—ï»ËÅë’ï–∞(ÄÄÄÄÄÅ¡ÖÂ±ΩÖêËÅÏ(ÄÄÄÄÄÄÄÅÕΩ’…çîËÄâÿƒ¡}Ω’—âΩ’πë}µï…ùï}ù’Ö…Öπ—ïîà∞(ÄÄÄÄÄÄÄÅµï…ùï}Ö±±}¡…•Ω…}’πÖπÕ›ï…ïë}ç’Õ—Ωµï…}µïÕÕÖùïÃËÅ—…’î∞(ÄÄÄÄÄÄÄÅÕ—Ö±ï}ëïç•Õ•Ωπ}•êËÅëïç•Õ•Ω∏π•ê∞(ÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÅÖ——ïµ¡—ÃËÄ¿∞(ÄÄÄÄÄÅ±Ωç≠ïë}â‰ËÅπ’±∞∞(ÄÄÄÄÄÅ±Ωç≠ïë}Ö–ËÅπ’±∞∞(ÄÄÄÄÄÅçΩµ¡±ï—ïë}Ö–ËÅπ’±∞∞(ÄÄÄÄÄÅ±ÖÕ—}ï……Ω»ËÅπ’±∞∞(ÄÄÄÄÄÅ’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§∞(ÄÄÄÅÙ∞(ÄÅÙ§πçÖ—ç†††§ÄÙ¯Åmt§Ï(ÄÅ…ï—’…∏ÅÏ(ÄÄÄÅïπÕ’…ïêËÅ	ΩΩ±ïÖ∏°…Ω›Ã¸πl¡t¸π•ê§∞(ÄÄÄÅÕΩ’…çï}ïŸïπ—}•êËÅÕΩ’…çïŸïπ—%ê∞(ÄÄÄÅŸ•ÑËÄâ…ï≈’ï’ïêà∞(ÄÄÄÅ©Ωâ}•êËÅ…Ω›Ã¸πl¡t¸π•êÅÒÅπ’±∞∞(ÄÄÄÅ…’π}Öô—ï»ËÅë’ï–∞(ÄÅÙÏ)Ù((ººÅ%U-}Xƒ¡}UMQ=5I}1UMQI}5I}UQ!=I%Qe}Xƒ(()ô’πç—•Ω∏ÅÕΩŸï…ï•ùπ=’—âΩ’πë’Õ—Ωµï…±’Õ—ï»°ëïç•Õ•Ω∏§ÅÏ(ÄÅçΩπÕ–ÅµïÕÕÖùïÃÄÙÅëïç•Õ•Ω∏¸π•π¡’—}ÕπÖ¡Õ°Ω–¸πçΩπŸï…ÕÖ—•Ω∏¸πµïÕÕÖùïÃÅÒÅmtÏ(ÄÅ±ï–ÅâΩ’πëÖ…‰ÄÙÄ¥ƒÏ(ÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÅµïÕÕÖùïÃπ±ïπù—†Ä¥ÄƒÏÅ•πëï‡Ä¯ÙÄ¿ÏÅ•πëï‡Ä¥ÙÄƒ§ÅÏ(ÄÄÄÅ•òÄ°µïÕÕÖùïÕm•πëï·tÄòòÅµïÕÕÖùïÕm•πëï·tπ…Ω±îÄÑÙÙÄâç’Õ—Ωµï»à§ÅÏ(ÄÄÄÄÄÅâΩ’πëÖ…‰ÄÙÅ•πëï‡Ï(ÄÄÄÄÄÅâ…ïÖ¨Ï(ÄÄÄÅÙ(ÄÅÙ(ÄÅ…ï—’…∏ÅπΩ…µÖ±•ÈïY•ï—πÖµïÕî°µïÕÕÖùïÃπÕ±•çî°âΩ’πëÖ…‰Ä¨Äƒ§(ÄÄÄÄπô•±—ï»†°µïÕÕÖùî§ÄÙ¯ÅµïÕÕÖùî¸π…Ω±îÄÙÙÙÄâç’Õ—Ωµï»à§(ÄÄÄÄπµÖ¿†°µïÕÕÖùî§ÄÙ¯ÅmµïÕÕÖùîπ—ï·–∞ÅµïÕÕÖùî¸π¡ΩÕ—âÖç¨¸πïôôïç—•Ÿï}¡ÖÂ±ΩÖê∞ÅµïÕÕÖùî¸π¡ΩÕ—âÖç¨¸π¡ÖÂ±ΩÖëtπô•±—ï»°	ΩΩ±ïÖ∏§π©Ω•∏†àÄà§§(ÄÄÄÄπ©Ω•∏†àÄà§§Ï)Ù()ô’πç—•Ω∏ÅÕΩŸï…ï•ùπ=’—âΩ’πëIï¡ïÖ—Iï≈’ïÕ—ïê°ëïç•Õ•Ω∏§ÅÏ(ÄÅ…ï—’…∏ÄΩqà°ù’§Å±Ö•Òπ°ÖåÅ±Ö•ÒπΩ§Å±Ö•Ò±Ö¿Å±Ö•Òù’§Å—°ïµÒù’§Å—•ï¡Òù’§Åπ’ÖÒ·ï¥Å±Ö•Ò·ï¥Å—°ïµÒ·ï¥Å—•ï¡Ò·ï¥Åπ’ÖÒµÖ‘Å≠°ÖçÒÖπ†Å≠°ÖçÒ°•π†Å≠°ÖçÒçÖ—Ö±ΩúÅ≠°ÖçÒ—°ï¥ÅµÖ’Ò—°ï¥ÅÖπ°Ò—°ï¥Å°•π°ÒçÖ∏Å—°ï¥ÅµÖ’Òµ’Ω∏Å—°ï¥ÅµÖ’ÒµÖ‘Åπ’ÖÒÖπ†Åπ’ÖÒ°•π†Åπ’ÖÒçΩ∏ÅµÖ’ÒçΩ∏ÅÖπ°ÒçΩ∏Å°•π°ÒçΩ∏Å±ΩÖ•ÒçΩ∏ÅçÖ§•qàºπ—ïÕ–°ÕΩŸï…ï•ùπ=’—âΩ’πë’Õ—Ωµï…±’Õ—ï»°ëïç•Õ•Ω∏§§Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏ÅÕΩŸï…ï•ùπIïçïπ—’¡±•çÖ—î°ëïç•Õ•Ω∏∞Å—ï·–§ÅÏ(ÄÅ•òÄ°ÕΩŸï…ï•ùπ=’—âΩ’πëIï¡ïÖ—Iï≈’ïÕ—ïê°ëïç•Õ•Ω∏§§Å…ï—’…∏Åπ’±∞Ï(ÄÅçΩπÕ–ÅπΩ…µÖ±•ÈïêÄÙÅπΩ…µÖ±•ÈïY•ï—πÖµïÕî°—ï·–ÅÒÄàà§Ï(ÄÅ•òÄ†ÖπΩ…µÖ±•Èïê§Å…ï—’…∏Åπ’±∞Ï(ÄÅçΩπÕ–ÅÕ•πçîÄÙÅπï‹ÅÖ—î°Ö—îππΩ‹†§Ä¥Äƒ‘Ä®Äÿ¡|¿¿¿§π—Ω%M=M—…•πú†§Ï(ÄÅçΩπÕ–Å…Ω›ÃÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}ëïç•Õ•ΩπÃ˝Õï±ïç–ı•ê±Õ—Ö—’Ã±Ω’—¡’–±ç…ïÖ—ïë}Ö–ô¡Öùï}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏π¡Öùï}•ê§(ÄÄÄÄÄÄ¨ÄàôÕïπëï…}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏πÕïπëï…}•ê§(ÄÄÄÄÄÄ¨Äàô•êıπïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏π•ê§(ÄÄÄÄÄÄ¨ÄàôÕ—Ö—’Ãı•∏∏°±•Ÿï}ëï±•Ÿï…ïê±±•Ÿï}ëï±•Ÿï…ïë}¡Ö…—•Ö∞§à(ÄÄÄÄÄÄ¨Äàôç…ïÖ—ïë}Ö–ıù—î∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°Õ•πçî§(ÄÄÄÄÄÄ¨ÄàôΩ…ëï»ıç…ïÖ—ïë}Ö–πëïÕåô±•µ•–Ù»¿à(ÄÄ§πçÖ—ç†††§ÄÙ¯Åmt§Ï(ÄÅ…ï—’…∏Ä°…Ω›ÃÅÒÅmt§πô•πê†°…Ω‹§ÄÙ¯ÅπΩ…µÖ±•ÈïY•ï—πÖµïÕî°…Ω‹¸πΩ’—¡’–¸πô•πÖ±}…ï¡±‰ÅÒÄàà§ÄÙÙÙÅπΩ…µÖ±•Èïê§ÅÒÅπ’±∞Ï)Ù((ººÅ%U-}Xƒ¡}=UQ	=U9}M=YI%9}%9QI%Qe}Xƒ(()çΩπÕ–Å±•ŸïAÖùïIï¡±ÂMπÖ¡Õ°Ω—Öç°îÄÙÅç…ïÖ—ïAÖπçÖ≠ïΩπŸï…ÕÖ—•ΩπMπÖ¡Õ°Ω—Öç°î°Ï(ÄÅ—•µïΩ’—5ÃËÄÃ‘¿¿∞(ÄÅ——±5ÃËÅ5Ö—†πµÖ‡†ƒ¿¿¿∞Å9’µâï»°¡…ΩçïÕÃπïπÿπ%U-}A9-}A}M9AM!=Q}QQ1}5LÅÒÄ‘¿¿¿§§∞(ÄÅµÖ·AÖùïÃËÄ–∞)Ù§Ï()ô’πç—•Ω∏Å±•ŸïAÖùïIï¡±ÂQ•µî°ŸÖ±’î§ÅÏ(ÄÅçΩπÕ–Å¡Ö…ÕïêÄÙÅÖ—îπ¡Ö…Õî°M—…•πú°ŸÖ±’îÅÒÄàà§§Ï(ÄÅ…ï—’…∏Å9’µâï»π•Õ•π•—î°¡Ö…Õïê§Ä¸Å¡Ö…ÕïêÄËÄ¿Ï)Ù()ô’πç—•Ω∏Å±•ŸïAÖùïIï¡±ÂQï·–°ŸÖ±’î§ÅÏ(ÄÅ…ï—’…∏ÅπΩ…µÖ±•ÈïY•ï—πÖµïÕî°M—…•πú°ŸÖ±’îÅÒÄàà§§π…ï¡±Öçî†ΩqÃ¨Ωú∞ÄàÄà§π—…•¥†§Ï)Ù()ô’πç—•Ω∏Å±•ŸïAÖùïIï¡±ÂΩπŸï…ÕÖ—•Ωπ5Ö—ç°ïÃ°…Ω‹∞ÅÕïπëï…%ê§ÅÏ(ÄÅçΩπÕ–Å—Ö…ùï–ÄÙÅM—…•πú°Õïπëï…%êÅÒÄàà§π—…•¥†§Ï(ÄÅ•òÄ†Ö—Ö…ùï–ÅÒÄÖ…Ω‹ÅÒÅ—Â¡ïΩòÅ…Ω‹ÄÑÙÙÄâΩâ©ïç–à§Å…ï—’…∏ÅôÖ±ÕîÏ(ÄÅçΩπÕ–ÅŸÖ±’ïÃÄÙÅl(ÄÄÄÅ…Ω‹πÕïπëï…}•ê∞(ÄÄÄÅ…Ω‹πç’Õ—Ωµï…}•ê∞(ÄÄÄÅ…Ω‹π¡Õ•ê∞(ÄÄÄÅ…Ω‹πô…Ωµ}•ê∞(ÄÄÄÅ…Ω‹πô…Ω¥¸π•ê∞(ÄÄÄÅ…Ω‹π’Õï»¸π•ê∞(ÄÄÄÅ…Ω‹πç’Õ—Ωµï»¸π•ê∞(ÄÄÄÅ…Ω‹π¡Öùï}ç’Õ—Ωµï»¸π¡Õ•ê∞(ÄÄÄÅ…Ω‹πç’Õ—Ωµï…Ã¸πl¡t¸πôâ}•ê∞(ÄÅtπµÖ¿†°ŸÖ±’î§ÄÙ¯ÅM—…•πú°ŸÖ±’îÅÒÄàà§π—…•¥†§§Ï(ÄÅçΩπÕ–Å•êÄÙÅM—…•πú°…Ω‹π•êÅÒÅ…Ω‹πçΩπŸï…ÕÖ—•Ωπ}•êÅÒÅ…Ω‹π—°…ïÖë}•êÅÒÄàà§π—…•¥†§Ï(ÄÅ…ï—’…∏ÅŸÖ±’ïÃπ•πç±’ëïÃ°—Ö…ùï–§ÅÒÅ•êÄÙÙÙÅ—Ö…ùï–ÅÒÅ•êπïπëÕ]•—††â|àÄ¨Å—Ö…ùï–§Ï)Ù()ô’πç—•Ω∏Å±•ŸïAÖùïIï¡±ÂMïπëï»°…Ω‹§ÅÏ(ÄÅ…ï—’…∏Å…Ω‹¸π±ÖÕ—}Õïπ—}â‰ÅÒÅ…Ω‹¸π±ÖÕ—}µïÕÕÖùî¸πô…Ω¥ÅÒÅ…Ω‹¸π±ÖÕ—}µïÕÕÖùî¸πÕïπëï»ÅÒÅπ’±∞Ï)Ù()ô’πç—•Ω∏Å±•ŸïAÖùïIï¡±ÂMΩ’…çî°…Ω‹§ÅÏ(ÄÅçΩπÕ–ÅÕïπëï»ÄÙÅ±•ŸïAÖùïIï¡±ÂMïπëï»°…Ω‹§ÅÒÅÌÙÏ(ÄÅçΩπÕ–ÅÖ¡¡%êÄÙÅM—…•πú°Õïπëï»πÖ¡¡}•êÅÒÅÕïπëï»πÖ¡¡±•çÖ—•Ωπ}•êÅÒÅÕïπëï»πâΩ—}•êÅÒÄàà§π—…•¥†§Ï(ÄÅçΩπÕ–ÅçΩπô•ù’…ïë•çÖ≠îÄÙÅπï‹ÅMï–†(ÄÄÄÅM—…•πú°¡…ΩçïÕÃπïπÿπA9-}%-}AA}%LÅÒÄà‘‘ÿÃ‹ÿ‰‰‡ƒ‘‰ƒ¿–à§(ÄÄÄÄÄÄπÕ¡±•–†à∞à§(ÄÄÄÄÄÄπµÖ¿†°ŸÖ±’î§ÄÙ¯ÅŸÖ±’îπ—…•¥†§§(ÄÄÄÄÄÄπô•±—ï»°	ΩΩ±ïÖ∏§∞(ÄÄ§Ï(ÄÅçΩπÕ–Å…Ö‹ÄÙÅ±•ŸïAÖùïIï¡±ÂQï·–°)M=8πÕ—…•πù•ô‰°Õïπëï»§§Ï(ÄÅ•òÄ†°Ö¡¡%êÄòòÅçΩπô•ù’…ïë•çÖ≠îπ°ÖÃ°Ö¡¡%ê§§ÅÒÄΩqà°Ö•çÖ≠ïÒÖ§ÅçÖ≠ïÒâΩ—çÖ≠ïÒâΩ–ÅçÖ≠î•qàºπ—ïÕ–°…Ö‹§§Å…ï—’…∏ÄâÖ•çÖ≠îàÏ(ÄÅ•òÄ†Ωqà°Ö’—ΩµÖ—•ΩπÒÖ’—ΩµÖ—ïëÒÖ’—ºÅ…ï¡±ÂÒÖ’—Ω}…ï¡±ÂÒô±Ω‹•qàºπ—ïÕ–°…Ö‹§§Å…ï—’…∏Äâ¡Öùï}Ö’—ΩµÖ—•Ω∏àÏ(ÄÅ•òÄ°Õïπëï»πÖëµ•π}πÖµîÅÒÅÕïπëï»π’•êÅÒÅÕïπëï»πÖëµ•π}•ê§Å…ï—’…∏Äâ°’µÖπ}Öëµ•∏àÏ(ÄÅ…ï—’…∏Äâ¡ÖùîàÏ)Ù()ô’πç—•Ω∏Å±•ŸïAÖùïIï¡±Â1Ö—ïÕ—’Õ—Ωµï…Qï·–°ëïç•Õ•Ω∏§ÅÏ(ÄÅçΩπÕ–ÅµïÕÕÖùïÃÄÙÅëïç•Õ•Ω∏¸π•π¡’—}ÕπÖ¡Õ°Ω–¸πçΩπŸï…ÕÖ—•Ω∏¸πµïÕÕÖùïÃÅÒÅmtÏ(ÄÅçΩπÕ–Å±Ö—ïÕ–ÄÙÅl∏∏πµïÕÕÖùïÕtπ…ïŸï…Õî†§πô•πê†°µïÕÕÖùî§ÄÙ¯ÅµïÕÕÖùî¸π…Ω±îÄÙÙÙÄâç’Õ—Ωµï»à§Ï(ÄÅ…ï—’…∏Å±•ŸïAÖùïIï¡±ÂQï·–°±Ö—ïÕ–¸π—ï·–ÅÒÄàà§Ï)Ù()ô’πç—•Ω∏ÅÕ’¡¡Ω…—1Ö—ïÕ—’Õ—Ωµï…!ÖÕ——Öç°µïπ–°ëïç•Õ•Ω∏§ÅÏ(ÄÅçΩπÕ–ÅµïÕÕÖùïÃÄÙÅëïç•Õ•Ω∏¸π•π¡’—}ÕπÖ¡Õ°Ω–¸πçΩπŸï…ÕÖ—•Ω∏¸πµïÕÕÖùïÃÅÒÅmtÏ(ÄÅçΩπÕ–Å±Ö—ïÕ–ÄÙÅl∏∏πµïÕÕÖùïÕtπ…ïŸï…Õî†§πô•πê†°µïÕÕÖùî§ÄÙ¯ÅµïÕÕÖùî¸π…Ω±îÄÙÙÙÄâç’Õ—Ωµï»à§Ï(ÄÅ…ï—’…∏Å……Ö‰π•Õ……Ö‰°±Ö—ïÕ–¸πÖ——Öç°µïπ—Ã§ÄòòÅ±Ö—ïÕ–πÖ——Öç°µïπ—Ãπ±ïπù—†Ä¯Ä¿Ï)Ù()ô’πç—•Ω∏ÅÕ’¡¡Ω…—Iï¡±ÂIï≈’ïÕ—ÕΩπ—Öç–°…ï¡±‰§ÅÏ(ÄÅçΩπÕ–Å—ï·–ÄÙÅ±•ŸïAÖùïIï¡±ÂQï·–°…ï¡±‰¸πµïÕÕÖùï}—ï·–ÅÒÄàà§Ï(ÄÅ…ï—’…∏ÄΩqà°Õë—ÒÕºÅë•ï∏Å—°ΩÖ•Òë•ï∏Å—°ΩÖ•ÒÈÖ±ΩÒëîÅ±Ö§ÅÕΩÒ·•∏ÅÕΩÒ±•ï∏Å°î•qàºπ—ïÕ–°—ï·–§Ï)Ù(()ô’πç—•Ω∏ÅÕ’¡¡Ω…—MÖ±’—Ö—•Ωπ…Ωµ$°ëïç•Õ•Ω∏§ÅÏ(ÄÅ±ï–Å—ï·–ÄÙÅπΩ…µÖ±•ÈïY•ï—πÖµïÕî°M—…•πú°ëïç•Õ•Ω∏¸πΩ’—¡’–¸πô•πÖ±}…ï¡±‰ÅÒÄàà§§Ï(ÄÅ—ï·–ÄÙÅ—ï·–π…ï¡±Öçî†ΩqâÖπ°qÃ©pΩqÃ©ç°•qàΩú∞ÄàÄà§π…ï¡±Öçî†ΩqâÖπ°qÃ≠ç°•qàΩú∞ÄàÄà§Ï(ÄÅçΩπÕ–Å°ÖÕπ†ÄÙÄº°yÒqÕÒl∞∏Ñ¸ÏÈt•Öπ††¸ıqÕÒl∞∏Ñ¸ÏÈuê§ºπ—ïÕ–°—ï·–§Ï(ÄÅçΩπÕ–Å°ÖÕ°§ÄÙÄº°yÒqÕÒl∞∏Ñ¸ÏÈt•ç°§†¸ıqÕÒl∞∏Ñ¸ÏÈuê§ºπ—ïÕ–°—ï·–§Ï(ÄÅ•òÄ°°ÖÕπ†ÄÙÙÙÅ°ÖÕ°§§Å…ï—’…∏Åπ’±∞Ï(ÄÅ…ï—’…∏ÅÏÅŸÖ±’îËÅ°ÖÕπ†Ä¸ÄâÖπ†àÄËÄâç£ÜÓ,à∞ÅÕΩ’…çîËÄâÖ•}…ï¡±‰àÅÙÏ)Ù()ô’πç—•Ω∏ÅÕ’¡¡Ω…—MÖ±’—Ö—•Ωπ…Ωµ’Õ—Ωµï»°ç’Õ—Ωµï»§ÅÏ(ÄÅçΩπÕ–Å¡…ïôï……ïêÄÙÅπΩ…µÖ±•ÈïY•ï—πÖµïÕî°M—…•πú°ç’Õ—Ωµï»¸π¡…ïôï……ïë}ÕÖ±’—Ö—•Ω∏ÅÒÄàà§§π—…•¥†§Ï(ÄÅ•òÄ°¡…ïôï……ïêÄÙÙÙÄâÖπ†à§Å…ï—’…∏ÅÏÅŸÖ±’îËÄâÖπ†à∞ÅÕΩ’…çîËÄâ¡…ïôï……ïë}ÕÖ±’—Ö—•Ω∏àÅÙÏ(ÄÅ•òÄ°¡…ïôï……ïêÄÙÙÙÄâç°§à§Å…ï—’…∏ÅÏÅŸÖ±’îËÄâç£ÜÓ,à∞ÅÕΩ’…çîËÄâ¡…ïôï……ïë}ÕÖ±’—Ö—•Ω∏àÅÙÏ(ÄÅçΩπÕ–Åùïπëï»ÄÙÅπΩ…µÖ±•ÈïY•ï—πÖµïÕî°M—…•πú°ç’Õ—Ωµï»¸πùïπëï»ÅÒÄàà§§π—…•¥†§Ï(ÄÅ•òÄ°lâµÖ±îà∞ÄâπÖ¥à∞ÄâµÖ∏âtπ•πç±’ëïÃ°ùïπëï»§§Å…ï—’…∏ÅÏÅŸÖ±’îËÄâÖπ†à∞ÅÕΩ’…çîËÄâµï—Ö}ùïπëï»àÅÙÏ(ÄÅ•òÄ°lâôïµÖ±îà∞Äâπ‘à∞Äâ›ΩµÖ∏âtπ•πç±’ëïÃ°ùïπëï»§§Å…ï—’…∏ÅÏÅŸÖ±’îËÄâç£ÜÓ,à∞ÅÕΩ’…çîËÄâµï—Ö}ùïπëï»àÅÙÏ(ÄÅ…ï—’…∏Åπ’±∞Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏ÅÕ’¡¡Ω…—’Õ—Ωµï…%ëïπ—•—‰°¡Öùï%ê∞ÅÕïπëï…%ê§ÅÏ(ÄÅçΩπÕ–Å…Ω›ÃÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}ç’Õ—Ωµï…Ã˝Õï±ïç–ıë•Õ¡±ÖÂ}πÖµî±ùïπëï»±¡…ïôï……ïë}ÕÖ±’—Ö—•Ω∏ô¡Öùï}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°¡Öùï%ê§(ÄÄÄÄÄÄ¨Äàôç’Õ—Ωµï…}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°Õïπëï…%ê§(ÄÄÄÄÄÄ¨Äàô±•µ•–Ùƒà∞(ÄÄÄÅÏÅ—•µïΩ’–ËÄ‡¿¿¿ÅÙ∞(ÄÄ§πçÖ—ç†††§ÄÙ¯Åmt§Ï(ÄÅ…ï—’…∏Å…Ω›Ã¸πl¡tÅÒÅÌÙÏ)Ù()ô’πç—•Ω∏ÅÕ’¡¡Ω…—IïÕΩ±ŸïMÖ±’—Ö—•Ω∏°ç’Õ—Ωµï»∞Åëïç•Õ•Ω∏§ÅÏ(ÄÅ…ï—’…∏ÅÕ’¡¡Ω…—MÖ±’—Ö—•Ωπ…Ωµ’Õ—Ωµï»°ç’Õ—Ωµï»§(ÄÄÄÅÒÅÕ’¡¡Ω…—MÖ±’—Ö—•Ωπ…Ωµ$°ëïç•Õ•Ω∏§(ÄÄÄÅÒÅÏÅŸÖ±’îËÅπ’±∞∞ÅÕΩ’…çîËÄâπï’—…Ö±}Ωµ•ÕÕ•Ω∏àÅÙÏ)Ù((ººÅ-ïï¿ÅçÖ…Ω’Õï∞ÅçΩ¡‰Å•π—ïπ—•ΩπÖ±±‰Åπï’—…Ö∞∏ÅQ°•ÃÅ•ÃÅÕÖôï»Å—°Ö∏Åù’ïÕÕ•πúÅùïπëï»ÅÖπê(ººÅ›Ω…≠ÃÅÖç…ΩÕÃÅïŸï…‰Å¡…Ωë’ç–Åù…Ω’¿Å›•—°Ω’–ÅµÖ≠•πúÅ—°îÅÕ’¡¡Ω…–ÅµïÕÕÖùîÅôïï∞Å—ïµ¡±Ö—ïê∏)ô’πç—•Ω∏ÅÕ’¡¡Ω…—Ö…Ω’Õï±M’â—•—±î†§ÅÏ(ÄÅ…ï—’…∏Äâ7ÜÓe–Å€Å§Å∑ÜÍ≠‘ÅãÖ∏Åç£ÜÍÖ‰ÉGÜÓÅ—°Ö¥Å≠£ÜÍçºÅ—À√ÜÓmåàÏ)Ù()ô’πç—•Ω∏ÅÕ’¡¡Ω…—M±•ëïÖ¡—•Ω∏°ùÖ—î∞Åëïç•Õ•Ω∏§ÅÏ(ÄÅçΩπÕ–Å…ïçïπ—Ωπ—Öç—Iï≈’ïÕ–ÄÙÅÕ’¡¡Ω…—Iï¡±ÂIï≈’ïÕ—ÕΩπ—Öç–°ùÖ—î¸π±•ŸïAÖùïIï¡±‰§(ÄÄÄÅÒÅM—…•πú°ëïç•Õ•Ω∏¸πΩ’—¡’–¸πçΩπ—Öç—}Õ—Ö—îÅÒÄàà§π—Ω1Ω›ï…ÖÕî†§ÄÙÙÙÄâµ•ÕÕ•πù}…ïçïπ—±Â}…ï≈’ïÕ—ïêàÏ((ÄÄººÅUπ•Ÿï…ÕÖ∞ÅÕ’¡¡Ω…–ÅQËÅ’Õïô’∞ÅôΩ»ÅïŸï…‰ÅçÖ—Ö±ΩúΩ¡…Ωë’ç–ÅÖπêÅÖŸΩ•ëÃÅùïπëï»Åµ•Õ—Ö≠ïÃ∏(ÄÄººÅºÅπΩ–Å…ï¡ïÖ–Å—°îÅçΩπ—Öç–Å…ï≈’ïÕ–Å›°ï∏Å—°îÅç’Õ—Ωµï»ÅÖ±…ïÖë‰Å°ÖÃÅçΩπ—Öç–Å•πôºÅΩ»(ÄÄººÅ%-Ω¡ÖùîÅ°ÖÃÅ©’Õ–ÅÖÕ≠ïêÅôΩ»Å•–∏(ÄÅ•òÄ°ùÖ—î¸πçΩπ—Öç—-πΩ›∏ÅÒÅ…ïçïπ—Ωπ—Öç—Iï≈’ïÕ–§ÅÏ(ÄÄÄÅ…ï—’…∏Äâ¥ÅüÜÓµ§Å∑ÜÓe–ÅœÜÓDÅ∑ÜÍ≠‘ÅãÖ∏Åç£ÜÍÖ‰ÉGÜÓÅ—°Ö¥Å≠£ÜÍçºÅ—À√ÜÓmåÉÜÍÑ∏àÏ(ÄÅÙ(ÄÅ…ï—’…∏Äâ¥ÅüÜÓµ§Å∑ÜÓe–ÅœÜÓDÅ∑ÜÍ≠‘ÅãÖ∏Åç£ÜÍÖ‰ÉGÜÓÅ—°Ö¥Å≠£ÜÍçºÅ—À√ÜÓmåÏÅªÜÍ˝‘ÅèÜÍù∏ÉGÈπúÅ∑ÜÍ≠‘Å€ÄÅãÖºÅùßÑÅç£µπ†Å„Öå∞Åç°ºÅï¥Å·•∏ÅOAPΩiÖ±ºÅπ£§∏àÏ)Ù((ººÅ%U-}Xƒ¡}MUAA=IQ}M1UQQ%=9}X…}9UQI1}Q)ô’πç—•Ω∏ÅÕ’¡¡Ω…—Ωµ¡Öç—%µÖùïIï¡±‰°ùÖ—î§ÅÏ(ÄÅ±ï–Å—ï·–ÄÙÅM—…•πú°ùÖ—î¸π—ï·–ÅÒÄàà§π…ï¡±Öçî†ΩqÃ¨Ωú∞ÄàÄà§π—…•¥†§Ï(ÄÅ•òÄ°ùÖ—î¸πçΩπ—Öç—-πΩ›∏ÅÒÅÕ’¡¡Ω…—Iï¡±ÂIï≈’ïÕ—ÕΩπ—Öç–°ùÖ—î¸π±•ŸïAÖùïIï¡±‰§§ÅÏ(ÄÄÄÅ—ï·–ÄÙÅÕ—…•¡Iï¡ïÖ—ïëΩπ—Öç—Iï≈’ïÕ–°—ï·–§Ï(ÄÅÙ(ÄÅ•òÄ†Ö—ï·–§Å…ï—’…∏ÄààÏ(ÄÅçΩπÕ–ÅÕïπ—ïπçîÄÙÅ—ï·–πµÖ—ç††Ωx∏®˝l∏Ñ˝t†¸ÈqÕê§º§¸πl¡t¸π—…•¥†§ÅÒÅ—ï·–Ï(ÄÅ…ï—’…∏ÅÕïπ—ïπçîπÕ±•çî†¿∞Ä»ÿ¿§π—…•¥†§Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏Å±•ŸïAÖùïIï¡±ÂŸ•ëïπçî°ëïç•Õ•Ω∏∞Åç’Õ—Ωµï…–§ÅÏ(ÄÅçΩπÕ–Å¡Öùï%êÄÙÅM—…•πú°ëïç•Õ•Ω∏¸π¡Öùï}•êÅÒÄàà§π—…•¥†§Ï(ÄÅçΩπÕ–ÅÕïπëï…%êÄÙÅM—…•πú°ëïç•Õ•Ω∏¸πÕïπëï…}•êÅÒÄàà§π—…•¥†§Ï(ÄÅçΩπÕ–Å—Ω≠ï∏ÄÙÅM—…•πú°¡…ΩçïÕÃπïπÿπA9-}A}MM}Q=-8ÅÒÄàà§π—…•¥†§Ï(ÄÅ•òÄ†Ö¡Öùï%êÅÒÄÖÕïπëï…%êÅÒÄÖ—Ω≠ï∏ÅÒÄÖç’Õ—Ωµï…–§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏÅç°ïç≠}’πÖŸÖ•±Öâ±îËÅ—…’î∞ÅïŸ•ëïπçîËÄâ¡ÖπçÖ≠ï}±•Ÿï}ÕπÖ¡Õ°Ω—}πΩ—}çΩπô•ù’…ïêàÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Å±Ö—ïÕ—’Õ—Ωµï…Qï·–ÄÙÅ±•ŸïAÖùïIï¡±Â1Ö—ïÕ—’Õ—Ωµï…Qï·–°ëïç•Õ•Ω∏§Ï(ÄÅçΩπÕ–ÅÕπÖ¡Õ°Ω–ÄÙÅÖ›Ö•–Å±•ŸïAÖùïIï¡±ÂMπÖ¡Õ°Ω—Öç°îπ±ΩÖê°¡Öùï%ê∞Å—Ω≠ï∏§Ï(ÄÅçΩπÕ–ÅÕπÖ¡Õ°Ω—!ïÖ±—°‰ÄÙÄ°ÕπÖ¡Õ°Ω–¸πÖ——ïµ¡—ÃÅÒÅmt§πÕΩµî†°Ö——ïµ¡–§ÄÙ¯Å9’µâï»°Ö——ïµ¡–¸πÕ—Ö—’ÃÅÒÄ¿§Ä¯ÙÄ»¿¿ÄòòÅ9’µâï»°Ö——ïµ¡–¸πÕ—Ö—’ÃÅÒÄ¿§ÄÄÃ¿¿§Ï(ÄÅ•òÄ†ÖÕπÖ¡Õ°Ω—!ïÖ±—°‰§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÅç°ïç≠}’πÖŸÖ•±Öâ±îËÅ—…’î∞(ÄÄÄÄÄÅïŸ•ëïπçîËÄâ¡ÖπçÖ≠ï}±•Ÿï}ÕπÖ¡Õ°Ω—}’πÖŸÖ•±Öâ±îà∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}±ΩÖëïë}Ö–ËÅÕπÖ¡Õ°Ω–¸π±ΩÖëïë}Ö–ÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}Ö——ïµ¡—ÃËÅÕπÖ¡Õ°Ω–¸πÖ——ïµ¡—ÃÅÒÅmt∞(ÄÄÄÅÙÏ(ÄÅÙ(ÄÅçΩπÕ–Å…Ω‹ÄÙÄ°ÕπÖ¡Õ°Ω–¸π…Ω›ÃÅÒÅmt§πô•πê†°•—ï¥§ÄÙ¯Å±•ŸïAÖùïIï¡±ÂΩπŸï…ÕÖ—•Ωπ5Ö—ç°ïÃ°•—ï¥∞ÅÕïπëï…%ê§§Ï(ÄÅ•òÄ†Ö…Ω‹§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÅπΩ}…ï¡±Â}ΩâÕï…ŸïêËÅ—…’î∞(ÄÄÄÄÄÅïŸ•ëïπçîËÄâ¡ÖπçÖ≠ï}±•Ÿï}ÕπÖ¡Õ°Ω—}ç°ïç≠ïë}πΩ}çΩπŸï…ÕÖ—•Ωπ}…ï¡±‰à∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}±ΩÖëïë}Ö–ËÅÕπÖ¡Õ°Ω–¸π±ΩÖëïë}Ö–ÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}Ö——ïµ¡—ÃËÅÕπÖ¡Õ°Ω–¸πÖ——ïµ¡—ÃÅÒÅmt∞(ÄÄÄÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Å’¡ëÖ—ïë—YÖ±’îÄÙÅ…Ω‹π’¡ëÖ—ïë}Ö–ÅÒÅ…Ω‹π±ÖÕ—}µïÕÕÖùî¸πç…ïÖ—ïë}Ö–ÅÒÅ…Ω‹π±ÖÕ—}µïÕÕÖùï}Ö–ÅÒÅπ’±∞Ï(ÄÅçΩπÕ–Å’¡ëÖ—ïë–ÄÙÅ±•ŸïAÖùïIï¡±ÂQ•µî°’¡ëÖ—ïë—YÖ±’î§Ï(ÄÅçΩπÕ–Å¡ÖπçÖ≠ï’Õ—Ωµï…–ÄÙÅ±•ŸïAÖùïIï¡±ÂQ•µî°…Ω‹π±ÖÕ—}ç’Õ—Ωµï…}µïÕÕÖùï}Ö–ÅÒÅ…Ω‹π±ÖÕ—}ç’Õ—Ωµï…}Ö–ÅÒÄàà§Ï(ÄÅçΩπÕ–Åïôôïç—•Ÿï’Õ—Ωµï…–ÄÙÅ5Ö—†πµÖ‡°ç’Õ—Ωµï…–∞Å¡ÖπçÖ≠ï’Õ—Ωµï…–ÅÒÄ¿§Ï(ÄÅçΩπÕ–ÅÕπ•¡¡ï–ÄÙÅM—…•πú°…Ω‹πÕπ•¡¡ï–ÅÒÅ…Ω‹π±ÖÕ—}µïÕÕÖùî¸πµïÕÕÖùîÅÒÅ…Ω‹π±ÖÕ—}µïÕÕÖùî¸π—ï·–ÅÒÄàà§π—…•¥†§Ï(ÄÅçΩπÕ–ÅπΩ…µÖ±•ÈïëMπ•¡¡ï–ÄÙÅ±•ŸïAÖùïIï¡±ÂQï·–°Õπ•¡¡ï–§Ï(ÄÅçΩπÕ–ÅÕïπëï»ÄÙÅ±•ŸïAÖùïIï¡±ÂMïπëï»°…Ω‹§Ï((ÄÅ•òÄ†ÖÕïπëï»ÅÒÄÖ’¡ëÖ—ïë–ÅÒÅ’¡ëÖ—ïë–ÄÙÅïôôïç—•Ÿï’Õ—Ωµï…–Ä¨Ä‘¿¿§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÅπΩ}…ï¡±Â}ΩâÕï…ŸïêËÅ—…’î∞(ÄÄÄÄÄÅïŸ•ëïπçîËÄâ¡ÖπçÖ≠ï}±•Ÿï}ÕπÖ¡Õ°Ω—}ç°ïç≠ïë}ç’Õ—Ωµï…}Õ—•±±}±Ö—ïÕ–à∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}±ΩÖëïë}Ö–ËÅÕπÖ¡Õ°Ω–¸π±ΩÖëïë}Ö–ÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}Ö——ïµ¡—ÃËÅÕπÖ¡Õ°Ω–¸πÖ——ïµ¡—ÃÅÒÅmt∞(ÄÄÄÅÙÏ(ÄÅÙ(ÄÅ•òÄ°±Ö—ïÕ—’Õ—Ωµï…Qï·–ÄòòÅπΩ…µÖ±•ÈïëMπ•¡¡ï–ÄòòÅπΩ…µÖ±•ÈïëMπ•¡¡ï–ÄÙÙÙÅ±Ö—ïÕ—’Õ—Ωµï…Qï·–§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÅπΩ}…ï¡±Â}ΩâÕï…ŸïêËÅ—…’î∞(ÄÄÄÄÄÅïŸ•ëïπçîËÄâ¡ÖπçÖ≠ï}±•Ÿï}ÕπÖ¡Õ°Ω—}ç°ïç≠ïë}ç’Õ—Ωµï…}—ï·—}±Ö—ïÕ–à∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}±ΩÖëïë}Ö–ËÅÕπÖ¡Õ°Ω–¸π±ΩÖëïë}Ö–ÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕπÖ¡Õ°Ω—}Ö——ïµ¡—ÃËÅÕπÖ¡Õ°Ω–¸πÖ——ïµ¡—ÃÅÒÅmt∞(ÄÄÄÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–ÅÖç—Ω…9ÖµîÄÙÅM—…•πú°Õïπëï»πÖëµ•π}πÖµîÅÒÅÕïπëï»ππÖµîÅÒÅÕïπëï»πÖç—Ω…}πÖµîÅÒÄàà§π—…•¥†§Ï(ÄÅçΩπÕ–ÅÖç—Ω…¡¡%êÄÙÅM—…•πú°Õïπëï»πÖ¡¡}•êÅÒÅÕïπëï»πÖ¡¡±•çÖ—•Ωπ}•êÅÒÅÕïπëï»πâΩ—}•êÅÒÄàà§π—…•¥†§Ï(ÄÅ…ï—’…∏ÅÏ(ÄÄÄÅÕΩ’…çï}ÕÂÕ—ï¥ËÅ±•ŸïAÖùïIï¡±ÂMΩ’…çî°…Ω‹§∞(ÄÄÄÅÕïπ—}Ö–ËÅπï‹ÅÖ—î°’¡ëÖ—ïë–§π—Ω%M=M—…•πú†§∞(ÄÄÄÅÖç—Ω…}πÖµîËÅÖç—Ω…9ÖµîÅÒÅπ’±∞∞(ÄÄÄÅÖç—Ω…}Ö¡¡}•êËÅÖç—Ω…¡¡%êÅÒÅπ’±∞∞(ÄÄÄÅµïÕÕÖùï}—ï·–ËÅÕπ•¡¡ï–πÕ±•çî†¿∞Äÿ¿¿§ÅÒÅπ’±∞∞(ÄÄÄÅçΩπŸï…ÕÖ—•Ωπ}•êËÅM—…•πú°…Ω‹π•êÅÒÅ…Ω‹πçΩπŸï…ÕÖ—•Ωπ}•êÅÒÄàà§π—…•¥†§ÅÒÅπ’±∞∞(ÄÄÄÅïŸ•ëïπçîËÄâ¡ÖπçÖ≠ï}±•Ÿï}Õ°Ö…ïë}¡Öùï}ÕπÖ¡Õ°Ω–à∞(ÄÄÄÅπΩ}…ï¡±Â}ΩâÕï…ŸïêËÅôÖ±Õî∞(ÄÄÄÅç°ïç≠}’πÖŸÖ•±Öâ±îËÅôÖ±Õî∞(ÄÄÄÅÕπÖ¡Õ°Ω—}±ΩÖëïë}Ö–ËÅÕπÖ¡Õ°Ω–¸π±ΩÖëïë}Ö–ÅÒÅπ’±∞∞(ÄÄÄÅÕπÖ¡Õ°Ω—}Ö——ïµ¡—ÃËÅÕπÖ¡Õ°Ω–¸πÖ——ïµ¡—ÃÅÒÅmt∞(ÄÅÙÏ)Ù((ººÅ%U-}Xƒ¡}1%Y}A}IA1e}UI}X…}MUAA=IP()ÖÕÂπåÅô’πç—•Ω∏Åô•πÖ±Ö—î°ëïç•Õ•Ω∏∞ÅçΩπô•ú§ÅÏ(ÄÅçΩπÕ–Å¡ÖùîÄÙÅÖ›Ö•–Å¡ÖùïIΩ‹°ëïç•Õ•Ω∏π¡Öùï}•ê§Ï(ÄÅçΩπÕ–ÅÖ’—°Ω…•—‰ÄÙÅ…ïÕΩ±Ÿï°Öππï±’—°Ω…•—‰°ÏÅ…’π—•µîËÅçΩπô•ú∞Å¡Öùî∞Åç°Öππï∞ËÄâ±•ŸîàÅÙ§Ï(ÄÅ•òÄ†ÖÖ’—°Ω…•—‰πÖ±±Ω›ïê§Å…ï—’…∏ÅÖ’—°Ω…•—‰Ï(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—5ΩëîÄÙÅÖ’—°Ω…•—‰πµΩëîÄÙÙÙÄâMUAA=IPàÏ((ÄÅçΩπÕ–Åç’—ΩŸï»ÄÙÅÕ’¡¡Ω…—5Ωëî(ÄÄÄÄ¸Ä°¡Öùî¸πÕï——•πùÃ¸πÕ’¡¡Ω…—}ç’—ΩŸï…}Ö–ÅÒÅ¡Öùî¸πÕï——•πùÃ¸πÖç—•Ÿï}ç’—ΩŸï…}Ö–§(ÄÄÄÄËÅ¡Öùî¸πÕï——•πùÃ¸πÖç—•Ÿï}ç’—ΩŸï…}Ö–Ï(ÄÅ•òÄ†Öç’—ΩŸï»ÅÒÄÖ•Õô—ï…=…≈’Ö∞°ëïç•Õ•Ω∏πç…ïÖ—ïë}Ö–∞Åç’—ΩŸï»§§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâAI}UQ=YI}%M%=8àÅÙÏ(ÄÅ•òÄ°Ö—îππΩ‹†§Ä¥ÅÖ—îπ¡Ö…Õî°ëïç•Õ•Ω∏πç…ïÖ—ïë}Ö–§Ä¯Å5a}%M%=9}}5L§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ%M%=9}Q==}=1àÅÙÏ((ÄÅçΩπÕ–ÅçΩπŸï…ÕÖ—•Ω∏ÄÙÅëïç•Õ•Ω∏¸π•π¡’—}ÕπÖ¡Õ°Ω–¸πçΩπŸï…ÕÖ—•Ω∏ÅÒÅÌÙÏ(ÄÅ•òÄ°çΩπŸï…ÕÖ—•Ω∏¸πÕÖôï—‰¸πΩ¡—}Ω’–§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ=AQ}=UPàÅÙÏ(ÄÅçΩπÕ–ÅçΩµµïπ—Ωπ—ï·–ÄÙÅçΩµµïπ—A…•ŸÖ—ïIï¡±ÂΩπ—ï·—…Ωµ5ïÕÕÖùïÃ°çΩπŸï…ÕÖ—•Ω∏¸πµïÕÕÖùïÃÅÒÅmt§Ï(ÄÅçΩπÕ–ÅÕπÖ¡Õ°Ω—AÖùïIï¡±Âô—ï…1Ö—ïÕ—’Õ—Ωµï»ÄÙÅ¡ÖùïIï¡±Âô—ï…1Ö—ïÕ—’Õ—Ωµï…%π=…ëï»°çΩπŸï…ÕÖ—•Ω∏¸πµïÕÕÖùïÃÅÒÅmt§Ï(ÄÅçΩπÕ–ÅΩ’—¡’–ÄÙÅëïç•Õ•Ω∏πΩ’—¡’–ÅÒÅÌÙÏ(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—M±•ëï±•ù•â±îÄÙÄÖçΩµµïπ—Ωπ—ï·–ÄòòÅÕ’¡¡Ω…—5ΩëîÄòòÄ°Ω’—¡’–ππïïëÕ}Õ±•ëïÃÄÙÙÙÅ—…’îÅÒÅëïç•Õ•Ω∏πÖç—•Ω∏ÄÙÙÙÄâ…ï¡±Â}›•—°}Õ±•ëïÃà§Ï(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—%µÖùï±•ù•â±îÄÙÅÕ’¡¡Ω…—5Ωëî(ÄÄÄÄòòÄÖçΩµµïπ—Ωπ—ï·–(ÄÄÄÄòòÄÖÕ’¡¡Ω…—M±•ëï±•ù•â±î(ÄÄÄÄòòÅ¡Öùî¸πÕï——•πùÃ¸πÕ’¡¡Ω…—}•µÖùï}…ï¡±Â}ïπÖâ±ïêÄÙÙÙÅ—…’î(ÄÄÄÄòòÅÕ’¡¡Ω…—1Ö—ïÕ—’Õ—Ωµï…!ÖÕ——Öç°µïπ–°ëïç•Õ•Ω∏§Ï(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—Ö±±âÖç≠Iï≈’ïÕ—ïêÄÙÄÖçΩµµïπ—Ωπ—ï·–ÄòòÅÕ’¡¡Ω…—5ΩëîÄòòÅΩ’—¡’–πΩ¡ï…Ö—•ΩπÖ±}Õ’¡¡Ω…—}ôÖ±±âÖç¨ÄÙÙÙÅ—…’îÏ(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—Ö±±âÖç≠]Ö•—5ÃÄÙÅ5Ö—†πµÖ‡†(ÄÄÄÄÿ¿¿¿¿∞(ÄÄÄÅ9’µâï»°¡…ΩçïÕÃπïπÿπ%U-}Xƒ¡}MUAA=IQ}11	-}M=9LÅÒÄ‰¿§Ä®Äƒ¿¿¿∞(ÄÄÄÄ°9’µâï»°çΩπô•úπ…ïÕ¡ΩπÕï}Õ±Ö}ÕïçΩπëÃÅÒÄ–‘§Ä¨ÄÃ¿§Ä®Äƒ¿¿¿∞(ÄÄ§Ï(ÄÄººÅ%Ö≠îÅ—ï·–ÅçÖ∏ÅÕÖ—•Õô‰ÅÑÅ—ï·–ÅôÖ±±âÖç¨∞Åâ’–ÅπïŸï»ÅÑÅ¡ïπë•πúÅµïë•ÑÅë’—‰∏(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—Qï·—Ö±±âÖç≠±•ù•â±îÄÙÄÖÕ’¡¡Ω…—M±•ëï±•ù•â±î(ÄÄÄÄòòÄÖÕ’¡¡Ω…—%µÖùï±•ù•â±î(ÄÄÄÄòòÅÕ’¡¡Ω…—Ö±±âÖç≠Iï≈’ïÕ—ïê(ÄÄÄÄòòÅ¡Öùî¸πÕï——•πùÃ¸πÕ’¡¡Ω…—}Ω¡ï…Ö—•ΩπÖ±}ôÖ±±âÖç≠}ïπÖâ±ïêÄÙÙÙÅ—…’î(ÄÄÄÄòòÅÖ—îππΩ‹†§Ä¥Å±Ö—ïÕ—’Õ—Ωµï…–°ëïç•Õ•Ω∏§Ä¯ÙÅÕ’¡¡Ω…—Ö±±âÖç≠]Ö•—5ÃÏ(ÄÅ•òÄ°Õ’¡¡Ω…—5ΩëîÄòòÄÖçΩµµïπ—Ωπ—ï·–ÄòòÄÖÕ’¡¡Ω…—M±•ëï±•ù•â±îÄòòÄÖÕ’¡¡Ω…—%µÖùï±•ù•â±îÄòòÄÖÕ’¡¡Ω…—Qï·—Ö±±âÖç≠±•ù•â±î§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâMUAA=IQ}5%}=91dàÅÙÏ(ÄÅÙ((ÄÅ±ï–Å—ï·–ÄÙÅM—…•πú°Ω’—¡’–πô•πÖ±}…ï¡±‰ÅÒÄàà§π—…•¥†§Ï(ÄÅ•òÄ††Ö—ï·–ÄòòÄÖÕ’¡¡Ω…—M±•ëï±•ù•â±î§ÅÒÅëïç•Õ•Ω∏πÖç—•Ω∏ÄÙÙÙÄâÕ’¡¡…ïÕÃà§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ9=}M9}Q%=8àÅÙÏ(ÄÅ•òÄ°9’µâï»°ëïç•Õ•Ω∏πçΩπô•ëïπçîÅÒÅΩ’—¡’–πçΩπô•ëïπçîÅÒÄ¿§ÄÄ¿∏–‘§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ=9%9}Q==}1=\àÅÙÏ((ÄÅçΩπÕ–ÅÕ—Ö—îÄÙÅÖ›Ö•–ÅÕ—Ö—ïIΩ‹°ëïç•Õ•Ω∏π¡Öùï}•ê∞Åëïç•Õ•Ω∏πÕïπëï…}•ê§Ï(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—’Õ—Ωµï»ÄÙÅÕ’¡¡Ω…—5ΩëîÄòòÄÖçΩµµïπ—Ωπ—ï·–Ä¸ÅÖ›Ö•–ÅÕ’¡¡Ω…—’Õ—Ωµï…%ëïπ—•—‰°ëïç•Õ•Ω∏π¡Öùï}•ê∞Åëïç•Õ•Ω∏πÕïπëï…}•ê§ÄËÅÌÙÏ(ÄÅçΩπÕ–ÅÕ’¡¡Ω…—MÖ±’—Ö—•Ωπ%πôºÄÙÅÕ’¡¡Ω…—5ΩëîÄòòÄÖçΩµµïπ—Ωπ—ï·–Ä¸ÅÕ’¡¡Ω…—IïÕΩ±ŸïMÖ±’—Ö—•Ω∏°Õ’¡¡Ω…—’Õ—Ωµï»∞Åëïç•Õ•Ω∏§ÄËÅÏÅŸÖ±’îËÅπ’±∞∞ÅÕΩ’…çîËÅπ’±∞ÅÙÏ(ÄÅ•òÄ°°’µÖπQÖ≠ïΩŸï…ç—•Ÿî°Õ—Ö—î§§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ!U59}Q-=YHàÅÙÏ((ÄÅçΩπÕ–Åç’Õ—Ωµï…–ÄÙÅ±Ö—ïÕ—’Õ—Ωµï…–°ëïç•Õ•Ω∏§Ï(ÄÅçΩπÕ–Å±•Ÿï’Õ—Ωµï…–ÄÙÅÖ—îπ¡Ö…Õî°Õ—Ö—îπ±ÖÕ—}ç’Õ—Ωµï…}ïŸïπ—}Ö–ÅÒÄàà§Ï(ÄÅ•òÄ°ç’Õ—Ωµï…–Ä¯Ä¿ÄòòÅ9’µâï»π•Õ•π•—î°±•Ÿï’Õ—Ωµï…–§ÄòòÅ±•Ÿï’Õ—Ωµï…–Ä¯Åç’Õ—Ωµï…–Ä¨Ä»‘¿§ÅÏ(ÄÄÄÅçΩπÕ–Åµï…ùîÄÙÅÖ›Ö•–ÅïπÕ’…ï1Ö—ïÕ—’Õ—Ωµï…±’Õ—ï…)Ωà°ëïç•Õ•Ω∏∞ÅÕ—Ö—î∞ÅçΩπô•ú§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâUMQ=5I}1UMQI}Y9}]%Q}5Ià∞Åµï…ùîÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Å¡Öùï–ÄÙÅÖ—îπ¡Ö…Õî°Õ—Ö—îπ±ÖÕ—}¡Öùï}ïŸïπ—}Ö–ÅÒÄàà§Ï(ÄÅçΩπÕ–Å¡Öùï±ïÖ…±Âô—ï…’Õ—Ωµï»ÄÙÅç’Õ—Ωµï…–Ä¯Ä¿ÄòòÅ9’µâï»π•Õ•π•—î°¡Öùï–§ÄòòÅ¡Öùï–Ä¯Åç’Õ—Ωµï…–Ä¨Äƒ¿¿¿Ï(ÄÅçΩπÕ–Å¡Öùï=…ëï…ïëô—ï…’Õ—Ωµï»ÄÙÅç’Õ—Ωµï…–Ä¯Ä¿ÄòòÅ9’µâï»π•Õ•π•—î°¡Öùï–§ÄòòÅ¡Öùï–Ä¯ÙÅç’Õ—Ωµï…–ÄòòÅÕπÖ¡Õ°Ω—AÖùïIï¡±Âô—ï…1Ö—ïÕ—’Õ—Ωµï»Ï(ÄÅçΩπÕ–Å¡Öùï±…ïÖëÂIï¡±•ïêÄÙÄÖçΩµµïπ—Ωπ—ï·–ÄòòÄ°¡Öùï±ïÖ…±Âô—ï…’Õ—Ωµï»ÅÒÅ¡Öùï=…ëï…ïëô—ï…’Õ—Ωµï»§Ï(ÄÅçΩπÕ–Å±•ŸïAÖùïIï¡±ÂA…ΩâîÄÙÅçΩµµïπ—Ωπ—ï·–(ÄÄÄÄ¸ÅÏÅπΩ}…ï¡±Â}ΩâÕï…ŸïêËÅ—…’î∞ÅïŸ•ëïπçîËÄâçΩµµïπ—}¡…•ŸÖ—ï}…ï¡±Â}ëïë’¡ïë}âÂ}çΩµµïπ—}•êàÅÙ(ÄÄÄÄËÅÖ›Ö•–Å±•ŸïAÖùïIï¡±ÂŸ•ëïπçî°ëïç•Õ•Ω∏∞Åç’Õ—Ωµï…–§πçÖ—ç††°ï……Ω»§ÄÙ¯Ä°Ï(ÄÄÄÄÄÄÄÅç°ïç≠}’πÖŸÖ•±Öâ±îËÅ—…’î∞(ÄÄÄÄÄÄÄÅïŸ•ëïπçîËÄâ¡ÖπçÖ≠ï}±•Ÿï}ÕπÖ¡Õ°Ω—}ï……Ω»à∞(ÄÄÄÄÄÄÄÅï……Ω»ËÅM—…•πú°ï……Ω»¸πµïÕÕÖùîÅÒÅï……Ω»§πÕ±•çî†¿∞ÄÃ¿¿§∞(ÄÄÄÄÄÅÙ§§Ï(ÄÅçΩπÕ–Å±•ŸïAÖùïIï¡±‰ÄÙÅ±•ŸïAÖùïIï¡±ÂA…Ωâî¸ππΩ}…ï¡±Â}ΩâÕï…ŸïêÅÒÅ±•ŸïAÖùïIï¡±ÂA…Ωâî¸πç°ïç≠}’πÖŸÖ•±Öâ±î(ÄÄÄÄ¸Åπ’±∞(ÄÄÄÄËÅ±•ŸïAÖùïIï¡±ÂA…ΩâîÏ((ÄÅ•òÄ°Õ’¡¡Ω…—Qï·—Ö±±âÖç≠±•ù•â±î§ÅÏ(ÄÄÄÅ•òÄ°±•ŸïAÖùïIï¡±‰§ÅÏ(ÄÄÄÄÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâMUAA=IQ}AI%5Ie}IA1%}	=I}11	,à∞Å±•Ÿï}¡Öùï}…ï¡±‰ËÅ±•ŸïAÖùïIï¡±‰ÅÙÏ(ÄÄÄÅÙ(ÄÄÄÅ•òÄ°¡Öùï±…ïÖëÂIï¡±•ïê§ÅÏ(ÄÄÄÄÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâMUAA=IQ}A}IA1%}	=I}11	,à∞Å±•Ÿï}¡Öùï}…ï¡±‰ËÅ±•ŸïAÖùïIï¡±‰ÅÙÏ(ÄÄÄÅÙ(ÄÄÄÅ•òÄ°±•ŸïAÖùïIï¡±ÂA…Ωâî¸πç°ïç≠}’πÖŸÖ•±Öâ±î§ÅÏ(ÄÄÄÄÄÅçΩπÕ–ÅôΩ…çïô—ï…5ÃÄÙÅ5Ö—†πµÖ‡†(ÄÄÄÄÄÄÄÅÕ’¡¡Ω…—Ö±±âÖç≠]Ö•—5ÃÄ¨Äÿ¿¿¿¿∞(ÄÄÄÄÄÄÄÅ9’µâï»°¡…ΩçïÕÃπïπÿπ%U-}Xƒ¡}MUAA=IQ}11	-}=I}M=9LÅÒÄÃ¿¿§Ä®Äƒ¿¿¿∞(ÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÅ•òÄ°Ö—îππΩ‹†§Ä¥Åç’Õ—Ωµï…–ÄÅôΩ…çïô—ï…5Ã§ÅÏ(ÄÄÄÄÄÄÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ï—…ÂÖâ±îËÅ—…’î∞Å…ïÖÕΩ∏ËÄâMUAA=IQ}11	-}A9-}!-}IQIdàÅÙÏ(ÄÄÄÄÄÅÙ(ÄÄÄÅÙ(ÄÅÙ((ÄÅ•òÄ°±•ŸïAÖùïIï¡±‰§ÅÏ(ÄÄÄÅ•òÄ†ÖÕ’¡¡Ω…—5ΩëîÅÒÅ±•ŸïAÖùïIï¡±‰πÕΩ’…çï}ÕÂÕ—ï¥ÄÙÙÙÄâ°’µÖπ}Öëµ•∏à§ÅÏ(ÄÄÄÄÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ1%Y}A}1Ie}IA1%à∞Å±•Ÿï}¡Öùï}…ï¡±‰ËÅ±•ŸïAÖùïIï¡±‰ÅÙÏ(ÄÄÄÅÙ(ÄÅÙ(ÄÅ•òÄ°¡Öùï±…ïÖëÂIï¡±•ïê§ÅÏ(ÄÄÄÅ•òÄ†ÖÕ’¡¡Ω…—5Ωëî§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâA}1Ie}IA1%àÅÙÏ(ÄÄÄÅ•òÄ†Ö±•ŸïAÖùïIï¡±‰§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâMUAA=IQ}A}IA1e}U91MM%%àÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–ÅçΩπ—Öç—-πΩ›∏ÄÙÅ	ΩΩ±ïÖ∏°Õ—Ö—îπ¡°ΩπîÅÒÅÕ—Ö—îπÈÖ±ºÅÒÅlâçÖ¡—’…ïêà∞ÄâŸï…•ô•ïêâtπ•πç±’ëïÃ°M—…•πú°Õ—Ö—îπçΩπ—Öç—}Õ—Ö—’ÃÅÒÄàà§π—Ω1Ω›ï…ÖÕî†§§§Ï(ÄÅ•òÄ°çΩπ—Öç—-πΩ›∏ÄòòÅΩ’—¡’–πÕ°Ω’±ë}…ï≈’ïÕ—}çΩπ—Öç–§ÅÏ(ÄÄÄÅ—ï·–ÄÙÅÕ—…•¡Iï¡ïÖ—ïëΩπ—Öç—Iï≈’ïÕ–°—ï·–§ÅÒÄâÜÍÑÅï¥ÉGåÅπ£ÜÍµ∏ÅªÜÓe§Åë’πúÅ€ÄÅ—ßÜÍ˝¿Å”ÜÓïåÅ£ÜÓ\Å—ÀÜÓåÅ”ÜÍÖ§Å5ïÕÕïπùï»ÉÜÍÑ∏àÏ(ÄÅÙ((ÄÅ•òÄ†ÖÕ’¡¡Ω…—5ΩëîÄòòÄÖçΩµµïπ—Ωπ—ï·–§ÅÏ(ÄÄÄÅçΩπÕ–Åë’¡±•çÖ—îÄÙÅÖ›Ö•–ÅÕΩŸï…ï•ùπIïçïπ—’¡±•çÖ—î°ëïç•Õ•Ω∏∞Å—ï·–§Ï(ÄÄÄÅ•òÄ°ë’¡±•çÖ—î§Å…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâaQ}UA1%Q}I9Q}IA1dà∞Åë’¡±•çÖ—ï}ëïç•Õ•Ωπ}•êËÅë’¡±•çÖ—îπ•êÅÙÏ(ÄÅÙ(ÄÅ…ï—’…∏ÅÏ(ÄÄÄÅÖ±±Ω›ïêËÅ—…’î∞(ÄÄÄÅ¡Öùî∞(ÄÄÄÅÕ—Ö—î∞(ÄÄÄÅ—ï·–∞(ÄÄÄÅçΩπ—Öç—-πΩ›∏∞(ÄÄÄÅÕ’¡¡Ω…—5Ωëî∞(ÄÄÄÅÕ’¡¡Ω…—M±•ëï±•ù•â±î∞(ÄÄÄÅÕ’¡¡Ω…—%µÖùï±•ù•â±î∞(ÄÄÄÅÕ’¡¡Ω…—Qï·—Ö±±âÖç≠±•ù•â±î∞(ÄÄÄÅçΩµµïπ—Ωπ—ï·–∞(ÄÄÄÅçΩµµïπ—A…•ŸÖ—ïIï¡±‰ËÅ	ΩΩ±ïÖ∏°çΩµµïπ—Ωπ—ï·–§∞(ÄÄÄÅÕ’¡¡Ω…—Ö±±âÖç≠’Ö…ëïù…ÖëïêËÅ	ΩΩ±ïÖ∏°Õ’¡¡Ω…—Qï·—Ö±±âÖç≠±•ù•â±îÄòòÅ±•ŸïAÖùïIï¡±ÂA…Ωâî¸πç°ïç≠}’πÖŸÖ•±Öâ±î§∞(ÄÄÄÅ±•ŸïAÖùïIï¡±‰∞(ÄÄÄÅÕ’¡¡Ω…—MÖ±’—Ö—•Ω∏ËÅÕ’¡¡Ω…—MÖ±’—Ö—•Ωπ%πôºπŸÖ±’î∞(ÄÄÄÅÕ’¡¡Ω…—MÖ±’—Ö—•ΩπMΩ’…çîËÅÕ’¡¡Ω…—MÖ±’—Ö—•Ωπ%πôºπÕΩ’…çî∞(ÄÄÄÅÕ’¡¡Ω…—’Õ—Ωµï…9ÖµîËÅÕ’¡¡Ω…—’Õ—Ωµï»¸πë•Õ¡±ÖÂ}πÖµîÅÒÅπ’±∞∞(ÄÅÙÏ)Ù()ÖÕÂπåÅô’πç—•Ω∏Åç±Ö•¥°ëïç•Õ•Ω∏§ÅÏ(ÄÅçΩπÕ–Å…Ω›ÃÄÙÅÖ›Ö•–ÅçΩ…î°ÅÿÂ}ëïç•Õ•ΩπÃ˝•êıïƒ∏ëÌëïç•Õ•Ω∏π•ëÙôÕ—Ö—’Ãıïƒ∏ëÌïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏πÕ—Ö—’Ã•ıÄ∞ÅÏ(ÄÄÄÅµï—°ΩêËÄâAQ à∞(ÄÄÄÅ¡…ïôï»ËÄâ…ï—’…∏ı…ï¡…ïÕïπ—Ö—•Ω∏à∞(ÄÄÄÅâΩë‰ËÅÏÅÕ—Ö—’ÃËÄâ±•Ÿï}ëï±•Ÿï…Â}¡…ΩçïÕÕ•πúà∞Å’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§ÅÙ∞(ÄÅÙ§Ï(ÄÅ…ï—’…∏Å…Ω›Ã¸πl¡tÅÒÅπ’±∞Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏Åâ’πë±ïΩ»°ëïç•Õ•Ω∏∞Å—ï·–∞ÅÖÕÕï—Ã§ÅÏ(ÄÅçΩπÕ–Å…Ω›ÃÄÙÅÖ›Ö•–ÅçΩ…î†âÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝Ωπ}çΩπô±•ç–ı•ëïµ¡Ω—ïπçÂ}≠ï‰à∞ÅÏ(ÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÅ¡…ïôï»ËÄâ…ïÕΩ±’—•Ω∏ıµï…ùîµë’¡±•çÖ—ïÃ±…ï—’…∏ı…ï¡…ïÕïπ—Ö—•Ω∏à∞(ÄÄÄÅâΩë‰ËÅÏ(ÄÄÄÄÄÅëïç•Õ•Ωπ}•êËÅëïç•Õ•Ω∏π•ê∞(ÄÄÄÄÄÅ¡Öùï}•êËÅëïç•Õ•Ω∏π¡Öùï}•ê∞(ÄÄÄÄÄÅÕïπëï…}•êËÅëïç•Õ•Ω∏πÕïπëï…}•ê∞(ÄÄÄÄÄÅ—ï·—}âΩë‰ËÅ—ï·–∞(ÄÄÄÄÄÅÖÕÕï—}…ïôÃËÅÖÕÕï—Ã∞(ÄÄÄÄÄÅÕ—Ö—’ÃËÄâÕ—Öùïêà∞(ÄÄÄÄÄÅ•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅÅÿƒ¿µëïç•Õ•Ω∏ËëÌëïç•Õ•Ω∏π•ëıÄ∞(ÄÄÄÄÄÅ’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§∞(ÄÄÄÅÙ∞(ÄÅÙ§Ï(ÄÅ…ï—’…∏Å…Ω›Ã¸πl¡tÏ)Ù()ÖÕÂπåÅô’πç—•Ω∏ÅÖ——ïµ¡—Ã°â’πë±ï%ê§ÅÏ(ÄÅ…ï—’…∏ÅçΩ…î°ÅÿÂ}ëï±•Ÿï…Â}Ö——ïµ¡—Ã˝Õï±ïç–ıÖ——ïµ¡—}πº±—…ÖπÕ¡Ω…–±Õ—Ö—’Ã±¡…ΩŸ•ëï…}µïÕÕÖùï}•êôâ’πë±ï}•êıïƒ∏ëÌâ’πë±ï%ëÙôΩ…ëï»ıÖ——ïµ¡—}πºπÖÕçÄ§Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏Å…ïçΩ…ë——ïµ¡–°â’πë±ï%ê∞ÅÖ——ïµ¡—9º∞Å—…ÖπÕ¡Ω…–∞ÅÕ—Ö—’Ã∞Å…ïÕ’±–ÄÙÅÌÙ∞Åï……Ω»ÄÙÅπ’±∞§ÅÏ(ÄÅçΩπÕ–ÅπΩ‹ÄÙÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§Ï(ÄÅÖ›Ö•–ÅçΩ…î†âÿÂ}ëï±•Ÿï…Â}Ö——ïµ¡—Ã˝Ωπ}çΩπô±•ç–ıâ’πë±ï}•ê±Ö——ïµ¡—}πºà∞ÅÏ(ÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÅ¡…ïôï»ËÄâ…ïÕΩ±’—•Ω∏ıµï…ùîµë’¡±•çÖ—ïÃ±…ï—’…∏ıµ•π•µÖ∞à∞(ÄÄÄÅâΩë‰ËÅÏ(ÄÄÄÄÄÅâ’πë±ï}•êËÅâ’πë±ï%ê∞(ÄÄÄÄÄÅÖ——ïµ¡—}πºËÅÖ——ïµ¡—9º∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…–∞(ÄÄÄÄÄÅÕ—Ö—’Ã∞(ÄÄÄÄÄÅ¡…ΩŸ•ëï…}µïÕÕÖùï}•êËÅ…ïÕ’±–¸πµïÕÕÖùï}•êÅÒÅ…ïÕ’±–¸πµïÕÕÖùï%êÅÒÅπ’±∞∞(ÄÄÄÄÄÅ¡…ΩŸ•ëï…}…ïÕ¡ΩπÕîËÅ…ïÕ’±–ÄòòÅ—Â¡ïΩòÅ…ïÕ’±–ÄÙÙÙÄâΩâ©ïç–àÄ¸Å…ïÕ’±–ÄËÅπ’±∞∞(ÄÄÄÄÄÅï……Ω…}çΩëîËÅï……Ω»¸πçΩëîÅÒÅπ’±∞∞(ÄÄÄÄÄÅï……Ω…}µïÕÕÖùîËÅï……Ω»Ä¸ÅM—…•πú°ï……Ω»πµïÕÕÖùîÅÒÅï……Ω»§πÕ±•çî†¿∞Ä‘¿¿§ÄËÅπ’±∞∞(ÄÄÄÄÄÅÕ—Ö…—ïë}Ö–ËÅπΩ‹∞(ÄÄÄÄÄÅçΩµ¡±ï—ïë}Ö–ËÅπΩ‹∞(ÄÄÄÅÙ∞(ÄÅÙ§Ï)Ù(()ô’πç—•Ω∏Åÿƒ¡…•Ÿï•±ï%ê°ŸÖ±’î§ÅÏ(ÄÅçΩπÕ–Å—ï·–ÄÙÅM—…•πú°ŸÖ±’îÅÒÄàà§π—…•¥†§Ï(ÄÅ•òÄ†Ö—ï·–§Å…ï—’…∏ÄààÏ(ÄÅ—…‰ÅÏ(ÄÄÄÅçΩπÕ–Å’…∞ÄÙÅπï‹ÅUI0°—ï·–§Ï(ÄÄÄÅçΩπÕ–Å≈’ï…Â%êÄÙÅM—…•πú°’…∞πÕïÖ…ç°AÖ…ÖµÃπùï–†â•êà§ÅÒÄàà§π—…•¥†§Ï(ÄÄÄÅ•òÄ°≈’ï…Â%ê§Å…ï—’…∏Å≈’ï…Â%êÏ(ÄÄÄÅçΩπÕ–ÅµÖ—ç†ÄÙÅ’…∞π¡Ö—°πÖµîπµÖ—ç††ΩpΩô•±ïpΩëpº°mµiÑµË¿¥Â|µuÏƒ¿∞»¿¡Ù§º§Ï(ÄÄÄÅ…ï—’…∏ÅµÖ—ç†¸πl≈tÅÒÄààÏ(ÄÅÙÅçÖ—ç†ÅÏ(ÄÄÄÅçΩπÕ–ÅµÖ—ç†ÄÙÅ—ï·–πµÖ—ç††º†¸Èl¸ôu•êıÒpΩô•±ïpΩëpº§°mµiÑµË¿¥Â|µuÏƒ¿∞»¿¡Ù§º§Ï(ÄÄÄÅ…ï—’…∏ÅµÖ—ç†¸πl≈tÅÒÄààÏ(ÄÅÙ)Ù()ô’πç—•Ω∏Åÿƒ¡5ïÕÕïπùï…%µÖùïU…∞°ŸÖ±’î§ÅÏ(ÄÅçΩπÕ–ÅÕΩ’…çïU…∞ÄÙÅM—…•πú°ŸÖ±’îÅÒÄàà§π—…•¥†§Ï(ÄÅçΩπÕ–Åô•±ï%êÄÙÅÿƒ¡…•Ÿï•±ï%ê°ÕΩ’…çïU…∞§Ï(ÄÅ•òÄ†Öô•±ï%ê§Å…ï—’…∏ÅÕΩ’…çïU…∞Ï(ÄÅçΩπÕ–ÅçΩπô•ù’…ïêÄÙÅM—…•πú°¡…ΩçïÕÃπïπÿπ%U-}I%Y}%5}AI=ae}	MÅÒÄàà§π—…•¥†§π…ï¡±Öçî†Ωpºêº∞Äàà§Ï(ÄÅçΩπÕ–ÅÕ’¡ÖâÖÕîÄÙÅM—…•πú°¡…ΩçïÕÃπïπÿπMUA	M}UI0ÅÒÄàà§π—…•¥†§π…ï¡±Öçî†Ωpºêº∞Äàà§Ï(ÄÅçΩπÕ–Åïπë¡Ω•π–ÄÙÅçΩπô•ù’…ïêÅÒÄ°Õ’¡ÖâÖÕîÄ¸ÅÕ’¡ÖâÖÕîÄ¨ÄàΩô’πç—•ΩπÃΩÿƒΩÖ•ù’≠Ñµë…•Ÿîµ•µÖùîµ¡…Ω·‰àÄËÄàà§Ï(ÄÅ…ï—’…∏Åïπë¡Ω•π–Ä¸Åïπë¡Ω•π–Ä¨Äà˝ô•±ï}•êÙàÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ô•±ï%ê§ÄËÅÕΩ’…çïU…∞Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏ÅÕïπëÖ…Ω’Õï∞°¡Öùï%ê∞Å…ïç•¡•ïπ—%ê∞ÅÖÕÕï—Ã∞ÅÕÖ±’—Ö—•Ω∏ÄÙÅπ’±∞∞Åù…Ω’¡1Öâï∞ÄÙÅπ’±∞§ÅÏ(ÄÅ•òÄ†ÖÖÕÕï—Ãπ±ïπù—†§Å…ï—’…∏Åπ’±∞Ï(ÄÅçΩπÕ–ÅÕ—Ω…ÖùïÕÕï—ÃÄÙÅÖ›Ö•–Å¡…ï¡Ö…ïÖ…Ω’Õï±ÕÕï—Ã°ÖÕÕï—ÃπÕ±•çî†¿∞Äƒ¿§∞ÅÏ(ÄÄÄÅôï—ç°%µ¡∞ËÅôï—ç†∞(ÄÄÄÅ—•µïΩ’—5ÃËÄƒ‘¿¿¿∞(ÄÄÄÅ±ΩΩ≠’¡M—Ω…ÖùïÕÕï—ÃËÅÖÕÂπåÄ°ô•±ï%ëÃ§ÄÙ¯Å≠πΩ›±ïëùî†(ÄÄÄÄÄÄâÿ·}ë…•Ÿï}ÖÕÕï—Ã˝ë…•Ÿï}ô•±ï}•êı•∏∏†àÄ¨Åô•±ï%ëÃπ©Ω•∏†à∞à§Ä¨Äà§ô•Õ}Öç—•Ÿîıïƒπ—…’îô•Õ}•µÖùîıïƒπ—…’îôÕï±ïç–ıë…•Ÿï}ô•±ï}•ê±Õ—Ω…Öùï}’…∞±Õ—Ω…Öùï}Õ—Ö—’Ã±ëï±•Ÿï…Â}’…∞±ëï±•Ÿï…Â}Õ—Ö—’Ãà(ÄÄÄÄ§∞(ÄÅÙ§Ï(ÄÅçΩπÕ–Åï±ïµïπ—ÃÄÙÅÕ—Ω…ÖùïÕÕï—ÃπµÖ¿†°ÖÕÕï–∞Å•πëï‡§ÄÙ¯Ä°Ï(ÄÄÄÅ—•—±îËÅM—…•πú°ÖÕÕï–π—•—±îÅÒÅÅ7ÜÍ≠‘ÄëÌ•πëï‡Ä¨Ä≈ıÄ§πÕ±•çî†¿∞Ä‡¿§∞(ÄÄÄÅ•µÖùï}’…∞ËÅÿƒ¡5ïÕÕïπùï…%µÖùïU…∞°ÖÕÕï–πÕΩ’…çï}’…∞§∞(ÄÄÄÅëïôÖ’±—}Öç—•Ω∏ËÅÏ(ÄÄÄÄÄÅ—Â¡îËÄâ›ïâ}’…∞à∞(ÄÄÄÄÄÅ’…∞ËÅÖÕÕï–πÕΩ’…çï}’…∞∞(ÄÄÄÄÄÅ›ïâŸ•ï›}°ï•ù°—}…Ö—•ºËÄâô’±∞à∞(ÄÄÄÅÙ∞(ÄÄÄÅÕ’â—•—±îËÅù…Ω’¡1Öâï∞Ä¸ÅM—…•πú°ù…Ω’¡1Öâï∞Ä¨ÄàÉ
‹ÄàÄ¨ÅÕ’¡¡Ω…—Ö…Ω’Õï±M’â—•—±î†§§πÕ±•çî†¿∞Ä‡¿§ÄËÅÕ’¡¡Ω…—Ö…Ω’Õï±M’â—•—±î†§∞(ÄÅÙ§§Ï(ÄÅ…ï—’…∏ÅùÖ—ï›Ö‰πÕïπëÖ…Ω’Õï∞°¡Öùï%ê∞Å…ïç•¡•ïπ—%ê∞Åï±ïµïπ—Ã§Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏Å¡Ö—ç°ïç•Õ•Ω∏°ëïç•Õ•Ω∏∞ÅÕ—Ö—’Ã∞Åëï—Ö•±ÃÄÙÅÌÙ§ÅÏ(ÄÅÖ›Ö•–ÅçΩ…î°ÅÿÂ}ëïç•Õ•ΩπÃ˝•êıïƒ∏ëÌëïç•Õ•Ω∏π•ëıÄ∞ÅÏ(ÄÄÄÅµï—°ΩêËÄâAQ à∞(ÄÄÄÅ¡…ïôï»ËÄâ…ï—’…∏ıµ•π•µÖ∞à∞(ÄÄÄÅâΩë‰ËÅÏÅÕ—Ö—’Ã∞ÅΩ’—¡’–ËÅÏÄ∏∏∏°ëïç•Õ•Ω∏πΩ’—¡’–ÅÒÅÌÙ§∞Ä∏∏πëï—Ö•±ÃÅÙ∞Å’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§ÅÙ∞(ÄÅÙ§Ï)Ù(()ô’πç—•Ω∏Åµïë•Öïë’¡ï	’πë±ïÃ°µïë•ÑÄÙÅÌÙ§ÅÏ(ÄÅ•òÄ°……Ö‰π•Õ……Ö‰°µïë•Ñπµïë•Ö}â’πë±ïÃ§ÄòòÅµïë•Ñπµïë•Ö}â’πë±ïÃπ±ïπù—†§Å…ï—’…∏Åµïë•Ñπµïë•Ö}â’πë±ïÃÏ(ÄÅ•òÄ†Ö……Ö‰π•Õ……Ö‰°µïë•ÑπÖÕÕï—Ã§ÅÒÄÖµïë•ÑπÖÕÕï—Ãπ±ïπù—†§Å…ï—’…∏ÅmtÏ(ÄÅ…ï—’…∏ÅmÏ(ÄÄÄÅâ’πë±ï}≠ï‰ËÄâµïë•ÑÈµ•·ïë}çΩµ¡Ö–à∞(ÄÄÄÅù…Ω’¡}≠ï‰ËÄâµ•·ïë}çΩµ¡Ö–à∞(ÄÄÄÅ±Öâï∞ËÄâ7ÜÍ≠‘ÅœÜÍç∏Å¡£ÜÍ•¥à∞(ÄÄÄÅçÖ—Ö±Ωù}≠ïÂÃËÅµïë•ÑπçÖ—Ö±Ωù}≠ïÂÃÅÒÅmt∞(ÄÄÄÅÖÕÕï—ÃËÅµïë•ÑπÖÕÕï—Ã∞(ÄÄÄÅÖÕÕï—}çΩ’π–ËÅµïë•ÑπÖÕÕï—Ãπ±ïπù—†∞(ÄÅıtÏ)Ù()ÖÕÂπåÅô’πç—•Ω∏Å…ïçïπ—ï±•Ÿï…ïë5ïë•ÖMçΩ¡î°ëïç•Õ•Ω∏∞Åù…Ω’¿∞ÅπΩ›5ÃÄÙÅÖ—îππΩ‹†§§ÅÏ(ÄÅçΩπÕ–ÅÕ•πçîÄÙÅπï‹ÅÖ—î°πΩ›5ÃÄ¥Å5%}UA}]%9=]}5L§π—Ω%M=M—…•πú†§Ï(ÄÅçΩπÕ–Å…Ω›ÃÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝Õï±ïç–ı•ê±ëïç•Õ•Ωπ}•ê±•ëïµ¡Ω—ïπçÂ}≠ï‰±ÖÕÕï—}…ïôÃ±Õ—Ö—’Ã±ç…ïÖ—ïë}Ö–±’¡ëÖ—ïë}Ö–à(ÄÄÄÄÄÄ¨Äàô¡Öùï}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏π¡Öùï}•ê§(ÄÄÄÄÄÄ¨ÄàôÕïπëï…}•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ëïç•Õ•Ω∏πÕïπëï…}•ê§(ÄÄÄÄÄÄ¨ÄàôÕ—Ö—’ÃıïƒπÕïπ–à(ÄÄÄÄÄÄ¨Äàô’¡ëÖ—ïë}Ö–ıù—î∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°Õ•πçî§(ÄÄÄÄÄÄ¨ÄàôΩ…ëï»ı’¡ëÖ—ïë}Ö–πëïÕåô±•µ•–Ù–¿à(ÄÄ§Ï(ÄÅôΩ»Ä°çΩπÕ–Å…Ω‹ÅΩòÅ…Ω›ÃÅÒÅmt§ÅÏ(ÄÄÄÅ•òÄ†Öµïë•ÖMçΩ¡ï5Ö—ç°ïÕÕÕï—IïôÃ°ù…Ω’¿∞Å…Ω‹πÖÕÕï—}…ïôÃÅÒÅmt§§ÅçΩπ—•π’îÏ(ÄÄÄÅçΩπÕ–Åëï±•Ÿï…ïë——ïµ¡—ÃÄÙÅÖ›Ö•–ÅÖ——ïµ¡—Ã°…Ω‹π•ê§Ï(ÄÄÄÅçΩπÕ–ÅçÖ…Ω’Õï±Mïπ–ÄÙÄ°ëï±•Ÿï…ïë——ïµ¡—ÃÅÒÅmt§πÕΩµî†°Ö——ïµ¡–§ÄÙ¯(ÄÄÄÄÄÅÖ——ïµ¡–πÕ—Ö—’ÃÄÙÙÙÄâÕïπ–àÄòòÅM—…•πú°Ö——ïµ¡–π—…ÖπÕ¡Ω…–ÅÒÄàà§π•πç±’ëïÃ†âµï—Ö}µïÕÕïπùï…}çÖ…Ω’Õï∞à§(ÄÄÄÄ§Ï(ÄÄÄÅ•òÄ°çÖ…Ω’Õï±Mïπ–§Å…ï—’…∏Å…Ω‹Ï(ÄÅÙ(ÄÅ…ï—’…∏Åπ’±∞Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏Åç±Ö•µ5ïë•ÖMçΩ¡î°ëïç•Õ•Ω∏∞Åù…Ω’¿∞ÅπΩ›5ÃÄÙÅÖ—îππΩ‹†§§ÅÏ(ÄÅçΩπÕ–Å¡°…ÖÕïIï¡ïÖ—Iï≈’ïÕ—ïêÄÙÅÕΩŸï…ï•ùπ=’—âΩ’πëIï¡ïÖ—Iï≈’ïÕ—ïê°ëïç•Õ•Ω∏§Ï(ÄÅçΩπÕ–Åëï±•Ÿï…ïêÄÙÅ¡°…ÖÕïIï¡ïÖ—Iï≈’ïÕ—ïêÄ¸Åπ’±∞ÄËÅÖ›Ö•–Å…ïçïπ—ï±•Ÿï…ïë5ïë•ÖMçΩ¡î°ëïç•Õ•Ω∏∞Åù…Ω’¿∞ÅπΩ›5Ã§Ï(ÄÅçΩπÕ–Åç’Õ—Ωµï…IïÖÕ≠ïëô—ï…ï±•Ÿï…‰ÄÙÅ	ΩΩ±ïÖ∏°ëï±•Ÿï…ïê§ÄòòÅµïë•ÖIï≈’ïÕ—ïëô—ï…ï±•Ÿï…‰†(ÄÄÄÅëïç•Õ•Ω∏¸π•π¡’—}ÕπÖ¡Õ°Ω–¸πçΩπŸï…ÕÖ—•Ω∏¸πµïÕÕÖùïÃÅÒÅmt∞(ÄÄÄÅëï±•Ÿï…ïêπ’¡ëÖ—ïë}Ö–ÅÒÅëï±•Ÿï…ïêπç…ïÖ—ïë}Ö–∞(ÄÄÄÅÏÅëïç•Õ•Ωπç—•Ω∏ËÅëïç•Õ•Ω∏πÖç—•Ω∏ÅÙ∞(ÄÄ§Ï(ÄÅçΩπÕ–Å…ï¡ïÖ—Iï≈’ïÕ—ïêÄÙÅ¡°…ÖÕïIï¡ïÖ—Iï≈’ïÕ—ïêÅÒÅç’Õ—Ωµï…IïÖÕ≠ïëô—ï…ï±•Ÿï…‰Ï(ÄÅçΩπÕ–Å•ëïµ¡Ω—ïπçÂ-ï‰ÄÙÅµïë•ÖMçΩ¡ï%ëïµ¡Ω—ïπçÂ-ï‰°Ï(ÄÄÄÅ¡Öùï%êËÅëïç•Õ•Ω∏π¡Öùï}•ê∞(ÄÄÄÅÕïπëï…%êËÅëïç•Õ•Ω∏πÕïπëï…}•ê∞(ÄÄÄÅù…Ω’¿∞(ÄÄÄÅëïç•Õ•Ωπ%êËÅëïç•Õ•Ω∏π•ê∞(ÄÄÄÅ…ï¡ïÖ—Iï≈’ïÕ—ïê∞(ÄÅÙ§Ï(ÄÅçΩπÕ–ÅπΩ‹ÄÙÅπï‹ÅÖ—î°πΩ›5Ã§π—Ω%M=M—…•πú†§Ï((ÄÅ•òÄ†Ö…ï¡ïÖ—Iï≈’ïÕ—ïêÄòòÅëï±•Ÿï…ïê§ÅÏ(ÄÄÄÄÄÅçΩπÕ–ÅµïµΩ…•Ö∞ÄÙÅÖ›Ö•–ÅçΩ…î†âÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝Ωπ}çΩπô±•ç–ı•ëïµ¡Ω—ïπçÂ}≠ï‰à∞ÅÏ(ÄÄÄÄÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÄÄÄÄÅ¡…ïôï»ËÄâ…ïÕΩ±’—•Ω∏ı•ùπΩ…îµë’¡±•çÖ—ïÃ±…ï—’…∏ı…ï¡…ïÕïπ—Ö—•Ω∏à∞(ÄÄÄÄÄÄÄÅâΩë‰ËÅÏ(ÄÄÄÄÄÄÄÄÄÅëïç•Õ•Ωπ}•êËÅëï±•Ÿï…ïêπëïç•Õ•Ωπ}•êÅÒÅëïç•Õ•Ω∏π•ê∞(ÄÄÄÄÄÄÄÄÄÅ¡Öùï}•êËÅëïç•Õ•Ω∏π¡Öùï}•ê∞(ÄÄÄÄÄÄÄÄÄÅÕïπëï…}•êËÅëïç•Õ•Ω∏πÕïπëï…}•ê∞(ÄÄÄÄÄÄÄÄÄÅ—ï·—}âΩë‰ËÅπ’±∞∞(ÄÄÄÄÄÄÄÄÄÅÖÕÕï—}…ïôÃËÅù…Ω’¿πÖÕÕï—ÃÅÒÅmt∞(ÄÄÄÄÄÄÄÄÄÅÕ—Ö—’ÃËÄâÕïπ–à∞(ÄÄÄÄÄÄÄÄÄÅ•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰∞(ÄÄÄÄÄÄÄÄÄÅ’¡ëÖ—ïë}Ö–ËÅëï±•Ÿï…ïêπ’¡ëÖ—ïë}Ö–ÅÒÅëï±•Ÿï…ïêπç…ïÖ—ïë}Ö–ÅÒÅπΩ‹∞(ÄÄÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÄÄÅÖ±±Ω›ïêËÅôÖ±Õî∞(ÄÄÄÄÄÄÄÅ…ïÖÕΩ∏ËÄâUA1%Q}5%}M=A|»— à∞(ÄÄÄÄÄÄÄÅâ’πë±îËÅµïµΩ…•Ö∞¸πl¡tÅÒÅëï±•Ÿï…ïê∞(ÄÄÄÄÄÄÄÅë’¡±•çÖ—ï}â’πë±ï}•êËÅëï±•Ÿï…ïêπ•ê∞(ÄÄÄÄÄÄÄÅ•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰∞(ÄÄÄÄÄÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Å•πÕï…—ïêÄÙÅÖ›Ö•–ÅçΩ…î†âÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝Ωπ}çΩπô±•ç–ı•ëïµ¡Ω—ïπçÂ}≠ï‰à∞ÅÏ(ÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÅ¡…ïôï»ËÄâ…ïÕΩ±’—•Ω∏ı•ùπΩ…îµë’¡±•çÖ—ïÃ±…ï—’…∏ı…ï¡…ïÕïπ—Ö—•Ω∏à∞(ÄÄÄÅâΩë‰ËÅÏ(ÄÄÄÄÄÅëïç•Õ•Ωπ}•êËÅëïç•Õ•Ω∏π•ê∞(ÄÄÄÄÄÅ¡Öùï}•êËÅëïç•Õ•Ω∏π¡Öùï}•ê∞(ÄÄÄÄÄÅÕïπëï…}•êËÅëïç•Õ•Ω∏πÕïπëï…}•ê∞(ÄÄÄÄÄÅ—ï·—}âΩë‰ËÅπ’±∞∞(ÄÄÄÄÄÅÖÕÕï—}…ïôÃËÅù…Ω’¿πÖÕÕï—ÃÅÒÅmt∞(ÄÄÄÄÄÅÕ—Ö—’ÃËÄâÕ—Öùïêà∞(ÄÄÄÄÄÅ•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰∞(ÄÄÄÄÄÅ’¡ëÖ—ïë}Ö–ËÅπΩ‹∞(ÄÄÄÅÙ∞(ÄÅÙ§Ï(ÄÅ•òÄ°•πÕï…—ïê¸πl¡t§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÅÖ±±Ω›ïêËÅ—…’î∞(ÄÄÄÄÄÅ…ïÖÕΩ∏ËÅç’Õ—Ωµï…IïÖÕ≠ïëô—ï…ï±•Ÿï…‰(ÄÄÄÄÄÄÄÄ¸ÄâUMQ=5I}5%}IM-}QI}1%YIdà(ÄÄÄÄÄÄÄÄËÄ°…ï¡ïÖ—Iï≈’ïÕ—ïêÄ¸ÄâaA1%%Q}IAQ}IEUMPàÄËÄâ9]}5%}M=Aà§∞(ÄÄÄÄÄÅâ’πë±îËÅ•πÕï…—ïël¡t∞(ÄÄÄÄÄÅ•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰∞(ÄÄÄÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Å…Ω›ÃÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝Õï±ïç–ı•ê±ëïç•Õ•Ωπ}•ê±Õ—Ö—’Ã±•ëïµ¡Ω—ïπçÂ}≠ï‰±ÖÕÕï—}…ïôÃ±ç…ïÖ—ïë}Ö–±’¡ëÖ—ïë}Ö–à(ÄÄÄÄÄÄ¨Äàô•ëïµ¡Ω—ïπçÂ}≠ï‰ıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°•ëïµ¡Ω—ïπçÂ-ï‰§(ÄÄÄÄÄÄ¨Äàô±•µ•–Ùƒà(ÄÄ§Ï(ÄÅçΩπÕ–Åï·•Õ—•πúÄÙÅ…Ω›Ã¸πl¡tÅÒÅπ’±∞Ï(ÄÅçΩπÕ–Åë•Õ¡ΩÕ•—•Ω∏ÄÙÅµïë•Ö±Ö•µ•Õ¡ΩÕ•—•Ω∏°ï·•Õ—•πú∞ÅÏÅëïç•Õ•Ωπ%êËÅëïç•Õ•Ω∏π•ê∞ÅπΩ›5ÃÅÙ§Ï(ÄÅ•òÄ†Öë•Õ¡ΩÕ•—•Ω∏πÖ±±Ω›ïê§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏÄ∏∏πë•Õ¡ΩÕ•—•Ω∏∞Åâ’πë±îËÅï·•Õ—•πú∞Å•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰∞Åë’¡±•çÖ—ï}â’πë±ï}•êËÅï·•Õ—•πú¸π•êÅÒÅπ’±∞ÅÙÏ(ÄÅÙ(ÄÅ•òÄ†Öë•Õ¡ΩÕ•—•Ω∏π—Ö≠ïΩŸï»§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏÄ∏∏πë•Õ¡ΩÕ•—•Ω∏∞Åâ’πë±îËÅï·•Õ—•πú∞Å•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰ÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Å…ïçΩŸï…ïêÄÙÅÖ›Ö•–ÅçΩ…î†(ÄÄÄÄâÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ï·•Õ—•πúπ•ê§(ÄÄÄÄÄÄ¨ÄàôÕ—Ö—’Ãıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ï·•Õ—•πúπÕ—Ö—’Ã§(ÄÄÄÄÄÄ¨Äàô’¡ëÖ—ïë}Ö–ıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°ï·•Õ—•πúπ’¡ëÖ—ïë}Ö–§∞(ÄÄÄÅÏ(ÄÄÄÄÄÅµï—°ΩêËÄâAQ à∞(ÄÄÄÄÄÅ¡…ïôï»ËÄâ…ï—’…∏ı…ï¡…ïÕïπ—Ö—•Ω∏à∞(ÄÄÄÄÄÅâΩë‰ËÅÏ(ÄÄÄÄÄÄÄÅëïç•Õ•Ωπ}•êËÅëïç•Õ•Ω∏π•ê∞(ÄÄÄÄÄÄÄÅÖÕÕï—}…ïôÃËÅù…Ω’¿πÖÕÕï—ÃÅÒÅmt∞(ÄÄÄÄÄÄÄÅÕ—Ö—’ÃËÄâÕ—Öùïêà∞(ÄÄÄÄÄÄÄÅ’¡ëÖ—ïë}Ö–ËÅπΩ‹∞(ÄÄÄÄÄÅÙ∞(ÄÄÄÅÙ∞(ÄÄ§Ï(ÄÅ•òÄ°…ïçΩŸï…ïê¸πl¡t§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅ—…’î∞Å…ïÖÕΩ∏ËÅë•Õ¡ΩÕ•—•Ω∏π…ïÖÕΩ∏∞Åâ’πë±îËÅ…ïçΩŸï…ïël¡t∞Å•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰ÅÙÏ(ÄÅÙ(ÄÅ…ï—’…∏ÅÏÅÖ±±Ω›ïêËÅôÖ±Õî∞Å…ïÖÕΩ∏ËÄâ5%}M=A}1%5}I}1=MPà∞Åâ’πë±îËÅï·•Õ—•πú∞Å•ëïµ¡Ω—ïπçÂ}≠ï‰ËÅ•ëïµ¡Ω—ïπçÂ-ï‰ÅÙÏ)Ù()ÖÕÂπåÅô’πç—•Ω∏Å¡…ï¡Ö…ï5ïë•Öïë’¡î°ëïç•Õ•Ω∏∞Åµïë•Ñ§ÅÏ(ÄÅçΩπÕ–Åù…Ω’¡ÃÄÙÅµïë•Öïë’¡ï	’πë±ïÃ°µïë•Ñ§Ï(ÄÅçΩπÕ–Åç±Ö•µÃÄÙÅmtÏ(ÄÅôΩ»Ä°çΩπÕ–Åù…Ω’¿ÅΩòÅù…Ω’¡Ã§Åç±Ö•µÃπ¡’Õ†°ÏÅù…Ω’¿∞Ä∏∏∏°Ö›Ö•–Åç±Ö•µ5ïë•ÖMçΩ¡î°ëïç•Õ•Ω∏∞Åù…Ω’¿§§ÅÙ§Ï(ÄÅ…ï—’…∏ÅÏ(ÄÄÄÅù…Ω’¡Ã∞(ÄÄÄÅç±Ö•µÃ∞(ÄÄÄÅâÂ}â’πë±ï}≠ï‰ËÅπï‹Å5Ö¿°ç±Ö•µÃπµÖ¿†°ç±Ö•¥§ÄÙ¯ÅmM—…•πú°ç±Ö•¥πù…Ω’¿πâ’πë±ï}≠ï‰ÅÒÅç±Ö•¥πù…Ω’¿πù…Ω’¡}≠ï‰ÅÒÄàà§∞Åç±Ö•µt§§∞(ÄÄÄÅÖ±±Ω›ïë}çΩ’π–ËÅç±Ö•µÃπô•±—ï»†°ç±Ö•¥§ÄÙ¯Åç±Ö•¥πÖ±±Ω›ïê§π±ïπù—†∞(ÄÄÄÅÕ’¡¡…ïÕÕïë}çΩ’π–ËÅç±Ö•µÃπô•±—ï»†°ç±Ö•¥§ÄÙ¯ÄÖç±Ö•¥πÖ±±Ω›ïê§π±ïπù—†∞(ÄÅÙÏ)Ù((ººÅ%U-}Xƒ¡}5%}M=A}UA}Xƒ()ÖÕÂπåÅô’πç—•Ω∏Å¡…ΩçïÕÕïç•Õ•Ω∏°ëïç•Õ•Ω∏∞ÅçΩπô•ú§ÅÏ(ÄÅçΩπÕ–ÅùÖ—îÄÙÅÖ›Ö•–Åô•πÖ±Ö—î°ëïç•Õ•Ω∏∞ÅçΩπô•ú§Ï(ÄÅ•òÄ†ÖùÖ—îπÖ±±Ω›ïêÄòòÅùÖ—îπ…ï—…ÂÖâ±î§ÅÏ(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄ¿∞ÅôÖ•±ïêËÄ¿∞Å…ï—…ÂÖâ±îËÄƒÅÙÏ(ÄÅÙ(ÄÅ•òÄ†ÖùÖ—îπÖ±±Ω›ïê§ÅÏ(ÄÄÄÅ•òÄ°ùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰§ÅÖ›Ö•–Å¡ï…Õ•Õ—=âÕï…ŸïëAÖùïIï¡±‰°ëïç•Õ•Ω∏∞ÅùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÅçΩπÕ–Åç±Ö•µïêÄÙÅÖ›Ö•–Åç±Ö•¥°ëïç•Õ•Ω∏§Ï(ÄÄÄÅ•òÄ°ç±Ö•µïê§ÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Äâ±•Ÿï}Õ’¡¡…ïÕÕïêà∞ÅÏÅÕ°Ω’±ë}ÕïπêËÅôÖ±Õî∞Å—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅ—…’î∞Å±•Ÿï}Õ’¡¡…ïÕÕ•Ωπ}…ïÖÕΩ∏ËÅùÖ—îπ…ïÖÕΩ∏∞Åµï…ùï}©Ωâ}ïπÕ’…ïêËÅ	ΩΩ±ïÖ∏°ùÖ—îπµï…ùî¸πïπÕ’…ïê§∞Åµï…ùï}ÕΩ’…çï}ïŸïπ—}•êËÅùÖ—îπµï…ùî¸πÕΩ’…çï}ïŸïπ—}•êÅÒÅπ’±∞∞Åµï…ùï}©Ωâ}•êËÅùÖ—îπµï…ùî¸π©Ωâ}•êÅÒÅπ’±∞∞Å±•Ÿï}¡Öùï}…ï¡±Â}ÕΩ’…çîËÅùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰¸πÕΩ’…çï}ÕÂÕ—ï¥ÅÒÅπ’±∞∞Å±•Ÿï}¡Öùï}…ï¡±Â}Ö–ËÅùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰¸πÕïπ—}Ö–ÅÒÅπ’±∞∞Å±•Ÿï}¡Öùï}…ï¡±Â}Öç—Ω…}πÖµîËÅùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰¸πÖç—Ω…}πÖµîÅÒÅπ’±∞∞Å±•Ÿï}¡Öùï}…ï¡±Â}Öç—Ω…}Ö¡¡}•êËÅùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰¸πÖç—Ω…}Ö¡¡}•êÅÒÅπ’±∞∞Å±•Ÿï}¡Öùï}…ï¡±Â}—ï·–ËÅùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰¸πµïÕÕÖùï}—ï·–ÅÒÅπ’±∞∞Å±•Ÿï}¡Öùï}…ï¡±Â}ïŸ•ëïπçîËÅùÖ—îπ±•Ÿï}¡Öùï}…ï¡±‰¸πïŸ•ëïπçîÅÒÅπ’±∞ÅÙ§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄƒ∞ÅôÖ•±ïêËÄ¿ÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Åç±Ö•µïêÄÙÅÖ›Ö•–Åç±Ö•¥°ëïç•Õ•Ω∏§Ï(ÄÅ•òÄ†Öç±Ö•µïê§Å…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄ¿∞ÅôÖ•±ïêËÄ¿ÅÙÏ((ÄÅ±ï–Åµïë•ÑÄÙÅÏÅÖÕÕï—ÃËÅmt∞ÅçÖ—Ö±Ωù}≠ïÂÃËÅmtÅÙÏ(ÄÅ±ï–Åµïë•Ö]Ö…π•πúÄÙÅπ’±∞Ï(ÄÅ—…‰ÅÏ(ÄÄÄÅµïë•ÑÄÙÅùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰(ÄÄÄÄÄÄ¸ÅÏÅÖÕÕï—ÃËÅmt∞ÅçÖ—Ö±Ωù}≠ïÂÃËÅmt∞Å…ï≈’ïÕ—ïë}çÖ—Ö±Ωù}≠ïÂÃËÅmt∞Åµ•ÕÕ•πù}çÖ—Ö±Ωù}≠ïÂÃËÅmt∞Åµïë•Ö}â’πë±ïÃËÅmtÅÙ(ÄÄÄÄÄÄËÅÖ›Ö•–Å…ïÕΩ±ŸïÕÕï—Ã°ç±Ö•µïê§Ï(ÄÄÄÅ•òÄ†ÖùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰ÄòòÄ°ç±Ö•µïêπΩ’—¡’–¸ππïïëÕ}Õ±•ëïÃÅÒÅç±Ö•µïêπÖç—•Ω∏ÄÙÙÙÄâ…ï¡±Â}›•—°}Õ±•ëïÃà§ÄòòÄÖµïë•ÑπÖÕÕï—Ãπ±ïπù—†§Åµïë•Ö]Ö…π•πúÄÙÄâ9=}AU	1%M!}MMQ}5Q àÏ(ÄÄÄÅ•òÄ°……Ö‰π•Õ……Ö‰°µïë•Ñπµ•ÕÕ•πù}çÖ—Ö±Ωù}≠ïÂÃ§ÄòòÅµïë•Ñπµ•ÕÕ•πù}çÖ—Ö±Ωù}≠ïÂÃπ±ïπù—†§ÅÏ(ÄÄÄÄÄÅµïë•Ö]Ö…π•πúÄÙÄâ5%}M=A}%9=5A1QËàÄ¨Åµïë•Ñπµ•ÕÕ•πù}çÖ—Ö±Ωù}≠ïÂÃπ©Ω•∏†à∞à§Ï(ÄÄÄÅÙ(ÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÅµïë•Ö]Ö…π•πúÄÙÅM—…•πú°ï……Ω»¸πµïÕÕÖùîÅÒÅï……Ω»§πÕ±•çî†¿∞Ä‘¿¿§Ï(ÄÅÙ((ÄÅ•òÄ†ÖùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰ÄòòÅùÖ—îπÕ’¡¡Ω…—5ΩëîÄòòÅùÖ—îπÕ’¡¡Ω…—M±•ëï±•ù•â±îÄòòÄÖµïë•ÑπÖÕÕï—Ãπ±ïπù—†§ÅÏ(ÄÄÄÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Äâ±•Ÿï}Õ’¡¡…ïÕÕïêà∞ÅÏ(ÄÄÄÄÄÅÕ°Ω’±ë}ÕïπêËÅôÖ±Õî∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅ—…’î∞(ÄÄÄÄÄÅ±•Ÿï}Õ’¡¡…ïÕÕ•Ωπ}…ïÖÕΩ∏ËÄâMUAA=IQ}9=}AU	1%M!}MMPà∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}µΩëîËÅ—…’î∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}¡…•µÖ…Â}âΩ–ËÄâ%-à∞(ÄÄÄÅÙ§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄƒ∞ÅôÖ•±ïêËÄ¿ÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Åëï±•Ÿï…ÂQï·–ÄÙÅùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰(ÄÄÄÄ¸ÅùÖ—îπ—ï·–(ÄÄÄÄËÅùÖ—îπÕ’¡¡Ω…—5Ωëî(ÄÄÄÄ¸Ä°ùÖ—îπÕ’¡¡Ω…—M±•ëï±•ù•â±îÄ¸ÅÕ’¡¡Ω…—M±•ëïÖ¡—•Ω∏°ùÖ—î∞Åç±Ö•µïê§ÄËÄ°ùÖ—îπÕ’¡¡Ω…—Qï·—Ö±±âÖç≠±•ù•â±îÄ¸ÅùÖ—îπ—ï·–ÄËÅÕ’¡¡Ω…—Ωµ¡Öç—%µÖùïIï¡±‰°ùÖ—î§§§(ÄÄÄÄËÅùÖ—îπ—ï·–Ï(ÄÅ•òÄ†Öëï±•Ÿï…ÂQï·–§ÅÏ(ÄÄÄÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Äâ±•Ÿï}Õ’¡¡…ïÕÕïêà∞ÅÏ(ÄÄÄÄÄÅÕ°Ω’±ë}ÕïπêËÅôÖ±Õî∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅ—…’î∞(ÄÄÄÄÄÅ±•Ÿï}Õ’¡¡…ïÕÕ•Ωπ}…ïÖÕΩ∏ËÄâMUAA=IQ}9=}UMU1}QaPà∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}µΩëîËÅ	ΩΩ±ïÖ∏°ùÖ—îπÕ’¡¡Ω…—5Ωëî§∞(ÄÄÄÅÙ§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄƒ∞ÅôÖ•±ïêËÄ¿ÅÙÏ(ÄÅÙ((ÄÅ±ï–Åµïë•Öïë’¡îÏ(ÄÅ—…‰ÅÏ(ÄÄÄÅµïë•Öïë’¡îÄÙÅÖ›Ö•–Å¡…ï¡Ö…ï5ïë•Öïë’¡î°ç±Ö•µïê∞Åµïë•Ñ§Ï(ÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Äâ±•Ÿï}ëï±•Ÿï…Â}ôÖ•±ïêà∞ÅÏ(ÄÄÄÄÄÅÕ°Ω’±ë}ÕïπêËÅ—…’î∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅôÖ±Õî∞(ÄÄÄÄÄÅ±•Ÿï}ëï±•Ÿï…Â}ï……Ω»ËÄâ5%}UA}1%5}%1ËàÄ¨ÅM—…•πú°ï……Ω»¸πµïÕÕÖùîÅÒÅï……Ω»§πÕ±•çî†¿∞Ä‹¿¿§∞(ÄÄÄÄÄÅµïë•Ö}ëïë’¡ï}ôÖ•±}ç±ΩÕïêËÅ—…’î∞(ÄÄÄÅÙ§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄ¿∞ÅôÖ•±ïêËÄƒÅÙÏ(ÄÅÙ((ÄÅ•òÄ†ÖùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰ÄòòÅùÖ—îπÕ’¡¡Ω…—5ΩëîÄòòÅùÖ—îπÕ’¡¡Ω…—M±•ëï±•ù•â±îÄòòÅµïë•Öïë’¡îπù…Ω’¡Ãπ±ïπù—†ÄòòÅµïë•Öïë’¡îπÖ±±Ω›ïë}çΩ’π–ÄÙÙÙÄ¿§ÅÏ(ÄÄÄÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Äâ±•Ÿï}Õ’¡¡…ïÕÕïêà∞ÅÏ(ÄÄÄÄÄÅÕ°Ω’±ë}ÕïπêËÅôÖ±Õî∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅ—…’î∞(ÄÄÄÄÄÅ±•Ÿï}Õ’¡¡…ïÕÕ•Ωπ}…ïÖÕΩ∏ËÄâUA1%Q}5%}M=A|»— à∞(ÄÄÄÄÄÅµïë•Ö}ëïë’¡ï}›•πëΩ›}°Ω’…ÃËÄ»–∞(ÄÄÄÄÄÅµïë•Ö}ëïë’¡ï}ç±Ö•µÃËÅµïë•Öïë’¡îπç±Ö•µÃπµÖ¿†°•—ï¥§ÄÙ¯Ä°Ï(ÄÄÄÄÄÄÄÅâ’πë±ï}≠ï‰ËÅ•—ï¥πù…Ω’¿πâ’πë±ï}≠ï‰∞(ÄÄÄÄÄÄÄÅçÖ—Ö±Ωù}≠ïÂÃËÅ•—ï¥πù…Ω’¿πçÖ—Ö±Ωù}≠ïÂÃÅÒÅmt∞(ÄÄÄÄÄÄÄÅ…ïÖÕΩ∏ËÅ•—ï¥π…ïÖÕΩ∏∞(ÄÄÄÄÄÄÄÅë’¡±•çÖ—ï}â’πë±ï}•êËÅ•—ï¥πë’¡±•çÖ—ï}â’πë±ï}•êÅÒÅ•—ï¥πâ’πë±î¸π•êÅÒÅπ’±∞∞(ÄÄÄÄÄÅÙ§§∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}µΩëîËÅ—…’î∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}¡…•µÖ…Â}âΩ–ËÄâ%-à∞(ÄÄÄÅÙ§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄƒ∞ÅôÖ•±ïêËÄ¿ÅÙÏ(ÄÅÙ((ÄÅçΩπÕ–Åâ’πë±îÄÙÅÖ›Ö•–Åâ’πë±ïΩ»°ç±Ö•µïê∞Åëï±•Ÿï…ÂQï·–∞Åµïë•ÑπÖÕÕï—Ã§Ï(ÄÅçΩπÕ–Åï·•Õ—•πúÄÙÅÖ›Ö•–ÅÖ——ïµ¡—Ã°â’πë±îπ•ê§Ï(ÄÅ±ï–Åπï·———ïµ¡–ÄÙÅ5Ö—†πµÖ‡†¿∞Ä∏∏∏°ï·•Õ—•πúÅÒÅmt§πµÖ¿†°•—ï¥§ÄÙ¯Å9’µâï»°•—ï¥πÖ——ïµ¡—}πºÅÒÄ¿§§§Ä¨ÄƒÏ(ÄÅçΩπÕ–Å—ï·—Q…ÖπÕ¡Ω…–ÄÙÅùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰Ä¸Äâµï—Ö}çΩµµïπ—}¡…•ŸÖ—ï}…ï¡±‰àÄËÄâµï—Ö}µïÕÕïπùï…}—ï·–àÏ(ÄÅçΩπÕ–Å—ï·—±…ïÖëÂMïπ–ÄÙÄ°ï·•Õ—•πúÅÒÅmt§πÕΩµî†°•—ï¥§ÄÙ¯Å•—ï¥π—…ÖπÕ¡Ω…–ÄÙÙÙÅ—ï·—Q…ÖπÕ¡Ω…–ÄòòÅ•—ï¥πÕ—Ö—’ÃÄÙÙÙÄâÕïπ–à§Ï(ÄÅçΩπÕ–Åë•Õ¡Ö—ç°-ï‰ÄÙÅÅ±•ŸîËëÌç±Ö•µïêπ•ëıÄÏ(ÄÅçΩπÕ–Åë•Õ¡Ö—ç°1ïÖÕîÄÙÅÖ›Ö•–ÅùÖ—ï›Ö‰πç±Ö•µ•Õ¡Ö—ç†°Ï(ÄÄÄÅ¡Öùï%êËÅç±Ö•µïêπ¡Öùï}•ê∞(ÄÄÄÅÕïπëï…%êËÅç±Ö•µïêπÕïπëï…}•ê∞(ÄÄÄÅΩ›πï»ËÅ%MAQ!}=]9ILπ1%Y∞(ÄÄÄÅëïë’¡ï-ï‰ËÅë•Õ¡Ö—ç°-ï‰∞(ÄÄÄÅ¡…•Ω…•—‰ËÄƒ¿¿∞(ÄÄÄÅ±ïÖÕïMïçΩπëÃËÄƒ»¿∞(ÄÅÙ§Ï(ÄÅ•òÄ†Öë•Õ¡Ö—ç°1ïÖÕî¸πù…Öπ—ïê§ÅÏ(ÄÄÄÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Äâ±•Ÿï}ëï±•Ÿï…Â}ôÖ•±ïêà∞ÅÏ(ÄÄÄÄÄÅÕ°Ω’±ë}ÕïπêËÅ—…’î∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅôÖ±Õî∞(ÄÄÄÄÄÅ±•Ÿï}ëï±•Ÿï…Â}ï……Ω»ËÅÅ%MAQ!}1M}	UMdËëÌë•Õ¡Ö—ç°1ïÖÕî¸πç’……ïπ—}Ω›πï»ÅÒÄâ’π≠πΩ›∏âıÄ∞(ÄÄÄÄÄÅë•Õ¡Ö—ç°}±ïÖÕï}Ω›πï»ËÅë•Õ¡Ö—ç°1ïÖÕî¸πç’……ïπ—}Ω›πï»ÅÒÅπ’±∞∞(ÄÄÄÄÄÅë•Õ¡Ö—ç°}…ï—…ÂÖâ±îËÅ—…’î∞(ÄÄÄÅÙ§Ï(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄ¿∞ÅôÖ•±ïêËÄ¿∞Å…ï—…ÂÖâ±îËÄƒÅÙÏ(ÄÅÙ(ÄÅ±ï–Åë•Õ¡Ö—ç°IïÕ’±–ÄÙÄâôÖ•±ïêàÏ((ÄÅ—…‰ÅÏ(ÄÄÄÅ±ï–Å—ï·—IïÕ’±–ÄÙÅπ’±∞Ï(ÄÄÄÅ•òÄ†Ö—ï·—±…ïÖëÂMïπ–§ÅÏ(ÄÄÄÄÄÅ—ï·—IïÕ’±–ÄÙÅùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰(ÄÄÄÄÄÄÄÄ¸ÅÖ›Ö•–ÅùÖ—ï›Ö‰πÕïπëA…•ŸÖ—ïΩµµïπ—Iï¡±‰°ç±Ö•µïêπ¡Öùï}•ê∞ÅùÖ—îπçΩµµïπ—Ωπ—ï·–πçΩµµïπ—%ê∞Åëï±•Ÿï…ÂQï·–§(ÄÄÄÄÄÄÄÄËÅÖ›Ö•–ÅùÖ—ï›Ö‰πÕïπëQï·–°ç±Ö•µïêπ¡Öùï}•ê∞Åç±Ö•µïêπÕïπëï…}•ê∞Åëï±•Ÿï…ÂQï·–§Ï(ÄÄÄÄÄÅÖ›Ö•–Å…ïçΩ…ë——ïµ¡–°â’πë±îπ•ê∞Åπï·———ïµ¡–¨¨∞Å—ï·—Q…ÖπÕ¡Ω…–∞ÄâÕïπ–à∞Å—ï·—IïÕ’±–§Ï(ÄÄÄÅÙ((ÄÄÄÅçΩπÕ–Åµïë•Ö	’πë±ïÃÄÙÅùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰(ÄÄÄÄÄÄ¸Åmt(ÄÄÄÄÄÄËÅ……Ö‰π•Õ……Ö‰°µïë•Ñπµïë•Ö}â’πë±ïÃ§ÄòòÅµïë•Ñπµïë•Ö}â’πë±ïÃπ±ïπù—†(ÄÄÄÄÄÄ¸Åµïë•Ñπµïë•Ö}â’πë±ïÃ(ÄÄÄÄÄÄËÄ°µïë•ÑπÖÕÕï—Ãπ±ïπù—†Ä¸ÅmÏ(ÄÄÄÄÄÄÄÄÄÅâ’πë±ï}≠ï‰ËÄâµïë•ÑÈµ•·ïë}çΩµ¡Ö–à∞(ÄÄÄÄÄÄÄÄÄÅù…Ω’¡}≠ï‰ËÄâµ•·ïë}çΩµ¡Ö–à∞(ÄÄÄÄÄÄÄÄÄÅ±Öâï∞ËÄâ7ÜÍ≠‘ÅœÜÍç∏Å¡£ÜÍ•¥à∞(ÄÄÄÄÄÄÄÄÄÅçÖ—Ö±Ωù}≠ïÂÃËÅµïë•ÑπçÖ—Ö±Ωù}≠ïÂÃÅÒÅmt∞(ÄÄÄÄÄÄÄÄÄÅÖÕÕï—ÃËÅµïë•ÑπÖÕÕï—Ã∞(ÄÄÄÄÄÄÄÄÄÅÖÕÕï—}çΩ’π–ËÅµïë•ÑπÖÕÕï—Ãπ±ïπù—†∞(ÄÄÄÄÄÄÄÅıtÄËÅmt§Ï((ÄÄÄÅôΩ»Ä°çΩπÕ–Åù…Ω’¿ÅΩòÅµïë•Ö	’πë±ïÃ§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Åç±Ö•µ-ï‰ÄÙÅM—…•πú°ù…Ω’¿πâ’πë±ï}≠ï‰ÅÒÅù…Ω’¿πù…Ω’¡}≠ï‰ÅÒÄàà§Ï(ÄÄÄÄÄÅçΩπÕ–Åµïë•Ö±Ö•¥ÄÙÅµïë•Öïë’¡îπâÂ}â’πë±ï}≠ï‰πùï–°ç±Ö•µ-ï‰§Ï(ÄÄÄÄÄÅ•òÄ†Öµïë•Ö±Ö•¥¸πÖ±±Ω›ïêÅÒÄÖµïë•Ö±Ö•¥πâ’πë±î¸π•ê§ÅçΩπ—•π’îÏ((ÄÄÄÄÄÅçΩπÕ–Åµïë•Ö·•Õ—•πúÄÙÅÖ›Ö•–ÅÖ——ïµ¡—Ã°µïë•Ö±Ö•¥πâ’πë±îπ•ê§Ï(ÄÄÄÄÄÅ±ï–Åµïë•Ö——ïµ¡—9ºÄÙÅ5Ö—†πµÖ‡†¿∞Ä∏∏∏°µïë•Ö·•Õ—•πúÅÒÅmt§πµÖ¿†°•—ï¥§ÄÙ¯Å9’µâï»°•—ï¥πÖ——ïµ¡—}πºÅÒÄ¿§§§Ä¨ÄƒÏ(ÄÄÄÄÄÅ±ï–Åµïë•Ö…Ω’¡Ö•±ïêÄÙÅôÖ±ÕîÏ(ÄÄÄÄÄÅçΩπÕ–ÅâÖ—ç°ïÃÄÙÅmtÏ(ÄÄÄÄÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÄ¿ÏÅ•πëï‡ÄÅù…Ω’¿πÖÕÕï—Ãπ±ïπù—†ÏÅ•πëï‡Ä¨ÙÄƒ¿§ÅâÖ—ç°ïÃπ¡’Õ†°ù…Ω’¿πÖÕÕï—ÃπÕ±•çî°•πëï‡∞Å•πëï‡Ä¨Äƒ¿§§Ï(ÄÄÄÄÄÅçΩπÕ–ÅÕÖôï…Ω’¿ÄÙÅM—…•πú°ù…Ω’¿πù…Ω’¡}≠ï‰ÅÒÄâ¡…Ωë’ç–à§π—Ω1Ω›ï…ÖÕî†§π…ï¡±Öçî†ΩmyÑµË¿¥Â}t¨Ωú∞Äâ|à§π…ï¡±Öçî†Ωy|≠Ò|¨êΩú∞Äàà§ÅÒÄâ¡…Ωë’ç–àÏ(ÄÄÄÄÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÄ¿ÏÅ•πëï‡ÄÅâÖ—ç°ïÃπ±ïπù—†ÏÅ•πëï‡Ä¨ÙÄƒ§ÅÏ(ÄÄÄÄÄÄÄÅçΩπÕ–Å—…ÖπÕ¡Ω…–ÄÙÄâµï—Ö}µïÕÕïπùï…}çÖ…Ω’Õï±|àÄ¨ÅÕÖôï…Ω’¿Ä¨Äâ|àÄ¨ÅM—…•πú°•πëï‡Ä¨Äƒ§Ï(ÄÄÄÄÄÄÄÅçΩπÕ–ÅÖ±…ïÖëÂMïπ–ÄÙÄ°µïë•Ö·•Õ—•πúÅÒÅmt§πÕΩµî†°•—ï¥§ÄÙ¯Å•—ï¥π—…ÖπÕ¡Ω…–ÄÙÙÙÅ—…ÖπÕ¡Ω…–ÄòòÅ•—ï¥πÕ—Ö—’ÃÄÙÙÙÄâÕïπ–à§Ï(ÄÄÄÄÄÄÄÅ•òÄ°Ö±…ïÖëÂMïπ–§ÅçΩπ—•π’îÏ(ÄÄÄÄÄÄÄÅ—…‰ÅÏ(ÄÄÄÄÄÄÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–ÅÕïπëÖ…Ω’Õï∞°ç±Ö•µïêπ¡Öùï}•ê∞Åç±Ö•µïêπÕïπëï…}•ê∞ÅâÖ—ç°ïÕm•πëï·t∞ÅùÖ—îπÕ’¡¡Ω…—MÖ±’—Ö—•Ω∏∞Åù…Ω’¿π±Öâï∞§Ï(ÄÄÄÄÄÄÄÄÄÅ•òÄ°…ïÕ’±–§ÅÖ›Ö•–Å…ïçΩ…ë——ïµ¡–°µïë•Ö±Ö•¥πâ’πë±îπ•ê∞Åµïë•Ö——ïµ¡—9º¨¨∞Å—…ÖπÕ¡Ω…–∞ÄâÕïπ–à∞Å…ïÕ’±–§Ï(ÄÄÄÄÄÄÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÄÄÄÄÄÄÅµïë•Ö…Ω’¡Ö•±ïêÄÙÅ—…’îÏ(ÄÄÄÄÄÄÄÄÄÅµïë•Ö]Ö…π•πúÄÙÅM—…•πú°ï……Ω»¸πµïÕÕÖùîÅÒÅï……Ω»§πÕ±•çî†¿∞Ä‘¿¿§Ï(ÄÄÄÄÄÄÄÄÄÅÖ›Ö•–Å…ïçΩ…ë——ïµ¡–°µïë•Ö±Ö•¥πâ’πë±îπ•ê∞Åµïë•Ö——ïµ¡—9º¨¨∞Å—…ÖπÕ¡Ω…–∞ÄâôÖ•±ïêà∞ÅÌÙ∞Åï……Ω»§Ï(ÄÄÄÄÄÄÄÅÙ(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅÖ›Ö•–ÅçΩ…î†âÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝•êıïƒ∏àÄ¨ÅïπçΩëïUI%Ωµ¡Ωπïπ–°µïë•Ö±Ö•¥πâ’πë±îπ•ê§∞ÅÏ(ÄÄÄÄÄÄÄÅµï—°ΩêËÄâAQ à∞(ÄÄÄÄÄÄÄÅ¡…ïôï»ËÄâ…ï—’…∏ıµ•π•µÖ∞à∞(ÄÄÄÄÄÄÄÅâΩë‰ËÅÏÅÕ—Ö—’ÃËÅµïë•Ö…Ω’¡Ö•±ïêÄ¸ÄâôÖ•±ïêàÄËÄâÕïπ–à∞Å’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§ÅÙ∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÅÙ((ÄÄÄÅçΩπÕ–Å¡Ö…—•Ö∞ÄÙÅ	ΩΩ±ïÖ∏°µïë•Ö]Ö…π•πú§Ï(ÄÄÄÅÖ›Ö•–ÅçΩ…î°ÅÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝•êıïƒ∏ëÌâ’πë±îπ•ëıÄ∞ÅÏÅµï—°ΩêËÄâAQ à∞Å¡…ïôï»ËÄâ…ï—’…∏ıµ•π•µÖ∞à∞ÅâΩë‰ËÅÏÅÕ—Ö—’ÃËÅ¡Ö…—•Ö∞Ä¸Äâ¡Ö…—•Ö∞àÄËÄâÕïπ–à∞Å’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§ÅÙÅÙ§Ï(ÄÄÄÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Å¡Ö…—•Ö∞Ä¸Äâ±•Ÿï}ëï±•Ÿï…ïë}¡Ö…—•Ö∞àÄËÄâ±•Ÿï}ëï±•Ÿï…ïêà∞ÅÏ(ÄÄÄÄÄÅÕ°Ω’±ë}ÕïπêËÅ—…’î∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅôÖ±Õî∞(ÄÄÄÄÄÅëï±•Ÿï…Â}â’πë±ï}•êËÅâ’πë±îπ•ê∞(ÄÄÄÄÄÅ¡…ΩŸ•ëï…}µïÕÕÖùï}•êËÅ—ï·—IïÕ’±–¸πµïÕÕÖùï}•êÅÒÅ—ï·—IïÕ’±–¸π•êÅÒÅπ’±∞∞(ÄÄÄÄÄÅëï±•Ÿï…ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§∞(ÄÄÄÄÄÅµïë•Ö}›Ö…π•πúËÅµïë•Ö]Ö…π•πú∞(ÄÄÄÄÄÅµïë•Ö}çÖ—Ö±Ωù}≠ïÂÕ}…ïÕΩ±ŸïêËÅµïë•ÑπçÖ—Ö±Ωù}≠ïÂÃ∞(ÄÄÄÄÄÅµïë•Ö}çÖ—Ö±Ωù}≠ïÂÕ}…ï≈’ïÕ—ïêËÅµïë•Ñπ…ï≈’ïÕ—ïë}çÖ—Ö±Ωù}≠ïÂÃÅÒÅç±Ö•µïêπΩ’—¡’–¸πÕï±ïç—ïë}çÖ—Ö±Ωù}≠ïÂÃÅÒÅmt∞(ÄÄÄÄÄÅµïë•Ö}çÖ—Ö±Ωù}≠ïÂÕ}µ•ÕÕ•πúËÅµïë•Ñπµ•ÕÕ•πù}çÖ—Ö±Ωù}≠ïÂÃÅÒÅmt∞(ÄÄÄÄÄÅµïë•Ö}ÕçΩ¡ï}çΩµ¡±ï—îËÄÑ°µïë•Ñπµ•ÕÕ•πù}çÖ—Ö±Ωù}≠ïÂÃÅÒÅmt§π±ïπù—†∞(ÄÄÄÄÄÅµïë•Ö}ÖÕÕï—}çΩ’π–ËÅµïë•ÑπÖÕÕï—Ãπ±ïπù—†∞(ÄÄÄÄÄÅµïë•Ö}ù…Ω’¡}çΩ’π–ËÅ……Ö‰π•Õ……Ö‰°µïë•Ñπµïë•Ö}â’πë±ïÃ§Ä¸Åµïë•Ñπµïë•Ö}â’πë±ïÃπ±ïπù—†ÄËÄ¿∞(ÄÄÄÄÄÅµïë•Ö}â’πë±ï}¡Ω±•ç‰ËÄâΩπï}¡…Ωë’ç—}ù…Ω’¡}¡ï…}â’πë±îà∞(ÄÄÄÄÄÅµïë•Ö}ëïë’¡ï}›•πëΩ›}°Ω’…ÃËÄ»–∞(ÄÄÄÄÄÅµïë•Ö}ëïë’¡ï}Õ’¡¡…ïÕÕïë}çΩ’π–ËÅµïë•Öïë’¡îπÕ’¡¡…ïÕÕïë}çΩ’π–∞(ÄÄÄÄÄÅµïë•Ö}ëïë’¡ï}ç±Ö•µÃËÅµïë•Öïë’¡îπç±Ö•µÃπµÖ¿†°•—ï¥§ÄÙ¯Ä°ÏÅâ’πë±ï}≠ï‰ËÅ•—ï¥πù…Ω’¿πâ’πë±ï}≠ï‰∞ÅçÖ—Ö±Ωù}≠ïÂÃËÅ•—ï¥πù…Ω’¿πçÖ—Ö±Ωù}≠ïÂÃÅÒÅmt∞ÅÖ±±Ω›ïêËÅ•—ï¥πÖ±±Ω›ïê∞Å…ïÖÕΩ∏ËÅ•—ï¥π…ïÖÕΩ∏∞Åç±Ö•µ}â’πë±ï}•êËÅ•—ï¥πâ’πë±î¸π•êÅÒÅπ’±∞ÅÙ§§∞(ÄÄÄÄÄÅµïë•Ö}â’πë±ïÕ}…ïÕΩ±ŸïêËÄ°µïë•Ñπµïë•Ö}â’πë±ïÃÅÒÅmt§πµÖ¿†°•—ï¥§ÄÙ¯Ä°ÏÅâ’πë±ï}≠ï‰ËÅ•—ï¥πâ’πë±ï}≠ï‰∞Åù…Ω’¡}≠ï‰ËÅ•—ï¥πù…Ω’¡}≠ï‰∞Å±Öâï∞ËÅ•—ï¥π±Öâï∞∞ÅçÖ—Ö±Ωù}≠ïÂÃËÅ•—ï¥πçÖ—Ö±Ωù}≠ïÂÃ∞ÅÖÕÕï—}çΩ’π–ËÅ•—ï¥πÖÕÕï—}çΩ’π–ÅÙ§§∞(ÄÄÄÄÄÅçΩπ—Öç—}…ï≈’ïÕ—}ÕÖπ•—•ÈïêËÅ	ΩΩ±ïÖ∏°ùÖ—îπçΩπ—Öç—-πΩ›∏ÄòòÅç±Ö•µïêπΩ’—¡’–¸πÕ°Ω’±ë}…ï≈’ïÕ—}çΩπ—Öç–§∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}µΩëîËÅ	ΩΩ±ïÖ∏°ùÖ—îπÕ’¡¡Ω…—5Ωëî§∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}¡…•µÖ…Â}âΩ–ËÅùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰Ä¸Äâ%U-}=559Q}AI%YQ}IA1dàÄËÄ°ùÖ—îπÕ’¡¡Ω…—5ΩëîÄ¸Äâ%-àÄËÅπ’±∞§∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}Ω¡ï…Ö—•ΩπÖ±}ôÖ±±âÖç≠}ëï±•Ÿï…ïêËÅ	ΩΩ±ïÖ∏°ùÖ—îπÕ’¡¡Ω…—Qï·—Ö±±âÖç≠±•ù•â±î§∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}ôÖ±±âÖç≠}ù’Ö…ë}ëïù…ÖëïêËÅ	ΩΩ±ïÖ∏°ùÖ—îπÕ’¡¡Ω…—Ö±±âÖç≠’Ö…ëïù…Öëïê§∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}±•Ÿï}…ï¡±Â}ÕΩ’…çîËÅùÖ—îπ±•ŸïAÖùïIï¡±‰¸πÕΩ’…çï}ÕÂÕ—ï¥ÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}ÕÖ±’—Ö—•Ω∏ËÅùÖ—îπÕ’¡¡Ω…—MÖ±’—Ö—•Ω∏ÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}ÕÖ±’—Ö—•Ωπ}ÕΩ’…çîËÅùÖ—îπÕ’¡¡Ω…—MÖ±’—Ö—•ΩπMΩ’…çîÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}ç’Õ—Ωµï…}πÖµîËÅùÖ—îπÕ’¡¡Ω…—’Õ—Ωµï…9ÖµîÅÒÅπ’±∞∞(ÄÄÄÄÄÅÕ’¡¡Ω…—}çÖ¡—•Ωπ}¡Ω±•ç‰ËÄâ’π•Ÿï…ÕÖ±}πï’—…Ö±}çΩπ—Öç—}ç—Ö}ÿ»à∞(ÄÄÄÄÄÅëï±•Ÿï…Â}µΩëîËÅùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰Ä¸ÄâçΩµµïπ—}¡…•ŸÖ—ï}…ï¡±‰àÄËÄâµïÕÕïπùï»à∞(ÄÄÄÄÄÅçΩµµïπ—}•êËÅùÖ—îπçΩµµïπ—Ωπ—ï·–¸πçΩµµïπ—%êÅÒÅπ’±∞∞(ÄÄÄÄÄÅçΩµµïπ—}ÕΩ’…çï}ïŸïπ—}•êËÅùÖ—îπçΩµµïπ—Ωπ—ï·–¸πÕΩ’…çïŸïπ—%êÅÒÅπ’±∞∞(ÄÄÄÄÄÅ¡’â±•ç}çΩµµïπ—}…ï¡±Â}ôΩ…â•ëëï∏ËÅ	ΩΩ±ïÖ∏°ùÖ—îπçΩµµïπ—A…•ŸÖ—ïIï¡±‰§∞(ÄÄÄÅÙ§Ï(ÄÄÄÅçΩπÕ–Åëï±•Ÿï…ïë–ÄÙÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§Ï(ÄÄÄÅÖ›Ö•–ÅçΩ…î°ÅÿÂ}çΩπŸï…ÕÖ—•Ωπ}Õ—Ö—î˝¡Öùï}•êıïƒ∏ëÌïπçΩëïUI%Ωµ¡Ωπïπ–°ç±Ö•µïêπ¡Öùï}•ê•ÙôÕïπëï…}•êıïƒ∏ëÌïπçΩëïUI%Ωµ¡Ωπïπ–°ç±Ö•µïêπÕïπëï…}•ê•ıÄ∞ÅÏ(ÄÄÄÄÄÅµï—°ΩêËÄâAQ à∞(ÄÄÄÄÄÅ¡…ïôï»ËÄâ…ï—’…∏ıµ•π•µÖ∞à∞(ÄÄÄÄÄÅâΩë‰ËÅÏÅÕ—Ö—îËÄâ	=Q}IA1%à∞Å±ÖÕ—}¡Öùï}ïŸïπ—}Ö–ËÅëï±•Ÿï…ïë–∞Å…ïÕ¡ΩπÕï}ëïÖë±•πï}Ö–ËÅπ’±∞∞Å’¡ëÖ—ïë}Ö–ËÅëï±•Ÿï…ïë–ÅÙ∞(ÄÄÄÅÙ§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÅÖ›Ö•–Å…ïÕΩ±Ÿïïç•Õ•ΩπM±Ñ°ç±Ö•µïê∞ÄâÖ•ù’≠Ö}…ï¡±•ïêà∞Åëï±•Ÿï…ïë–§Ï(ÄÄÄÅë•Õ¡Ö—ç°IïÕ’±–ÄÙÅ¡Ö…—•Ö∞Ä¸Äâ±•Ÿï}ëï±•Ÿï…ïë}¡Ö…—•Ö∞àÄËÄâ±•Ÿï}ëï±•Ÿï…ïêàÏ(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄƒ∞ÅÕ’¡¡…ïÕÕïêËÄ¿∞ÅôÖ•±ïêËÄ¿ÅÙÏ(ÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÅÖ›Ö•–Å…ïçΩ…ë——ïµ¡–°â’πë±îπ•ê∞Åπï·———ïµ¡–∞Å—ï·—Q…ÖπÕ¡Ω…–∞ÄâôÖ•±ïêà∞ÅÌÙ∞Åï……Ω»§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÅÖ›Ö•–ÅçΩ…î°ÅÿÂ}ëï±•Ÿï…Â}â’πë±ïÃ˝•êıïƒ∏ëÌâ’πë±îπ•ëıÄ∞ÅÏÅµï—°ΩêËÄâAQ à∞Å¡…ïôï»ËÄâ…ï—’…∏ıµ•π•µÖ∞à∞ÅâΩë‰ËÅÏÅÕ—Ö—’ÃËÄâôÖ•±ïêà∞Å’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§ÅÙÅÙ§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÅÖ›Ö•–Å¡Ö—ç°ïç•Õ•Ω∏°ç±Ö•µïê∞Äâ±•Ÿï}ëï±•Ÿï…Â}ôÖ•±ïêà∞ÅÏ(ÄÄÄÄÄÅÕ°Ω’±ë}ÕïπêËÅ—…’î∞(ÄÄÄÄÄÅ—…ÖπÕ¡Ω…—}±Ωç≠ïêËÅôÖ±Õî∞(ÄÄÄÄÄÅëï±•Ÿï…Â}â’πë±ï}•êËÅâ’πë±îπ•ê∞(ÄÄÄÄÄÅ±•Ÿï}ëï±•Ÿï…Â}ï……Ω»ËÅM—…•πú°ï……Ω»¸πµïÕÕÖùîÅÒÅï……Ω»§πÕ±•çî†¿∞Ä‡¿¿§∞(ÄÄÄÅÙ§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÄÄÅë•Õ¡Ö—ç°IïÕ’±–ÄÙÄâ±•Ÿï}ëï±•Ÿï…Â}ôÖ•±ïêàÏ(ÄÄÄÅ…ï—’…∏ÅÏÅÕïπ–ËÄ¿∞ÅÕ’¡¡…ïÕÕïêËÄ¿∞ÅôÖ•±ïêËÄƒÅÙÏ(ÄÅÙÅô•πÖ±±‰ÅÏ(ÄÄÄÅÖ›Ö•–ÅùÖ—ï›Ö‰π…ï±ïÖÕï•Õ¡Ö—ç†°Ï(ÄÄÄÄÄÅ¡Öùï%êËÅç±Ö•µïêπ¡Öùï}•ê∞(ÄÄÄÄÄÅÕïπëï…%êËÅç±Ö•µïêπÕïπëï…}•ê∞(ÄÄÄÄÄÅΩ›πï»ËÅ%MAQ!}=]9ILπ1%Y∞(ÄÄÄÄÄÅëïë’¡ï-ï‰ËÅë•Õ¡Ö—ç°-ï‰∞(ÄÄÄÄÄÅ…ïÕ’±–ËÅë•Õ¡Ö—ç°IïÕ’±–∞(ÄÄÄÅÙ§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÅÙ)Ù()ÖÕÂπåÅô’πç—•Ω∏Å°ïÖ…—âïÖ–°Õ—Ö—’Ã∞ÅµΩëî∞Åëï—Ö•±ÃÄÙÅÌÙ∞Åï……Ω»ÄÙÅπ’±∞§ÅÏ(ÄÅ•òÄ°Õ—Ö—’ÃÄÙÙÙÄâ°ïÖ±—°‰àÄòòÅÖ—îππΩ‹†§Ä¥Å±ÖÕ—!ïÖ…—âïÖ–ÄÄ»¿¿¿¿§Å…ï—’…∏Ï(ÄÅÖ›Ö•–ÅçΩ…î†âÿÂ}›Ω…≠ï…}°ïÖ…—âïÖ—Ã˝Ωπ}çΩπô±•ç–ı›Ω…≠ï…}πÖµîà∞ÅÏ(ÄÄÄÅµï—°ΩêËÄâA=MPà∞(ÄÄÄÅ¡…ïôï»ËÄâ…ïÕΩ±’—•Ω∏ıµï…ùîµë’¡±•çÖ—ïÃ±…ï—’…∏ıµ•π•µÖ∞à∞(ÄÄÄÅâΩë‰ËÅÏ(ÄÄÄÄÄÅ›Ω…≠ï…}πÖµîËÅ95∞(ÄÄÄÄÄÅ›Ω…≠ï…}Ÿï…Õ•Ω∏ËÅYIM%=8∞(ÄÄÄÄÄÅÕ—Ö—’Ã∞(ÄÄÄÄÄÅµΩëî∞(ÄÄÄÄÄÅëï—Ö•±ÃËÅÏÄ∏∏πëï—Ö•±Ã∞Å°Ö…ë}ùÖ—ïÃËÅlâΩ¡—}Ω’–à∞Äâ°’µÖπ}—Ö≠ïΩŸï»à∞ÄâŸï…•ô•ïë}¡Öùï}…ï¡±‰à∞Äâëïë’¡îà∞Äâµï—Ö}—…ÖπÕ¡Ω…–ât∞Åâ’Õ•πïÕÕ}…’±ïÕ}Ö’—°Ω…•—‰ËÄâπΩπîàÅÙ∞(ÄÄÄÄÄÅ±ÖÕ—}ï……Ω»ËÅï……Ω»Ä¸ÅM—…•πú°ï……Ω»§πÕ±•çî†¿∞Ä‡¿¿§ÄËÅπ’±∞∞(ÄÄÄÄÄÅ±ÖÕ—}Õïïπ}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§∞(ÄÄÄÄÄÅ’¡ëÖ—ïë}Ö–ËÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§∞(ÄÄÄÅÙ∞(ÄÅÙ§Ï(ÄÅ±ÖÕ—!ïÖ…—âïÖ–ÄÙÅÖ—îππΩ‹†§Ï)Ù()ÖÕÂπåÅô’πç—•Ω∏Å—•ç¨†§ÅÏ(ÄÅ•òÄ†ÖçΩπô•ù’…ïê†§ÅÒÅ…’ππ•πú§Å…ï—’…∏Ï(ÄÅ…’ππ•πúÄÙÅ—…’îÏ(ÄÅ±ï–ÅµΩëîÄÙÄâ=àÏ(ÄÅ±ï–ÅÕïπ–ÄÙÄ¿Ï(ÄÅ±ï–ÅÕ’¡¡…ïÕÕïêÄÙÄ¿Ï(ÄÅ±ï–ÅôÖ•±ïêÄÙÄ¿Ï(ÄÅ—…‰ÅÏ(ÄÄÄÅçΩπÕ–ÅçΩπô•úÄÙÅÖ›Ö•–Å…’π—•µî†§Ï(ÄÄÄÅµΩëîÄÙÅM—…•πú°çΩπô•úπµΩëîÅÒÄâ=à§π—ΩU¡¡ï…ÖÕî†§Ï(ÄÄÄÅ•òÄ°µΩëîÄÑÙÙÄâQ%Yà§ÅÏ(ÄÄÄÄÄÅÖ›Ö•–Å°ïÖ…—âïÖ–†â•ë±îà∞ÅµΩëî∞ÅÏÅΩ’—âΩ’πë}ïπÖâ±ïêËÅôÖ±ÕîÅÙ§Ï(ÄÄÄÄÄÅ…ï—’…∏Ï(ÄÄÄÅÙ(ÄÄÄÅÖ›Ö•–ÅùÖ—ï›Ö‰π›Ö…µAÖùïQΩ≠ïπÃ†§Ï(ÄÄÄÅçΩπÕ–ÅçÖπë•ëÖ—ïÃÄÙÅÖ›Ö•–ÅçΩ…î°ÅÿÂ}ëïç•Õ•ΩπÃ˝Õï±ïç–ı•ê±¡Öùï}•ê±Õïπëï…}•ê±ÕΩ’…çï}ïŸïπ—}•ê±Õ—Ö—’Ã±Öç—•Ω∏±çΩπô•ëïπçî±Ω’—¡’–±•π¡’—}ÕπÖ¡Õ°Ω–±ç…ïÖ—ïë}Ö–±’¡ëÖ—ïë}Ö–ôÕ—Ö—’Ãı•∏∏°Õ°ÖëΩ›}Ö•}çΩµ¡±ï—ïê±±•Ÿï}ëï±•Ÿï…Â}ôÖ•±ïê§ôΩ…ëï»ıç…ïÖ—ïë}Ö–πëïÕåô±•µ•–ÙëÌ9%Q}M9}1%5%QıÄ§Ï(ÄÄÄÅçΩπÕ–Å¡…•Ω…•—‰ÄÙÅ¡…•Ω…•—•Èï=’—âΩ’πëïç•Õ•ΩπÃ°çÖπë•ëÖ—ïÃ∞ÅÏ(ÄÄÄÄÄÅπΩ›5ÃËÅÖ—îππΩ‹†§∞(ÄÄÄÄÄÅ…ïÕ¡ΩπÕïM±ÖMïçΩπëÃËÅ9’µâï»°çΩπô•úπ…ïÕ¡ΩπÕï}Õ±Ö}ÕïçΩπëÃÅÒÄ–‘§∞(ÄÄÄÅÙ§Ï(ÄÄÄÅçΩπÕ–Å…Ω›ÃÄÙÅ¡…•Ω…•—‰π…Ω›ÃπÕ±•çî†¿∞Å1%YIe}	Q!}M%i§Ï(ÄÄÄÅôΩ»Ä°çΩπÕ–Åëïç•Õ•Ω∏ÅΩòÅ…Ω›ÃÅÒÅmt§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Å…ïÕ’±–ÄÙÅÖ›Ö•–Å¡…ΩçïÕÕïç•Õ•Ω∏°ëïç•Õ•Ω∏∞ÅçΩπô•ú§Ï(ÄÄÄÄÄÅÕïπ–Ä¨ÙÅ…ïÕ’±–πÕïπ–Ï(ÄÄÄÄÄÅÕ’¡¡…ïÕÕïêÄ¨ÙÅ…ïÕ’±–πÕ’¡¡…ïÕÕïêÏ(ÄÄÄÄÄÅôÖ•±ïêÄ¨ÙÅ…ïÕ’±–πôÖ•±ïêÏ(ÄÄÄÅÙ(ÄÄÄÅÖ›Ö•–Å°ïÖ…—âïÖ–°ôÖ•±ïêÄ¸Äâëïù…ÖëïêàÄËÄâ°ïÖ±—°‰à∞ÅµΩëî∞ÅÏ(ÄÄÄÄÄÅΩ’—âΩ’πë}ïπÖâ±ïêËÅ—…’î∞(ÄÄÄÄÄÅçÖπë•ëÖ—ïÃËÅ…Ω›Ãπ±ïπù—†∞(ÄÄÄÄÄÅçÖπë•ëÖ—ïÕ}ÕçÖππïêËÅçÖπë•ëÖ—ïÃ¸π±ïπù—†ÅÒÄ¿∞(ÄÄÄÄÄÅô…ïÕ°}Õ±Ö}çÖπë•ëÖ—ïÃËÅ¡…•Ω…•—‰πô…ïÕ°}çΩ’π–∞(ÄÄÄÄÄÅ…ïçΩŸï…Â}âÖç≠±Ωù}çÖπë•ëÖ—ïÃËÅ¡…•Ω…•—‰π…ïçΩŸï…Â}çΩ’π–∞(ÄÄÄÄÄÅΩ’—âΩ’πë}¡…•Ω…•—‰ËÄâô…ïÕ°}Õ±Ö}ô•…Õ—}—°ïπ}…ïçïπ—}…ïçΩŸï…‰à∞(ÄÄÄÄÄÅëï±•Ÿï…Â}âÖ—ç°}Õ•ÈîËÅ1%YIe}	Q!}M%i∞(ÄÄÄÄÄÅçÖπë•ëÖ—ï}ÕçÖπ}±•µ•–ËÅ9%Q}M9}1%5%P∞(ÄÄÄÄÄÅÕïπ–∞(ÄÄÄÄÄÅÕ’¡¡…ïÕÕïê∞(ÄÄÄÄÄÅôÖ•±ïê∞(ÄÄÄÄÄÅ•ëïµ¡Ω—ïπ–ËÅ—…’î∞(ÄÄÄÄÄÅâÖ±Öπçïë}µïë•Ö}µÖ‡ËÅ5a}5%}MMQL∞(ÄÄÄÄÄÅµïë•Ö}ÖÕÕï—Õ}µÖ·}¡ï…}ù…Ω’¿ËÅ5a}5%}MMQL∞(ÄÄÄÄÄÅµïë•Ö}â’πë±ï}¡Ω±•ç‰ËÄâΩπï}¡…Ωë’ç—}ù…Ω’¡}¡ï…}â’πë±îà∞(ÄÄÄÄÄÅΩâÕï…Ÿïë}¡Öùï}…ï¡±Â}¡ï…Õ•Õ—ïπçîËÅ—…’î∞(ÄÄÄÄÄÅÕ±Ö}…ïÕΩ±’—•Ωπ}Ωπ}…ï¡±‰ËÅ—…’î∞(ÄÄÄÅÙ∞ÅôÖ•±ïêÄ¸ÅÄëÌôÖ•±ïëÙÅ±•ŸîÅëï±•Ÿï…‰°Ã§ÅôÖ•±ïëÄÄËÅπ’±∞§Ï(ÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏ(ÄÄÄÅÖ›Ö•–Å°ïÖ…—âïÖ–†âëïù…Öëïêà∞ÅµΩëî∞ÅÏÅΩ’—âΩ’πë}ïπÖâ±ïêËÅµΩëîÄÙÙÙÄâQ%Yà∞ÅÕïπ–∞ÅÕ’¡¡…ïÕÕïê∞ÅôÖ•±ïêÅÙ∞Åï……Ω»¸πµïÕÕÖùîÅÒÅï……Ω»§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï(ÄÅÙÅô•πÖ±±‰ÅÏ(ÄÄÄÅ…’ππ•πúÄÙÅôÖ±ÕîÏ(ÄÄÄÅç±ïÖ…Q•µïΩ’–°—•µï»§Ï(ÄÄÄÅ—•µï»ÄÙÅÕï—Q•µïΩ’–††§ÄÙ¯Å—•ç¨†§πçÖ—ç†††§ÄÙ¯ÅÌÙ§∞ÅµΩëîÄÙÙÙÄâQ%YàÄ¸ÅA=11}5LÄËÄƒ‘¿¿¿§Ï(ÄÄÄÅ—•µï»π’π…ïò¸∏†§Ï(ÄÅÙ)Ù()•òÄ†ÖçΩπô•ù’…ïê†§§ÅÏ(ÄÅçΩπÕΩ±îπ›Ö…∏†âm%U-ÅXƒ¿ÅΩ’—âΩ’πëtÅΩ…îΩ-πΩ›±ïëùîÅç…ïëïπ—•Ö±ÃÅµ•ÕÕ•πúÏÅë•ÕÖâ±ïêà§Ï)ÙÅï±ÕîÅÏ(ÄÅçΩπÕΩ±îπ±Ωú†âm%U-ÅXƒ¿ÅΩ’—âΩ’πëtÅÕÖôï—‰µΩπ±‰Åô•πÖ∞ÅùÖ—îÅÕ—Ö…—ïêÏÅ$Åâ’Õ•πïÕÃÅëïç•Õ•Ω∏Å•ÃÅπΩ–Å…ï›…•——ï∏à§Ï(ÄÅ—•ç¨†§πçÖ—ç†††§ÄÙ¯ÅÌÙ§Ï)Ù((ººÅ%U-}Xƒ¡}	19}AI=UQ}M=A}5%}Xƒ((ººÅ%U-}Xƒ¡}I=UA}5%}	U91M}Xƒ((ººÅ%U-}Xƒ¡}5%}1%YIe}AI=ae}Xƒ(