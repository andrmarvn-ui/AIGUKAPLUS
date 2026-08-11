import crypto from "node:crypto";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function request(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 90_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`);
  return data;
}

const rpc = (name, body = {}) => request(`/rest/v1/rpc/${name}`, { method: "POST", body });
const rest = (path, options = {}) => request(`/rest/v1/${path}`, options);

function decryptProviderKey(value) {
  const [ivPart, tagPart, dataPart] = String(value || "").split(".");
  if (!ivPart || !tagPart || !dataPart) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
  const encryptionKey = crypto.createHash("sha256")
    .update(`${SERVICE_ROLE_KEY}|${SUPABASE_URL}|AIGUKA_AI_PROVIDER_KEYS_V1`)
    .digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
}

const INSTRUCTIONS = "Bạn là AIGUKA Follow-up Brain và là bên duy nhất quyết định có chăm sóc lại khách hay không. Đọc toàn bộ hội thoại. Chỉ nhắn khi khách chưa phản hồi, chưa có SĐT/Zalo và không có Sale chăm mới hơn. Tin tối đa 260 ký tự, tự nhiên, không lặp tin cũ, không gửi lại ảnh, không bịa giá, tồn kho, giao hàng hoặc bảo hành. Dùng đúng preferred_salutation. Có thể hỏi khách cần xem thêm mẫu, kích thước, kiểu dáng hoặc báo giá cụ thể. Chỉ xin SĐT/Zalo khi hợp ngữ cảnh. Nếu không phù hợp thì should_reply=false.";

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    should_reply: { type: "boolean" },
    final_reply: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    action_type: { type: "string" },
    should_request_contact: { type: "boolean" },
    reason: { type: "string" },
    risk_flags: { type: "array", items: { type: "string" }, maxItems: 8 },
  },
  required: ["should_reply", "final_reply", "confidence", "action_type", "should_request_contact", "reason", "risk_flags"],
};

const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    should_reply: { type: "BOOLEAN" },
    final_reply: { type: "STRING" },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
    action_type: { type: "STRING" },
    should_request_contact: { type: "BOOLEAN" },
    reason: { type: "STRING" },
    risk_flags: { type: "ARRAY", items: { type: "STRING" }, maxItems: 8 },
  },
  required: ["should_reply", "final_reply", "confidence", "action_type", "should_request_contact", "reason", "risk_flags"],
};

function context(prepared) {
  return {
    task: "scheduled_follow_up_after_silence",
    trigger: prepared.details,
    customer: prepared.customer,
    conversation_state: prepared.conversation_state,
    ai_memory: prepared.memory,
    conversation: prepared.conversation,
  };
}

function parseOpenAi(payload) {
  for (const output of payload?.output || []) {
    if (output?.type === "function_call" && output?.name === "submit_follow_up_decision") {
      return JSON.parse(output.arguments || "{}");
    }
  }
  throw new Error("MODEL_DID_NOT_SUBMIT_FOLLOW_UP_DECISION");
}

function parseJson(value) {
  const clean = String(value || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!clean) throw new Error("AI_PROVIDER_RETURNED_EMPTY_JSON");
  return JSON.parse(clean);
}

async function callOpenAi(provider, apiKey, prepared) {
  const base = String(provider.base_url || prepared.provider_base_url || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = String(provider.model_name || prepared.model_name || "");
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: `${INSTRUCTIONS} Bắt buộc gọi submit_follow_up_decision.`,
      tools: [{
        type: "function",
        name: "submit_follow_up_decision",
        strict: true,
        description: "Nộp quyết định chăm sóc lại.",
        parameters: JSON_SCHEMA,
      }],
      tool_choice: "required",
      parallel_tool_calls: false,
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(context(prepared)) }] }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
  if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `OPENAI_FOLLOW_UP_HTTP_${response.status}`);
  return { decision: parseOpenAi(payload), responseId: payload.id || null, model };
}

async function callGemini(provider, apiKey, prepared) {
  const base = String(provider.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const model = "gemini-2.0-flash"; // AIGUKA_GEMINI_FOLLOW_UP_JSON_STABILITY_V1
  const response = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${INSTRUCTIONS} Chỉ trả về JSON đúng schema.` }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(context(prepared)) }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
  if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `GEMINI_FOLLOW_UP_HTTP_${response.status}`);
  const generated = (payload?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join("");
  return { decision: parseJson(generated), responseId: payload?.responseId || null, model };
}

export async function dispatchFollowUpWithFallback(item) {
  const prepared = await rpc("v8_prepare_follow_up_ai_request", { p_request_id: item.id });
  if (!prepared?.ok || prepared?.skipped) return prepared;

  const rows = await rest(
    "v8_ai_providers?is_enabled=eq.true&select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled,connection_status",
  );
  const preferred = String(prepared.provider_key || "openai");
  const providers = (rows || [])
    .filter((provider) => provider?.api_key_ciphertext)
    .sort((a, b) => Number(b.provider_key === preferred) - Number(a.provider_key === preferred));
  if (!providers.length) throw new Error("NO_AI_PROVIDER_READY_FOR_FOLLOW_UP");

  const failures = [];
  for (const provider of providers) {
    try {
      const apiKey = decryptProviderKey(provider.api_key_ciphertext);
      const result = provider.provider_type === "gemini"
        ? await callGemini(provider, apiKey, prepared)
        : await callOpenAi(provider, apiKey, prepared);
      result.decision.provider_key = provider.provider_key;
      result.decision.provider_fallback_used = provider.provider_key !== preferred;
      result.decision.provider_failures_before_success = failures;
      const completed = await rpc("v8_complete_follow_up_ai_request", {
        p_request_id: item.id,
        p_decision: result.decision,
        p_model_name: result.model,
        p_response_id: result.responseId,
      });
      if (completed?.decision_id) {
        await rest(`v8_ai_decisions?id=eq.${encodeURIComponent(completed.decision_id)}`, {
          method: "PATCH",
          prefer: "return=minimal",
          body: { provider_key: provider.provider_key, model_name: result.model },
        });
      }
      return { ...completed, provider_key: provider.provider_key, fallback_used: provider.provider_key !== preferred };
    } catch (error) {
      failures.push({
        provider_key: provider.provider_key,
        error: String(error?.message || error).slice(0, 300),
      });
    }
  }
  throw new Error(`ALL_FOLLOW_UP_PROVIDERS_FAILED: ${JSON.stringify(failures)}`);
}
