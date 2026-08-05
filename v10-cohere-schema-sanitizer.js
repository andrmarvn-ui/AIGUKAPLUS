const MARK = Symbol.for("aiguka.v10.cohereSchemaSanitizer.v1");

const UNSUPPORTED = new Set([
  "maxLength", "minLength", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
  "$schema", "$id", "$ref", "examples", "default",
]);

function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (UNSUPPORTED.has(key)) continue;
    out[key] = sanitizeSchema(item);
  }
  return out;
}

export function installCohereSchemaSanitizer() {
  if (globalThis[MARK]) return globalThis[MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function cohereSchemaFetch(input, init = {}) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { return nativeFetch(input, init); }
    if (url.hostname.toLowerCase() !== "api.cohere.ai" || !/\/v2\/chat\/?$/i.test(url.pathname)) {
      return nativeFetch(input, init);
    }
    let body;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; }
    catch { body = null; }
    if (!body || typeof body !== "object") return nativeFetch(input, init);
    const tools = (body.tools || []).map((tool) => {
      if (!tool?.function) return tool;
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: sanitizeSchema(tool.function.parameters || { type: "object", properties: {} }),
        },
      };
    });
    return nativeFetch(input, {
      ...init,
      body: JSON.stringify({ ...body, tools, strict_tools: tools.length > 0 }),
    });
  };
  globalThis[MARK] = { version: "v1", endpoint: "api.cohere.ai/v2/chat" };
  console.log("[AIGUKA V10] Cohere strict tool schema sanitizer enabled");
  return globalThis[MARK];
}

installCohereSchemaSanitizer();
