const PATCH_MARK = Symbol.for("aiguka.v10.openaiCompatibleResponsesAdapter.v1");
const COMPATIBLE_HOSTS = new Set(["api.moonshot.ai", "openrouter.ai"]);

export function isCompatibleResponsesUrl(input) {
  try {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    return COMPATIBLE_HOSTS.has(url.hostname.toLowerCase()) && /\/responses\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function inputText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "input_text" || item?.type === "text") return String(item.text || "");
    return "";
  }).join("");
}

export function toChatCompletionsBody(body = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  for (const item of body.input || []) {
    const content = inputText(item?.content);
    if (!content) continue;
    messages.push({ role: item?.role === "assistant" ? "assistant" : "user", content });
  }

  const tools = (body.tools || [])
    .filter((tool) => tool?.type === "function" && tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
        ...(tool.strict === undefined ? {} : { strict: Boolean(tool.strict) }),
      },
    }));

  return {
    model: body.model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice === "required" ? "required" : body.tool_choice } : {}),
    ...(body.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: Boolean(body.parallel_tool_calls) }),
  };
}

export function toResponsesPayload(payload = {}) {
  const message = payload?.choices?.[0]?.message || {};
  const output = [];
  for (const call of message.tool_calls || []) {
    if (call?.type !== "function" || !call?.function?.name) continue;
    output.push({
      type: "function_call",
      id: call.id || null,
      call_id: call.id || null,
      name: call.function.name,
      arguments: call.function.arguments || "{}",
      status: "completed",
    });
  }
  return {
    id: payload.id || null,
    object: "response",
    created_at: payload.created || Math.floor(Date.now() / 1000),
    model: payload.model || null,
    output,
    usage: payload.usage || null,
  };
}

export function installOpenAICompatibleResponsesAdapter() {
  if (globalThis[PATCH_MARK]) return globalThis[PATCH_MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);

  async function adaptedFetch(input, init = {}) {
    if (!isCompatibleResponsesUrl(input)) return nativeFetch(input, init);

    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    const chatUrl = new URL(requestUrl.toString());
    chatUrl.pathname = chatUrl.pathname.replace(/\/responses\/?$/i, "/chat/completions");

    let body;
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object") return nativeFetch(input, init);

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("content-type", "application/json");
    if (requestUrl.hostname.toLowerCase() === "openrouter.ai") {
      const referer = String(process.env.OPENROUTER_HTTP_REFERER || process.env.AIGUKA_PUBLIC_URL || "").trim();
      const title = String(process.env.OPENROUTER_X_TITLE || "AIGUKA").trim();
      if (referer) headers.set("HTTP-Referer", referer);
      if (title) headers.set("X-Title", title);
    }

    const response = await nativeFetch(chatUrl, {
      ...init,
      headers,
      body: JSON.stringify(toChatCompletionsBody(body)),
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { payload = null; }

    if (!response.ok || !payload) {
      return new Response(raw, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return new Response(JSON.stringify(toResponsesPayload(payload)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  globalThis.fetch = adaptedFetch;
  globalThis[PATCH_MARK] = { version: "v1", hosts: [...COMPATIBLE_HOSTS] };
  console.log("[AIGUKA V10] OpenAI-compatible /responses adapter v1 enabled for KIMI and OpenRouter");
  return globalThis[PATCH_MARK];
}

installOpenAICompatibleResponsesAdapter();
