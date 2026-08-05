const MARK = Symbol.for("aiguka.v10.sambanovaRuntimeAdapter.v1");

function isSambaResponses(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname.toLowerCase() === "api.sambanova.ai" && /\/responses\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "input_text" || item?.type === "text") return String(item.text || "");
    return "";
  }).join("");
}

function toChatBody(body = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  for (const item of body.input || []) {
    const content = textContent(item?.content);
    if (content) messages.push({ role: item?.role === "assistant" ? "assistant" : "user", content });
  }
  const tools = (body.tools || [])
    .filter((tool) => tool?.type === "function" && tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
      },
    }));
  return {
    model: body.model,
    messages,
    ...(tools.length ? { tools, tool_choice: "required" } : {}),
    max_tokens: Math.max(256, Math.min(2000, Number(process.env.AIGUKA_V10_SAMBANOVA_MAX_TOKENS || 1200))),
    temperature: 0,
    stream: false,
  };
}

function toResponses(payload = {}) {
  const message = payload?.choices?.[0]?.message || {};
  const output = (message.tool_calls || [])
    .filter((call) => call?.function?.name)
    .map((call) => ({
      type: "function_call",
      id: call.id || null,
      call_id: call.id || null,
      name: call.function.name,
      arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments || {}),
      status: "completed",
    }));
  return {
    id: payload.id || null,
    object: "response",
    created_at: payload.created || Math.floor(Date.now() / 1000),
    model: payload.model || null,
    output,
    usage: payload.usage || null,
  };
}

export function installSambaNovaRuntimeAdapter() {
  if (globalThis[MARK]) return globalThis[MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function sambaNovaFetch(input, init = {}) {
    if (!isSambaResponses(input)) return nativeFetch(input, init);
    const original = new URL(input instanceof Request ? input.url : String(input));
    original.pathname = original.pathname.replace(/\/responses\/?$/i, "/chat/completions");
    let body;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; }
    catch { body = null; }
    if (!body || typeof body !== "object") return nativeFetch(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("content-type", "application/json");
    const response = await nativeFetch(original, { ...init, headers, body: JSON.stringify(toChatBody(body)) });
    const raw = await response.text();
    if (!response.ok) return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    return new Response(JSON.stringify(toResponses(payload)), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  globalThis[MARK] = { version: "v1", host: "api.sambanova.ai", endpoint: "chat_completions" };
  console.log("[AIGUKA V10] SambaNova DeepSeek runtime adapter enabled");
  return globalThis[MARK];
}

installSambaNovaRuntimeAdapter();
