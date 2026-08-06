const MARK = Symbol.for("aiguka.v10.tokenRouterRuntimeAdapter.v1");
const DEFAULT_MAX_TOKENS = 1200;

function isTokenRouterResponsesUrl(input) {
  try {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    return url.hostname.toLowerCase() === "api.tokenrouter.com" && /\/responses\/?$/i.test(url.pathname);
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

function messagesFromResponses(body = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  for (const item of body.input || []) {
    const content = inputText(item?.content);
    if (!content) continue;
    messages.push({ role: item?.role === "assistant" ? "assistant" : "user", content });
  }
  return messages;
}

function toolsFromResponses(body = {}) {
  return (body.tools || [])
    .filter((tool) => tool?.type === "function" && tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool.name),
        description: String(tool.description || ""),
        parameters: tool.parameters || { type: "object", properties: {}, required: [] },
      },
    }));
}

function normalizeToolChoice(choice) {
  if (!choice) return undefined;
  if (["none", "auto", "required"].includes(choice)) return choice;
  if (choice?.type === "function" && choice?.name) {
    return { type: "function", function: { name: String(choice.name) } };
  }
  if (choice?.type === "function" && choice?.function?.name) return choice;
  return choice;
}

function maxTokens() {
  const parsed = Number(process.env.AIGUKA_TOKENROUTER_MAX_TOKENS || DEFAULT_MAX_TOKENS);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOKENS;
  return Math.max(256, Math.min(4000, Math.floor(parsed)));
}

function toChatBody(body = {}) {
  const tools = toolsFromResponses(body);
  return {
    model: body.model,
    messages: messagesFromResponses(body),
    max_tokens: maxTokens(),
    stream: false,
    reasoning_effort: "low",
    ...(tools.length ? { tools } : {}),
    ...(tools.length ? { tool_choice: normalizeToolChoice(body.tool_choice) || "required" } : {}),
    parallel_tool_calls: false,
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

function toResponsesPayload(payload = {}, fallbackToolName = "") {
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
      } catch {}
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

export function installTokenRouterRuntimeAdapter() {
  if (globalThis[MARK]) return globalThis[MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function tokenRouterFetch(input, init = {}) {
    if (!isTokenRouterResponsesUrl(input)) return nativeFetch(input, init);

    let body;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; }
    catch { body = null; }
    if (!body || typeof body !== "object") return nativeFetch(input, init);

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("content-type", "application/json");

    const response = await nativeFetch("https://api.tokenrouter.com/v1/chat/completions", {
      ...init,
      headers,
      body: JSON.stringify(toChatBody(body)),
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
    return new Response(JSON.stringify(toResponsesPayload(payload, fallbackToolName)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  globalThis[MARK] = {
    version: "v1",
    endpoint: "https://api.tokenrouter.com/v1/chat/completions",
    reasoningEffort: "low",
    toolChoice: "required",
    strictSchema: false,
  };
  console.log("[AIGUKA V10] TokenRouter Kimi K3 adapter v1 enabled");
  return globalThis[MARK];
}

installTokenRouterRuntimeAdapter();
