import crypto from "node:crypto";
import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v9/core/decision-contract.js";
import { selectKnowledgeContext } from "./v9/core/knowledge-selector.js";

const BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || BASE).replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || KEY);
const NAME = "aiguka-v9-ai-shadow";
const VERSION = "v9_ai_knowledge_shadow_v2";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V9_AI_POLL_MS || 5000));
let running = false;
let timer;
let knowledgeCache = { expiresAt: 0, snapshot: null };
let providerCache = { expiresAt: 0, row: null };

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

// V9 table calls are routed to the isolated Core project by v9-core-fetch-router.
function coreRest(path, options = {}) {
  return request(BASE, KEY, path, options);
}

function knowledgeRest(path, options = {}) {
  return request(KNOWLEDGE_BASE, KNOWLEDGE_KEY, path, options);
}

function decryptProviderKey(value) {
  const [iv, tag, body] = String(value || "").split(".");
  if (!iv || !tag || !body) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
  const key = crypto
    .createHash("sha256")
    .update(`${KNOWLEDGE_KEY}|${KNOWLEDGE_BASE}|AIGUKA_AI_PROVIDER_KEYS_V1`)
    .digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

function parseDecision(payload) {
  for (const item of payload?.output || []) {
    if (item?.type === "function_call" && item?.name === "submit_v9_decision") {
      return JSON.parse(item.arguments || "{}");
    }
  }
  throw new Error("V9_MODEL_DID_NOT_SUBMIT_DECISION");
}

async function provider() {
  if (providerCache.row && providerCache.expiresAt > Date.now()) return providerCache.row;
  const rows = await knowledgeRest(
    "ai_providers?select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled&is_enabled=eq.true&order=updated_at.desc&limit=1",
    { timeout: 10000 },
  );
  const row = rows?.[0];
  if (!row?.api_key_ciphertext) throw new Error("V9_AI_PROVIDER_NOT_READY");
  providerCache = { row, expiresAt: Date.now() + 60000 };
  return row;
}

async function publishedKnowledge() {
  if (knowledgeCache.snapshot && knowledgeCache.expiresAt > Date.now()) return knowledgeCache.snapshot;
  const configs = await knowledgeRest(
    "ai_runtime_config?select=mode,published_snapshot_id,cache_ttl_seconds&id=eq.1&limit=1",
    { timeout: 10000 },
  );
  const config = configs?.[0];
  if (!config || config.mode === "OFF") throw new Error("V9_KNOWLEDGE_DISABLED");
  if (!config.published_snapshot_id) throw new Error("V9_KNOWLEDGE_SNAPSHOT_NOT_PUBLISHED");
  const snapshots = await knowledgeRest(
    `ai_published_snapshots?select=id,version_no,checksum,content,status&id=eq.${encodeURIComponent(config.published_snapshot_id)}&status=eq.published&limit=1`,
    { timeout: 15000 },
  );
  const snapshot = snapshots?.[0];
  if (!snapshot?.content) throw new Error("V9_KNOWLEDGE_SNAPSHOT_NOT_FOUND");
  const ttlMs = Math.max(30000, Math.min(86400000, Number(config.cache_ttl_seconds || 300) * 1000));
  knowledgeCache = { snapshot, expiresAt: Date.now() + ttlMs };
  return snapshot;
}

function compactConversation(snapshot = {}) {
  const customer = snapshot.customer || {};
  const state = snapshot.state || {};
  return {
    turn: snapshot.turn || {},
    customer: {
      display_name: customer.display_name || null,
      gender: customer.gender || null,
      gender_source: customer.gender_source || null,
      preferred_salutation: customer.preferred_salutation || null,
      last_product_key: customer.last_product_key || null,
      last_intent_type: customer.last_intent_type || null,
      contact_captured: Boolean(customer.phone || customer.zalo || snapshot?.turn?.contact?.contactCaptured),
    },
    state: {
      human_takeover: Boolean(state.human_takeover),
      human_takeover_until: state.human_takeover_until || null,
      contact_status: state.contact_status || "missing",
    },
    response_sla_seconds: snapshot.response_sla_seconds,
    external_bot_mode: snapshot.external_bot_mode,
    external_bot_policy: snapshot.external_bot_policy,
  };
}

async function heartbeat(status, error = null, details = {}) {
  await coreRest("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: "SHADOW",
      details,
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function markDecisionError(row, error, knowledge = null) {
  await coreRest(`v9_decisions?id=eq.${row.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      status: "shadow_ai_error",
      output: {
        should_send: false,
        transport_locked: true,
        reason: "V9 AI shadow decision failed safely.",
        error: String(error?.message || error).slice(0, 800),
        knowledge_snapshot: knowledge ? {
          id: knowledge.id,
          version_no: knowledge.version_no,
          checksum: knowledge.checksum,
        } : null,
      },
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

async function processOne(row, ai, knowledgeSnapshot) {
  const claimed = await coreRest(`v9_decisions?id=eq.${row.id}&status=eq.shadow_context_ready`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "shadow_ai_processing", updated_at: new Date().toISOString() },
  });
  if (!claimed?.length) return false;

  try {
    const snapshot = row.input_snapshot || {};
    const contactCaptured = Boolean(snapshot?.turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);
    const selectedKnowledge = selectKnowledgeContext(knowledgeSnapshot, snapshot, {
      maxDocuments: 6,
      maxDocumentChars: 1800,
      maxCatalogNodes: 6,
      maxAssetsPerNode: 6,
    });
    const modelInput = {
      conversation: compactConversation(snapshot),
      knowledge: selectedKnowledge,
    };
    const endpoint = `${String(ai.base_url || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${decryptProviderKey(ai.api_key_ciphertext)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ai.model_name,
        instructions: buildDecisionInstructions(),
        tools: [{
          type: "function",
          name: "submit_v9_decision",
          strict: true,
          description: "Submit AIGUKA V9 sales decision",
          parameters: decisionSchema(),
        }],
        tool_choice: "required",
        parallel_tool_calls: false,
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(modelInput) }] }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `OPENAI_HTTP_${response.status}`);
    const decision = validateDecision(parseDecision(payload), { contactCaptured });
    await coreRest(`v9_decisions?id=eq.${row.id}`, {
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
          should_send: false,
          transport_locked: true,
          response_id: payload.id || null,
          model: ai.model_name,
          knowledge_snapshot: {
            id: knowledgeSnapshot.id,
            version_no: knowledgeSnapshot.version_no,
            checksum: knowledgeSnapshot.checksum,
          },
          selected_knowledge: {
            documents: selectedKnowledge.documents.map((item) => `${item.document_key}@${item.version_no}`),
            catalog_keys: selectedKnowledge.catalog.map((item) => item.catalog_key),
            ad_ids: selectedKnowledge.ad_mappings.map((item) => item.ad_id),
          },
        },
        updated_at: new Date().toISOString(),
      },
    });
    return true;
  } catch (error) {
    await markDecisionError(row, error, knowledgeSnapshot);
    throw error;
  }
}

async function tick() {
  if (!BASE || !KEY || !KNOWLEDGE_BASE || !KNOWLEDGE_KEY || running) return;
  running = true;
  let processed = 0;
  let errors = 0;
  let knowledgeSnapshot = null;
  try {
    const decisions = await coreRest(
      "v9_decisions?select=id,input_snapshot,status&status=eq.shadow_context_ready&order=created_at.asc&limit=3",
    );
    if (decisions?.length) {
      const [ai, knowledge] = await Promise.all([provider(), publishedKnowledge()]);
      knowledgeSnapshot = knowledge;
      for (const row of decisions) {
        try {
          if (await processOne(row, ai, knowledge)) processed += 1;
        } catch {
          errors += 1;
        }
      }
    }
    await heartbeat(errors ? "degraded" : "healthy", errors ? `${errors} shadow decision(s) failed safely` : null, {
      processed_last_tick: processed,
      errors_last_tick: errors,
      knowledge_snapshot_id: knowledgeSnapshot?.id || knowledgeCache.snapshot?.id || null,
      knowledge_version: knowledgeSnapshot?.version_no ?? knowledgeCache.snapshot?.version_no ?? null,
      provider_key: providerCache.row?.provider_key || null,
      transport_locked: true,
    });
  } catch (error) {
    await heartbeat("degraded", error?.message || error, {
      processed_last_tick: processed,
      errors_last_tick: errors,
      knowledge_snapshot_id: knowledgeSnapshot?.id || knowledgeCache.snapshot?.id || null,
      transport_locked: true,
    }).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!BASE || !KEY || !KNOWLEDGE_BASE || !KNOWLEDGE_KEY) {
  console.warn("[AIGUKA V9 AI shadow] Core or Knowledge configuration missing; disabled");
} else {
  console.log("[AIGUKA V9 AI shadow] started with published Knowledge snapshot; transport locked");
  tick().catch(() => {});
}
