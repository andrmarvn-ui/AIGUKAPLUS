import crypto from "node:crypto";
import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v9/core/decision-contract.js";

const BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const NAME = "aiguka-v9-ai-shadow";
const VERSION = "v9_ai_shadow_v1";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V9_AI_POLL_MS || 5000));
let running = false;
let timer;

async function rest(path, options = {}) {
  const response = await fetch(`${BASE}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", Prefer: options.prefer || "return=representation" },
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

function decrypt(value) {
  const [iv, tag, body] = String(value || "").split(".");
  if (!iv || !tag || !body) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
  const key = crypto.createHash("sha256").update(`${KEY}|${BASE}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

function parseDecision(payload) {
  for (const item of payload?.output || []) {
    if (item?.type === "function_call" && item?.name === "submit_v9_decision") return JSON.parse(item.arguments || "{}");
  }
  throw new Error("V9_MODEL_DID_NOT_SUBMIT_DECISION");
}

async function provider() {
  const rows = await rest("v8_ai_providers?select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled&is_enabled=eq.true&order=updated_at.desc&limit=1");
  const row = rows?.[0];
  if (!row?.api_key_ciphertext) throw new Error("V9_AI_PROVIDER_NOT_READY");
  return row;
}

async function heartbeat(status, error = null, details = {}) {
  await rest("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: { worker_name: NAME, worker_version: VERSION, status, mode: "SHADOW", details, last_error: error ? String(error).slice(0, 800) : null, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  });
}

async function processOne(row, ai) {
  const claimed = await rest(`v9_decisions?id=eq.${row.id}&status=eq.shadow_context_ready`, {
    method: "PATCH", prefer: "return=representation", body: { status: "shadow_ai_processing", updated_at: new Date().toISOString() },
  });
  if (!claimed?.length) return false;
  const snapshot = row.input_snapshot || {};
  const contactCaptured = Boolean(snapshot?.turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);
  const endpoint = `${String(ai.base_url || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${decrypt(ai.api_key_ciphertext)}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: ai.model_name,
      instructions: buildDecisionInstructions(),
      tools: [{ type: "function", name: "submit_v9_decision", strict: true, description: "Submit AIGUKA V9 sales decision", parameters: decisionSchema() }],
      tool_choice: "required",
      parallel_tool_calls: false,
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(snapshot) }] }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
  if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `OPENAI_HTTP_${response.status}`);
  const decision = validateDecision(parseDecision(payload), { contactCaptured });
  await rest(`v9_decisions?id=eq.${row.id}`, {
    method: "PATCH", prefer: "return=minimal",
    body: {
      status: "shadow_ai_completed",
      action: decision.action,
      confidence: decision.confidence,
      output: { ...decision, should_send: false, transport_locked: true, response_id: payload.id || null, model: ai.model_name },
      updated_at: new Date().toISOString(),
    },
  });
  return true;
}

async function tick() {
  if (!BASE || !KEY || running) return;
  running = true;
  let processed = 0;
  try {
    const decisions = await rest("v9_decisions?select=id,input_snapshot,status&status=eq.shadow_context_ready&order=created_at.asc&limit=3");
    if (decisions?.length) {
      const ai = await provider();
      for (const row of decisions) if (await processOne(row, ai)) processed += 1;
    }
    await heartbeat("healthy", null, { processed_last_tick: processed });
  } catch (error) {
    await heartbeat("degraded", error?.message || error, { processed_last_tick: processed }).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!BASE || !KEY) console.warn("[AIGUKA V9 AI shadow] Supabase configuration missing; disabled");
else { console.log("[AIGUKA V9 AI shadow] started; transport locked"); tick().catch(() => {}); }
