import { toChatCompletionsBody, toResponsesPayload } from "./v10-openai-compatible-adapter.js";

const PATCH_MARK = Symbol.for("aiguka.v10.beeknoeeRuntimeAdapter.v1");
const HOST = "platform.beeknoee.com";

function isBeeknoeeResponses(input) {
  try {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    return url.hostname.toLowerCase() === HOST && /\/responses\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function cleanToolSchema(tool) {
  if (!tool?.function) return tool;
  const { strict, ...fn } = tool.function;
  return { ...tool, function: fn };
}

function fallbackToolName(body = {}) {
  return String((body.tools || []).find((tool) => tool?.type === "function" && tool?.name)?.name || "");
}

function fallbackToolSchema(body = {}) {
  const tool = (body.tools || []).find((item) => item?.type === "function" && item?.name);
  return tool?.parameters || { type: "object", properties: {} };
}

async function readJson(response) {
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
  return { raw, payload };
}

export function installBeeknoeeRuntimeAdapter() {
  if (globalThis[PATCH_MARK]) return globalThis[PATCH_MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function beeknoeeFetch(input, init = {}) {
    if (!isBeeknoeeResponses(input)) return nativeFetch(input, init);

    let body;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; }
    catch { body = null; }
    if (!body || typeof body !== "object") return nativeFetch(input, init);

    const sourceUrl = new URL(input instanceof Request ? input.url : String(input));
    const targetUrl = new URL(sourceUrl.toString());
    targetUrl.pathname = targetUrl.pathname.replace(/\/responses\/?$/i, "/chat/completions");

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("content-type", "application/json");

    const toolName = fallbackToolName(body);
    const requestBody = toChatCompletionsBody(body);
    requestBody.tools = (requestBody.tools || []).map(cleanToolSchema);
    if (requestBody.tool_choice === "required") requestBody.tool_choice = "auto";
    delete requestBody.parallel_tool_calls;
    requestBody.temperature = 0;

    let response = await nativeFetch(targetUrl, {
      ...init,
      headers,
      body: JSON.stringify(requestBody),
    });
    let { raw, payload } = await readJson(response);
    if (!response.ok || !payload) {
      return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    let normalized = toResponsesPayload(payload, toolName);
    if (!normalized.output?.length && toolName) {
      const schema = fallbackToolSchema(body);
      const jsonBody = {
        model: body.model,
        messages: [
          ...(requestBody.messages || []),
          {
            role: "system",
            content: `Return ONLY one valid JSON object matching this schema for ${toolName}. Do not add markdown or explanation. Schema: ${JSON.stringify(schema)}`,
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: requestBody.max_tokens,
        temperature: 0,
        stream: false,
      };
      response = await nativeFetch(targetUrl, {
        ...init,
        headers,
        body: JSON.stringify(jsonBody),
      });
      ({ raw, payload } = await readJson(response));
      if (!response.ok || !payload) {
        return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      normalized = toResponsesPayload(payload, toolName);
    }

    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  globalThis[PATCH_MARK] = {
    version: "v1",
    host: HOST,
    transport: "responses_to_chat_completions",
    toolChoice: "auto",
    strictTools: false,
    jsonFallback: true,
  };
  console.log("[AIGUKA V10] Beeknoee GLM adapter v1 enabled");
  return globalThis[PATCH_MARK];
}

installBeeknoeeRuntimeAdapter();
