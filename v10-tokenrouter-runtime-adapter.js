const MARK = Symbol.for("aiguka.v10.tokenRouterRuntimeAdapter.v2");
const DEFAULT_MAX_TOKENS = 1200;
const TOKENROUTER_HOST = "api.tokenrouter.com";

function requestUrl(input) {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
}

function tokenRouterRequestKind(input) {
  const url = requestUrl(input);
  if (!url || url.hostname.toLowerCase() !== TOKENROUTER_HOST) return null;
  if (/\/responses\/?$/i.test(url.pathname)) return "responses";
  if (/\/chat\/completions\/?$/i.test(url.pathname)) return "chat";
  return null;
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

function fallbackInstruction(toolName) {
  if (!toolName) return "";
  return `If native tool calling is unavailable on this route, return only the valid JSON arguments for ${toolName}, without markdown or explanation.`;
}

function toChatBody(body = {}) {
  const tools = toolsFromResponses(body);
  const fallbackToolName = String(tools[0]?.function?.name || "");
  const messages = messagesFromResponses(body);
  if (fallbackToolName) {
    messages.unshift({ role: "system", content: fallbackInstruction(fallbackToolName) });
  }
  return {
    model: body.model,
    messages,
    max_tokens: maxTokens(),
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: "low",
    ...(tools.length ? { tools } : {}),
    ...(tools.length ? { tool_choice: normalizeToolChoice(body.tool_choice) || "required" } : {}),
  };
}

function toStreamingChatBody(body = {}) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const fallbackToolName = String(tools.find((tool) => tool?.type === "function")?.function?.name || "");
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (fallbackToolName) {
    messages.unshift({ role: "system", content: fallbackInstruction(fallbackToolName) });
  }
  return {
    ...body,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: body.reasoning_effort || "low",
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

function appendToolCall(target, fragment = {}) {
  const index = Number.isInteger(fragment.index) ? fragment.index : 0;
  if (!target[index]) {
    target[index] = {
      id: fragment.id || null,
      type: fragment.type || "function",
      function: { name: "", arguments: "" },
    };
  }
  const current = target[index];
  if (fragment.id) current.id = fragment.id;
  if (fragment.type) current.type = fragment.type;
  if (fragment.function?.name) current.function.name += fragment.function.name;
  if (fragment.function?.arguments) current.function.arguments += fragment.function.arguments;
}

async function readStreamingChat(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; }
    catch { parsed = null; }
    return { raw, payload: parsed };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let id = null;
  let model = null;
  let created = Math.floor(Date.now() / 1000);
  let finishReason = null;
  let usage = null;
  const toolCalls = [];

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const data = trimmed.slice(5).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    let chunk;
    try { chunk = JSON.parse(data); }
    catch { return false; }
    id ||= chunk.id || null;
    model ||= chunk.model || null;
    created = chunk.created || created;
    usage = chunk.usage || usage;
    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    for (const fragment of delta.tool_calls || []) appendToolCall(toolCalls, fragment);
    if (choice.finish_reason) finishReason = choice.finish_reason;
    return false;
  };

  let done = false;
  while (!done) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (consumeLine(line)) {
        done = true;
        break;
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);

  const completedCalls = toolCalls.filter(Boolean).map((call) => ({
    id: call.id,
    type: call.type || "function",
    function: {
      name: call.function?.name || "",
      arguments: call.function?.arguments || "",
    },
  }));

  return {
    raw: null,
    payload: {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(completedCalls.length ? { tool_calls: completedCalls } : {}),
        },
        finish_reason: finishReason || (completedCalls.length ? "tool_calls" : "stop"),
      }],
      usage,
    },
  };
}

export function installTokenRouterRuntimeAdapter() {
  if (globalThis[MARK]) return globalThis[MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function tokenRouterFetch(input, init = {}) {
    const kind = tokenRouterRequestKind(input);
    if (!kind) return nativeFetch(input, init);

    let body;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; }
    catch { body = null; }
    if (!body || typeof body !== "object") return nativeFetch(input, init);

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");

    const sourceWasResponses = kind === "responses";
    const requestBody = sourceWasResponses ? toChatBody(body) : toStreamingChatBody(body);
    const response = await nativeFetch("https://api.tokenrouter.com/v1/chat/completions", {
      ...init,
      headers,
      body: JSON.stringify(requestBody),
    });
    const { raw, payload } = await readStreamingChat(response);

    if (!response.ok || !payload) {
      return new Response(raw || "", {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (!sourceWasResponses) {
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": "application/json" },
      });
    }

    const fallbackToolName = String((body.tools || []).find((tool) => tool?.type === "function" && tool?.name)?.name || "");
    return new Response(JSON.stringify(toResponsesPayload(payload, fallbackToolName)), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "application/json" },
    });
  };

  globalThis[MARK] = {
    version: "v2",
    endpoint: "https://api.tokenrouter.com/v1/chat/completions",
    transport: "streaming_sse_aggregated",
    reasoningEffort: "low",
    toolChoice: "required_with_json_fallback",
    strictSchema: false,
  };
  console.log("[AIGUKA V10] TokenRouter Kimi K3 adapter v2 enabled with streaming SSE aggregation");
  return globalThis[MARK];
}

installTokenRouterRuntimeAdapter();
