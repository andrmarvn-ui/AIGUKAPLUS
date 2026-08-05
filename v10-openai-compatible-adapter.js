const PATCH_MARK = Symbol.for("aiguka.v10.openaiCompatibleResponsesAdapter.v4");
const COMPATIBLE_HOSTS = new Set([
  "api.moonshot.ai",
  "openrouter.ai",
  "api.deepseek.com",
  "api.cohere.ai",
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

export function toChatCompletionsBody(body = {}, options = {}) {
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
        ...(tool.strict === true ? { strict: true } : {}),
      },
    }));

  const cohereCompatibility = options.cohereCompatibility === true;
  const toolChoice = normalizeToolChoice(body.tool_choice);
  return {
    model: body.model,
    messages,
    max_tokens: compatibleMaxTokens(),
    ...(tools.length ? { tools } : {}),
    // Cohere's OpenAI Compatibility API supports tools but rejects tool_choice.
    ...(!cohereCompatibility && toolChoice ? { tool_choice: toolChoice } : {}),
    // Cohere explicitly lists parallel_tool_calls as unsupported.
    ...(!cohereCompatibility && typeof body.parallel_tool_calls === "boolean"
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(cohereCompatibility ? { reasoning_effort: "none", temperature: 0 } : {}),
  };
}

export function toResponsesPayload(payload = {}, fallbackToolName = "") {
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

  // Some OpenAI-compatible providers may return the requested JSON in message.content
  // instead of tool_calls. Preserve the V10 contract only when the content is valid JSON.
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
        // Keep output empty; the worker will fail over to another provider.
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

    const hostname = requestUrl.hostname.toLowerCase();
    const cohereCompatibility = hostname === "api.cohere.ai";
    const fallbackToolName = String((body.tools || []).find((tool) => tool?.type === "function" && tool?.name)?.name || "");

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("content-type", "application/json");
    if (hostname === "openrouter.ai") {
      const referer = String(process.env.OPENROUTER_HTTP_REFERER || process.env.AIGUKA_PUBLIC_URL || "").trim();
      const title = String(process.env.OPENROUTER_X_TITLE || "AIGUKA").trim();
      if (referer) headers.set("HTTP-Referer", referer);
      if (title) headers.set("X-Title", title);
    }

    const response = await nativeFetch(chatUrl, {
      ...init,
      headers,
      body: JSON.stringify(toChatCompletionsBody(body, { cohereCompatibility })),
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

    return new Response(JSON.stringify(toResponsesPayload(payload, fallbackToolName)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  globalThis.fetch = adaptedFetch;
  globalThis[PATCH_MARK] = {
    version: "v4",
    hosts: [...COMPATIBLE_HOSTS],
    maxTokens: compatibleMaxTokens(),
    cohereCompatibility: "omit_tool_choice_and_parallel_tool_calls",
  };
  console.log(`[AIGUKA V10] OpenAI-compatible /responses adapter v4 enabled; hosts=${[...COMPATIBLE_HOSTS].join(",")}; max_tokens=${compatibleMaxTokens()}`);
  return globalThis[PATCH_MARK];
}

installOpenAICompatibleResponsesAdapter();
