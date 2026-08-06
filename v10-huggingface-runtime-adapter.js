const PATCH_MARK = Symbol.for("aiguka.v10.huggingFaceRuntimeAdapter.v1");

function inputText(content) {
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
    const content = inputText(item?.content);
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
    max_tokens: 1200,
    stream: false,
    ...(tools.length ? { tools, tool_choice: "required" } : {}),
  };
}

function normalize(payload = {}, fallbackToolName = "") {
  const message = payload?.choices?.[0]?.message || {};
  const output = (message.tool_calls || [])
    .filter((call) => call?.type === "function" && call?.function?.name)
    .map((call) => ({
      type: "function_call",
      id: call.id || null,
      call_id: call.id || null,
      name: call.function.name,
      arguments: typeof call.function.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function.arguments || {}),
      status: "completed",
    }));

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

export function installHuggingFaceRuntimeAdapter() {
  if (globalThis[PATCH_MARK]) return globalThis[PATCH_MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function huggingFaceFetch(input, init = {}) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { return nativeFetch(input, init); }

    if (url.hostname.toLowerCase() !== "router.huggingface.co" || !/\/v1\/responses\/?$/i.test(url.pathname)) {
      return nativeFetch(input, init);
    }

    let body;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; }
    catch { body = null; }
    if (!body || typeof body !== "object") return nativeFetch(input, init);

    const target = new URL("https://router.huggingface.co/v1/chat/completions");
    const response = await nativeFetch(target, {
      ...init,
      headers: { ...(init.headers || {}), "content-type": "application/json" },
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
    return new Response(JSON.stringify(normalize(payload, fallbackToolName)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  globalThis[PATCH_MARK] = {
    version: "v1",
    endpoint: "https://router.huggingface.co/v1/chat/completions",
    toolChoice: "required",
  };
  console.log("[AIGUKA V10] Hugging Face router adapter v1 enabled");
  return globalThis[PATCH_MARK];
}

installHuggingFaceRuntimeAdapter();
