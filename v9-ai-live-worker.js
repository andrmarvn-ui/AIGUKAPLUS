import crypto from "node:crypto";
import { buildDecisionInstructions, decisionSchema, validateDecision } from "./v9/core/decision-contract.js";
import { selectKnowledgeContext } from "./v9/core/knowledge-selector.js";

const BASE = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const KNOWLEDGE_BASE = String(process.env.AIGUKA_V9_KNOWLEDGE_URL || BASE).replace(/\/$/, "");
const KNOWLEDGE_KEY = String(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || KEY);
const NAME = "aiguka-v9-ai-shadow";
const VERSION = "v9_ai_live_multi_provider_v3";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_V9_AI_POLL_MS || 5000));
let running = false;
let timer;
let knowledgeCache = { expiresAt: 0, snapshot: null };
let providerCache = { expiresAt: 0, rows: [], lastProviderKey: null };

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

function parseResponsesDecision(payload) {
  for (const item of payload?.output || []) {
    if (item?.type === "function_call" && item?.name === "submit_v9_decision") {
      return JSON.parse(item.arguments || "{}");
    }
  }
  throw new Error("V9_MODEL_DID_NOT_SUBMIT_DECISION");
}

function parseChatDecision(payload) {
  const message = payload?.choices?.[0]?.message || {};
  for (const item of message.tool_calls || []) {
    if (item?.function?.name === "submit_v9_decision") {
      return JSON.parse(item.function.arguments || "{}");
    }
  }
  const text = Array.isArray(message.content)
    ? message.content.map((item) => item?.text || "").join("")
    : String(message.content || "");
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) return JSON.parse(cleaned);
  throw new Error("V9_CHAT_MODEL_DID_NOT_SUBMIT_DECISION");
}

async function providers() {
  if (providerCache.rows.length && providerCache.expiresAt > Date.now()) return providerCache.rows;
  const rows = await knowledgeRest(
    "ai_providers?select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled,updated_at&is_enabled=eq.true&order=updated_at.desc&limit=10",
    { timeout: 10000 },
  );
  const usable = (rows || []).filter((row) => row?.api_key_ciphertext);
  usable.sort((a, b) => {
    const pa = String(a.provider_key || a.provider_type || "").toLowerCase().includes("gemini") ? 0 : 1;
    const pb = String(b.provider_key || b.provider_type || "").toLowerCase().includes("gemini") ? 0 : 1;
    return pa - pb;
  });
  if (!usable.length) throw new Error("V9_AI_PROVIDER_NOT_READY");
  providerCache = { rows: usable, expiresAt: Date.now() + 60000, lastProviderKey: providerCache.lastProviderKey };
  return usable;
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

async function providerCall(ai, modelInput) {
  const apiKey = decryptProviderKey(ai.api_key_ciphertext);
  const providerName = String(ai.provider_key || ai.provider_type || "").toLowerCase();
  if (providerName.includes("gemini")) {
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
        tools: [{
          type: "function",
          function: {
            name: "submit_v9_decision",
            description: "Submit AIGUKA V9 sales decision",
            parameters: decisionSchema(),
          },
        }],
        tool_choice: "required",
        reasoning_effort: "none",
      }),
      signal: AbortSignal.timeout(60000),
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `GEMINI_HTTP_${response.status}`);
    return { decision: parseChatDecision(payload), responseId: payload.id || null, model: ai.model_name };
  }

  const endpoint = `${String(ai.base_url || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
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
  return { decision: parseResponsesDecision(payload), responseId: payload.id || null, model: ai.model_name };
}

function fallbackDecision(snapshot = {}, selectedKnowledge = {}) {
  const turn = snapshot.turn || {};
  const contactCaptured = Boolean(turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);
  if (contactCaptured) {
    return {
      action: "contact_captured",
      final_reply: "",
      should_request_contact: false,
      contact_benefit: "",
      products: turn?.salesSignals?.products || [],
      intents: turn?.salesSignals?.intents || [],
      needs_slides: false,
      confidence: 1,
      reason: "Rule fallback: contact already captured.",
      risk_flags: ["provider_unavailable"],
    };
  }

  const rawText = String(turn.combinedText || "").trim();
  const text = rawText.toLowerCase();
  const products = Array.isArray(turn?.salesSignals?.products) ? turn.salesSignals.products : [];
  const intents = Array.isArray(turn?.salesSignals?.intents) ? turn.salesSignals.intents : [];
  const catalog = Array.isArray(selectedKnowledge.catalog) ? selectedKnowledge.catalog : [];
  const productLabel = catalog[0]?.display_name || (products[0] ? products[0].replaceAll("_", " ") : "sản phẩm");

  if (!rawText || /^get started$/i.test(rawText) || /^(alo|hello|hi|chào|xin chào)[.! ]*$/i.test(rawText)) {
    return {
      action: "ask_clarification",
      final_reply: "Dạ em chào anh/chị ạ 👋 Anh/chị đang quan tâm thiết bị phòng tắm, phòng bếp, quạt trần hay đèn trang trí để em gửi mẫu và báo giá phù hợp ạ?",
      should_request_contact: false,
      contact_benefit: "",
      products,
      intents,
      needs_slides: false,
      confidence: 0.82,
      reason: "Rule fallback: greeting or empty intent.",
      risk_flags: ["provider_unavailable"],
    };
  }

  if (/địa chỉ|ở đâu|showroom|cửa hàng/.test(text)) {
    return {
      action: "reply_text",
      final_reply: "Dạ showroom bên em tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội anh/chị nhé. Anh/chị đang ở khu vực nào để em gửi định vị và hướng dẫn đường đi cho tiện ạ?",
      should_request_contact: false,
      contact_benefit: "Gửi định vị và hướng dẫn đường đi.",
      products,
      intents,
      needs_slides: false,
      confidence: 0.96,
      reason: "Rule fallback: verified showroom address.",
      risk_flags: ["provider_unavailable"],
    };
  }

  const wantsSamples = intents.includes("samples") || /mẫu|hình|ảnh|xem/.test(text);
  if (products.length && wantsSamples && catalog.length) {
    return {
      action: "reply_with_slides",
      final_reply: `Dạ bên em có nhiều mẫu ${productLabel} ạ. Em gửi anh/chị một số mẫu đang được quan tâm để mình xem trước. Anh/chị cho em xin SĐT hoặc Zalo, bên em gửi giá và thông số chi tiết từng mẫu cho tiện nhé.`,
      should_request_contact: true,
      contact_benefit: "Gửi giá và thông số chi tiết từng mẫu.",
      products,
      intents,
      needs_slides: true,
      confidence: 0.84,
      reason: "Rule fallback: recognized product and sample intent.",
      risk_flags: ["provider_unavailable"],
    };
  }

  if (/giá|bao nhiêu|bn\b|báo giá/.test(text)) {
    return {
      action: "reply_text",
      final_reply: products.length
        ? `Dạ ${productLabel} có nhiều mẫu và mức giá khác nhau anh/chị ạ. Anh/chị cho em xin SĐT hoặc Zalo, bên em gửi báo giá chi tiết và ưu đãi theo đúng mẫu mình cần nhé.`
        : "Dạ anh/chị đang hỏi giá sản phẩm nào ạ? Anh/chị nhắn giúp em tên sản phẩm hoặc gửi ảnh mẫu; nếu tiện cho em xin SĐT/Zalo để bên em báo giá chi tiết và ưu đãi nhé.",
      should_request_contact: true,
      contact_benefit: "Gửi báo giá chi tiết và ưu đãi.",
      products,
      intents,
      needs_slides: false,
      confidence: 0.8,
      reason: "Rule fallback: price intent without verified price data.",
      risk_flags: ["provider_unavailable"],
    };
  }

  if (products.length) {
    return {
      action: catalog.length ? "reply_with_slides" : "reply_text",
      final_reply: `Dạ anh/chị đang quan tâm ${productLabel} đúng không ạ? Bên em có nhiều mẫu và phân khúc. Anh/chị cho em xin SĐT hoặc Zalo, bên em gửi mẫu, báo giá và tư vấn đúng nhu cầu cho mình nhé.`,
      should_request_contact: true,
      contact_benefit: "Gửi mẫu, báo giá và tư vấn đúng nhu cầu.",
      products,
      intents,
      needs_slides: Boolean(catalog.length),
      confidence: 0.78,
      reason: "Rule fallback: recognized product.",
      risk_flags: ["provider_unavailable"],
    };
  }

  return {
    action: "ask_clarification",
    final_reply: "Dạ anh/chị đang cần tư vấn hạng mục nào bên phòng tắm, phòng bếp, quạt trần hay đèn trang trí ạ? Anh/chị nói giúp em nhu cầu, em gửi mẫu và thông tin phù hợp nhé.",
    should_request_contact: false,
    contact_benefit: "",
    products,
    intents,
    needs_slides: false,
    confidence: 0.72,
    reason: "Rule fallback: unclear intent.",
    risk_flags: ["provider_unavailable"],
  };
}

async function heartbeat(status, error = null, details = {}) {
  const configs = await coreRest("v9_runtime_config?select=mode&id=eq.1&limit=1").catch(() => []);
  await coreRest("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: configs?.[0]?.mode || "SHADOW",
      details,
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function processOne(row, providerRows, knowledgeSnapshot) {
  const claimed = await coreRest(`v9_decisions?id=eq.${row.id}&status=eq.shadow_context_ready`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "shadow_ai_processing", updated_at: new Date().toISOString() },
  });
  if (!claimed?.length) return { processed: false, fallback: false, providerErrors: [] };

  const snapshot = row.input_snapshot || {};
  const contactCaptured = Boolean(snapshot?.turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);
  const selectedKnowledge = selectKnowledgeContext(knowledgeSnapshot, snapshot, {
    maxDocuments: 6,
    maxDocumentChars: 1800,
    maxCatalogNodes: 6,
    maxAssetsPerNode: 6,
  });
  const modelInput = { conversation: compactConversation(snapshot), knowledge: selectedKnowledge };
  const startedAt = Date.now();
  const providerErrors = [];
  let rawDecision = null;
  let usedProvider = null;
  let responseId = null;
  let usedModel = null;

  for (const ai of providerRows) {
    try {
      const result = await providerCall(ai, modelInput);
      rawDecision = result.decision;
      responseId = result.responseId;
      usedModel = result.model;
      usedProvider = ai.provider_key || ai.provider_type;
      providerCache.lastProviderKey = usedProvider;
      break;
    } catch (error) {
      providerErrors.push(`${ai.provider_key || ai.provider_type}:${String(error?.message || error).slice(0, 240)}`);
    }
  }

  let fallback = false;
  if (!rawDecision) {
    rawDecision = fallbackDecision(snapshot, selectedKnowledge);
    usedProvider = "rule_fallback";
    usedModel = "deterministic_v1";
    fallback = true;
  }

  try {
    const decision = validateDecision(rawDecision, { contactCaptured });
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
          response_id: responseId,
          model: usedModel,
          provider_key: usedProvider,
          provider_errors: providerErrors,
          fallback_used: fallback,
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
    return { processed: true, fallback, providerErrors };
  } catch (error) {
    await coreRest(`v9_decisions?id=eq.${row.id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_ai_error",
        output: {
          should_send: false,
          transport_locked: true,
          reason: "V9 multi-provider decision failed safely.",
          error: String(error?.message || error).slice(0, 800),
          provider_errors: providerErrors,
        },
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    throw error;
  }
}

async function tick() {
  if (!BASE || !KEY || !KNOWLEDGE_BASE || !KNOWLEDGE_KEY || running) return;
  running = true;
  let processed = 0;
  let errors = 0;
  let fallbacks = 0;
  let providerErrorCount = 0;
  let knowledgeSnapshot = null;
  try {
    const decisions = await coreRest(
      "v9_decisions?select=id,input_snapshot,status&status=eq.shadow_context_ready&order=created_at.asc&limit=3",
    );
    if (decisions?.length) {
      const [providerRows, knowledge] = await Promise.all([providers(), publishedKnowledge()]);
      knowledgeSnapshot = knowledge;
      for (const row of decisions) {
        try {
          const result = await processOne(row, providerRows, knowledge);
          if (result.processed) processed += 1;
          if (result.fallback) fallbacks += 1;
          providerErrorCount += result.providerErrors.length;
        } catch {
          errors += 1;
        }
      }
    }
    await heartbeat(errors ? "degraded" : "healthy", errors ? `${errors} decision(s) failed after provider fallback` : null, {
      processed_last_tick: processed,
      errors_last_tick: errors,
      fallbacks_last_tick: fallbacks,
      provider_errors_last_tick: providerErrorCount,
      knowledge_snapshot_id: knowledgeSnapshot?.id || knowledgeCache.snapshot?.id || null,
      knowledge_version: knowledgeSnapshot?.version_no ?? knowledgeCache.snapshot?.version_no ?? null,
      provider_key: providerCache.lastProviderKey,
      provider_priority: providerCache.rows.map((row) => row.provider_key || row.provider_type),
      transport_locked_at_decision_stage: true,
    });
  } catch (error) {
    await heartbeat("degraded", error?.message || error, {
      processed_last_tick: processed,
      errors_last_tick: errors,
      fallbacks_last_tick: fallbacks,
      knowledge_snapshot_id: knowledgeSnapshot?.id || knowledgeCache.snapshot?.id || null,
      transport_locked_at_decision_stage: true,
    }).catch(() => {});
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), POLL_MS);
    timer.unref?.();
  }
}

if (!BASE || !KEY || !KNOWLEDGE_BASE || !KNOWLEDGE_KEY) {
  console.warn("[AIGUKA V9 AI] Core or Knowledge configuration missing; disabled");
} else {
  console.log("[AIGUKA V9 AI] Gemini-first multi-provider engine started with deterministic fallback");
  tick().catch(() => {});
}
