const PATCH_MARK = Symbol.for("aiguka.v10.openaiCompatibleResponsesAdapter.v8");
const COMPATIBLE_HOSTS = new Set([
  "api.moonshot.ai",
  "openrouter.ai",
  "api.deepseek.com",
  "api.cohere.ai",
  "api.tokenrouter.com",
]);
const DEFAULT_MAX_TOKENS = 1200;

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

function responseMessages(body = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  for (const item of body.input || []) {
    const content = inputText(item?.content);
    if (!content) continue;
    messages.push({ role: item?.role === "assistant" ? "assistant" : "user", content });
  }
  return messages;
}

function responseTools(body = {}) {
  return (body.tools || [])
    .filter((tool) => tool?.type === "function" && tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || { type: "object", properties: {} },
        ...(tool.strict === true ? { strict: true } : {}),
      },
    }));
}

export function compatibleMaxTokens(value = process.env.AIGUKA_V10_COMPAT_MAX_TOKENS) {
  const parsed = Number(value || DEFAULT_MAX_TOKENS);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS;
  return Math.max(256, Math.min(4000, Math.floor(parsed)));
}

function normalizeToolChoice(choice) {
  if (!choice) return undefined;
  if (choice === "required" || choice === "auto" || choice === "none") return choice;
  if (choice?.type === "function" && choice?.name) {
    return { type: "function", function: { name: String(choice.name) } };
  }
  if (choice?.type === "function" && choice?.function?.name) return choice;
  return choice;
}

export function toChatCompletionsBody(body = {}) {
  const tools = responseTools(body);
  const toolChoice = normalizeToolChoice(body.tool_choice);
  return {
    model: body.model,
    messages: responseMessages(body),
    max_tokens: compatibleMaxTokens(),
    stream: false,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(typeof body.parallel_tool_calls === "boolean" ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
  };
}

export function toCohereV2Body(body = {}) {
  const tools = responseTools(body).map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
  return {
    model: body.model,
    messages: responseMessages(body),
    stream: false,
    max_tokens: compatibleMaxTokens(),
    temperature: 0,
    ...(tools.length ? {
      tools,
      strict_tools: true,
      tool_choice: "REQUIRED",
    } : {}),
  };
}

function functionOutput(call = {}) {
  const args = call?.function?.arguments;
  return {
    type: "function_call",
    id: call.id || null,
    call_id: call.id || null,
    name: call?.function?.name || "",
    arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
    status: "completed",
  };
}

export function toResponsesPayload(payload = {}, fallbackToolName = "") {
  const message = payload?.choices?.[0]?.message || {};
  const output = (message.tool_calls || [])
    .filter((call) => call?.type === "function" && call?.function?.name)
    .map(functionOutput);

  if (!output.length && fallbackToolName && typeof message.content === "string") {
    const text = message.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    if (text.startsWith("{") && text.endsWith("}")) {
      try {
        JSON.parse(text);
        output.push({
          type: "function_call",
          id: payload.id || null,
          call_id: payload.id || null,
          name: fallbackToolName,
          arguments: text,
          status: "completed",
        });
      } catch {
        // Leave empty so the worker can fail over.
      }
    }
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

export function cohereV2ToResponsesPayload(payload = {}) {
  const calls = payload?.message?.tool_calls || [];
  return {
    id: payload.id || null,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: payload.model || null,
    output: calls.filter((call) => call?.function?.name).map(functionOutput),
    usage: payload.usage || null,
  };
}

export function installOpenAICompatibleResponsesAdapter() {
  if (globalThis[PATCH_MARK]) return globalThis[PATCH_MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);

  async function adaptedFetch(input, init = {}) {
    if (!isCompatibleResponsesUrl(input)) return nativeFetch(input, init);

    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    let body;
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object") return nativeFetch(input, init);

    const hostname = requestUrl.hostname.toLowerCase();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("content-type", "application/json");

    let targetUrl;
    let requestBody;
    let cohereNative = false;
    if (hostname === "api.cohere.ai") {
      targetUrl = new URL("https://api.cohere.ai/v2/chat");
      requestBody = toCohereV2Body(body);
      cohereNative = true;
      headers.set("X-Client-Name", "AIGUKA");
    } else {
      targetUrl = new URL(requestUrl.toString());
      targetUrl.pathname = targetUrl.pathname.replace(/\/responses\/?$/i, "/chat/completions");
      requestBody = toChatCompletionsBody(body);
    }

    if (hostname === "api.tokenrouter.com") {
      // TokenRouter Kimi K3 currently uses Chat Completions. Keep the schema portable:
      // its free route may reject the OpenAI-only `strict` extension.
      requestBody.tools = (requestBody.tools || []).map((tool) => ({
        ...tool,
        function: tool?.function ? (({ strict, ...fn }) => fn)(tool.function) : tool.function,
      }));
      requestBody.parallel_tool_calls = false;
    }

    if (hostname === "openrouter.ai") {
      const referer = String(process.env.OPENROUTER_HTTP_REFERER || process.env.AIGUKA_PUBLIC_URL || "").trim();
      const title = String(process.env.OPENROUTER_X_TITLE || "AIGUKA").trim();
      if (referer) headers.set("HTTP-Referer", referer);
      if (title) headers.set("X-Title", title);
    }

    const response = await nativeFetch(targetUrl, {
      ...init,
      headers,
      body: JSON.stringify(requestBody),
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

    const fallbackToolName = String((body.tools || []).find((tool) => tool?.type === "function" && tool?.name)?.name || "");
    const normalized = cohereNative
      ? cohereV2ToResponsesPayload(payload)
      : toResponsesPayload(payload, fallbackToolName);

    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  globalThis.fetch = adaptedFetch;
  globalThis[PATCH_MARK] = {
    version: "v8",
    hosts: [...COMPATIBLE_HOSTS],
    maxTokens: compatibleMaxTokens(),
    cohereCompatibility: "native_v2_chat_strict_tools_required",
    tokenRouterCompatibility: "chat_completions_required_tool_without_strict",
  };
  console.log(`[AIGUKA V10] OpenAI-compatible adapter v8 enabled; hosts=${[...COMPATIBLE_HOSTS].join(",")}`);
  return globalThis[PATCH_MARK];
}

installOpenAICompatibleResponsesAdapter();
