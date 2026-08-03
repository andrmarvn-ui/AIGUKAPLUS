import crypto from "node:crypto";
import { buildDecisionInstructions, decisionSchema, neutralUnavailableDecision, validateDecision } from "./v10/core/decision-contract.js";
import { buildKnowledgeAdvisors } from "./v10/core/knowledge-advisor.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v10-ai";
const VERSION = "v10_ai_sovereign_lease_v1";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V10_AI_POLL_MS || 5000));
const LEASE_MS = Math.max(60_000, Number(process.env.AIGUKA_V10_AI_LEASE_MS || 90_000));
const MAX_ATTEMPTS = Math.max(2, Number(process.env.AIGUKA_V10_AI_MAX_ATTEMPTS || 3));
const GEMINI_MIN_INTERVAL_MS = Math.max(8_000, Number(process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS || 10_000));
const GEMINI_MAX_COOLDOWN_MS = Math.max(60_000, Number(process.env.AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS || 300_000));

let running = false;
let timer;
let providerCache = { expiresAt: 0, rows: [], lastProviderKey: null };
let knowledgeCache = { expiresAt: 0, snapshot: null };
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
  usable.sort((a, b) => {
    const pa = String(a.provider_key || a.provider_type || "").toLowerCase().includes("gemini") ? 0 : 1;
    const pb = String(b.provider_key || b.provider_type || "").toLowerCase().includes("gemini") ? 0 : 1;
    return pa - pb;
  });
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

async function beforeGemini() {
  const now = Date.now();
  if (gemini.cooldownUntil > now) {
    const error = new Error("GEMINI_FREE_COOLDOWN_ACTIVE");
    error.retry_at = new Date(gemini.cooldownUntil).toISOString();
    throw error;
  }
  const wait = Math.max(0, gemini.nextAllowedAt - now);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  gemini.nextAllowedAt = Date.now() + GEMINI_MIN_INTERVAL_MS;
}

function afterGemini(status) {
  if (Number(status) === 429) {
    gemini.consecutive429 += 1;
    const cooldown = Math.min(GEMINI_MAX_COOLDOWN_MS, 60_000 * (2 ** Math.max(0, gemini.consecutive429 - 1)));
    gemini.cooldownUntil = Date.now() + cooldown;
  } else if (Number(status) >= 200 && Number(status) < 300) {
    gemini.consecutive429 = 0;
    gemini.cooldownUntil = 0;
  }
}

async function providerCall(ai, modelInput) {
  const apiKey = decryptProviderKey(ai.api_key_ciphertext);
  const providerName = String(ai.provider_key || ai.provider_type || "").toLowerCase();
  if (providerName.includes("gemini")) {
    await beforeGemini();
    let base = String(ai.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    if (!/\/openai$/i.test(base)) base = `${base}/openai`;
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: ai.model_name,
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
    afterGemini(response.status);
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `GEMINI_HTTP_${response.status}`);
    return { decision: parseChatDecision(payload), responseId: payload.id || null, model: ai.model_name, provider: ai.provider_key || ai.provider_type };
  }

  const endpoint = `${String(ai.base_url || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: ai.model_name,
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
  return { decision: parseResponsesDecision(payload), responseId: payload.id || null, model: ai.model_name, provider: ai.provider_key || ai.provider_type };
}

function processingAttempts(row) {
  return Math.max(0, Number(row?.output?.processing_attempts || 0));
}

function contactKnown(row) {
  const snapshot = row?.input_snapshot || {};
  return Boolean(snapshot?.customer?.phone || snapshot?.customer?.zalo || snapshot?.state?.phone || snapshot?.state?.zalo);
}

async function completeWithNeutralAck(row, error) {
  const decision = neutralUnavailableDecision({ contactKnown: contactKnown(row) });
  await core(`v9_decisions?id=eq.${row.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "shadow_ai_completed",
      action: decision.action,
      confidence: decision.confidence,
      output: {
        ...decision,
        should_send: true,
        transport_locked: true,
        provider_key: "operational_fallback",
        provider_errors: [String(error?.message || error).slice(0, 500)],
        processing_attempts: processingAttempts(row),
        architecture: "v10_ai_sovereign_advisory",
      },
      updated_at: new Date().toISOString(),
    },
  });
}

async function recoverStaleProcessing() {
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();
  const stale = await core(`v9_decisions?select=id,output,input_snapshot,updated_at&status=eq.shadow_ai_processing&updated_at=lt.${encodeURIComponent(cutoff)}&order=updated_at.asc&limit=100`);
  let reset = 0;
  let neutral = 0;
  for (const row of stale || []) {
    const attempts = processingAttempts(row);
    if (attempts >= MAX_ATTEMPTS) {
      await completeWithNeutralAck(row, new Error("AI_PROCESSING_LEASE_EXHAUSTED"));
      neutral += 1;
      continue;
    }
    await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_ai_processing`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_context_ready",
        output: {
          ...(row.output || {}),
          should_send: false,
          transport_locked: true,
          last_error: "AI_PROCESSING_LEASE_EXPIRED",
          retry_not_before: new Date(Date.now() + Math.min(60_000, 10_000 * Math.max(1, attempts))).toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
    });
    reset += 1;
  }
  return { stale: stale?.length || 0, reset, neutral };
}

async function claim(row) {
  const attempts = processingAttempts(row) + 1;
  const claimed = await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_context_ready`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "shadow_ai_processing",
      output: {
        ...(row.output || {}),
        should_send: false,
        transport_locked: true,
        processing_attempts: attempts,
        processing_started_at: new Date().toISOString(),
        processing_worker: NAME,
      },
      updated_at: new Date().toISOString(),
    },
  });
  return claimed?.[0] || null;
}

async function retryOrAcknowledge(row, error) {
  const attempts = processingAttempts(row);
  if (attempts >= MAX_ATTEMPTS) {
    await completeWithNeutralAck(row, error);
    return "neutral_ack";
  }
  const delay = Math.min(300_000, 15_000 * (2 ** Math.max(0, attempts - 1)));
  await core(`v9_decisions?id=eq.${row.id}&status=eq.shadow_ai_processing`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "shadow_context_ready",
      output: {
        ...(row.output || {}),
        should_send: false,
        transport_locked: true,
        last_error: String(error?.message || error).slice(0, 800),
        retry_not_before: new Date(Date.now() + delay).toISOString(),
      },
      updated_at: new Date().toISOString(),
    },
  });
  return "retry";
}

async function processOne(row, providerRows, knowledgeSnapshot) {
  const claimed = await claim(row);
  if (!claimed) return { processed: 0, retried: 0, neutral: 0, providerErrors: [] };
  const conversation = claimed.input_snapshot?.conversation || {};
  const knowledgeAdvisors = buildKnowledgeAdvisors(knowledgeSnapshot, conversation, { maxDocuments: 8, maxCatalog: 12, maxAssetsPerCatalog: 6 });
  const modelInput = {
    architecture: "v10_ai_sovereign_advisory",
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
  const startedAt = Date.now();

  try {
    let result = null;
    for (const provider of providerRows) {
      try {
        result = await providerCall(provider, modelInput);
        providerCache.lastProviderKey = result.provider;
        break;
      } catch (error) {
        providerErrors.push(`${provider.provider_key || provider.provider_type}:${String(error?.message || error).slice(0, 300)}`);
      }
    }
    if (!result) throw new Error(providerErrors.join(" | ") || "V10_ALL_PROVIDERS_FAILED");
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
          architecture: "v10_ai_sovereign_advisory",
          advisors_were_non_binding: true,
          knowledge_snapshot: { id: knowledgeSnapshot.id, version_no: knowledgeSnapshot.version_no, checksum: knowledgeSnapshot.checksum },
        },
        updated_at: new Date().toISOString(),
      },
    });
    return { processed: 1, retried: 0, neutral: 0, providerErrors };
  } catch (error) {
    const outcome = await retryOrAcknowledge(claimed, error);
    return { processed: 0, retried: outcome === "retry" ? 1 : 0, neutral: outcome === "neutral_ack" ? 1 : 0, providerErrors };
  }
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
  let neutral = 0;
  let providerErrorCount = 0;
  let recovery = { stale: 0, reset: 0, neutral: 0 };
  try {
    recovery = await recoverStaleProcessing();
    const rows = await core("v9_decisions?select=id,input_snapshot,output,status,created_at,updated_at&status=eq.shadow_context_ready&order=created_at.asc&limit=20");
    const now = Date.now();
    const ready = (rows || []).filter((row) => {
      const retryAt = Date.parse(row?.output?.retry_not_before || "");
      return !Number.isFinite(retryAt) || retryAt <= now;
    });
    if (ready.length) {
      const [providerRows, snapshot] = await Promise.all([providers(), publishedKnowledge()]);
      const result = await processOne(ready[0], providerRows, snapshot);
      processed += result.processed;
      retried += result.retried;
      neutral += result.neutral;
      providerErrorCount += result.providerErrors.length;
    }
    const backlog = (rows || []).length;
    const degraded = recovery.stale > 0 || retried > 0 || providerErrorCount > 0 || backlog > 10;
    await heartbeat(degraded ? "degraded" : "healthy", degraded ? `recovered=${recovery.stale}, retried=${retried}, provider_errors=${providerErrorCount}, backlog=${backlog}` : null, {
      processed_last_tick: processed,
      retried_last_tick: retried,
      neutral_ack_last_tick: neutral + recovery.neutral,
      stale_processing_found: recovery.stale,
      stale_processing_reset: recovery.reset,
      ready_backlog: backlog,
      provider_errors_last_tick: providerErrorCount,
      provider_key: providerCache.lastProviderKey,
      provider_priority: providerCache.rows.map((row) => row.provider_key || row.provider_type),
      transport_locked_at_decision_stage: true,
    });
  } catch (error) {
    await heartbeat("degraded", error?.message || error, {
      processed_last_tick: processed,
      stale_processing_found: recovery.stale,
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
  console.warn("[AIGUKA V10 AI] Core or Knowledge configuration missing; disabled");
} else {
  console.log("[AIGUKA V10 AI] sole decision worker started; advisors non-binding; stale processing lease recovery enabled");
  tick().catch(() => {});
}
