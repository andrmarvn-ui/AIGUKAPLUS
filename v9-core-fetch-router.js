// V10 Core routing must not mutate AI prompts, catalog knowledge or outbound business
// behavior. The old conversation-quality / hierarchical runtime patch chain is retired:
// - conversation-quality reintroduced latest-intent priority and rewrote prompts/output;
// - hierarchical-knowledge is superseded by committed hierarchy-aware knowledge-advisor;
// - hierarchical resolver is superseded by the final media-obligation resolver.
// Core router now owns routing only.

const ROUTER_MARK = Symbol.for("aiguka.v9.core.fetch.router");
const DEFAULT_CORE_URL = "https://xqcxckyrlsobdrnidtrp.supabase.co";

function cleanBase(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function urlFromInput(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(String(input));
  if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
  return null;
}

export function isV9CoreRequest(input, legacyBase) {
  const url = urlFromInput(input);
  const legacy = cleanBase(legacyBase);
  if (!url || !legacy) return false;
  const legacyUrl = new URL(legacy);
  if (url.origin !== legacyUrl.origin) return false;
  return /^\/rest\/v1\/(?:rpc\/)?v9_[a-z0-9_]+(?:\?|$)/i.test(`${url.pathname}${url.search}`);
}

export function buildV9CoreTarget(input, options = {}) {
  const legacyBase = cleanBase(options.legacyBase);
  const coreBase = cleanBase(options.coreBase || DEFAULT_CORE_URL);
  const coreKey = String(options.coreKey || "").trim();
  if (!coreKey || !isV9CoreRequest(input, legacyBase)) return null;
  const source = urlFromInput(input);
  return {
    url: `${coreBase}${source.pathname}${source.search}`,
    coreKey,
  };
}

export function classifyV9CoreRequest(input, options = {}) {
  const legacyBase = cleanBase(options.legacyBase);
  const coreBase = cleanBase(options.coreBase || DEFAULT_CORE_URL);
  const coreKey = String(options.coreKey || "").trim();
  if (!isV9CoreRequest(input, legacyBase)) return { action: "passthrough" };
  if (!coreBase || !coreKey) return { action: "block", reason: "V9_CORE_CREDENTIAL_REQUIRED" };
  const target = buildV9CoreTarget(input, { legacyBase, coreBase, coreKey });
  return { action: "route", ...target };
}

function routedHeaders(input, init, coreKey) {
  const baseHeaders = typeof Request !== "undefined" && input instanceof Request ? input.headers : init?.headers;
  const headers = new Headers(baseHeaders || {});
  headers.set("apikey", coreKey);
  headers.set("authorization", `Bearer ${coreKey}`);
  return headers;
}

export function installV9CoreFetchRouter(options = {}) {
  if (globalThis[ROUTER_MARK]) return globalThis[ROUTER_MARK];
  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (!originalFetch) throw new Error("V9_CORE_FETCH_UNAVAILABLE");

  const legacyBase = cleanBase(options.legacyBase || process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL);
  const coreBase = cleanBase(options.coreBase || process.env.AIGUKA_V9_CORE_URL || DEFAULT_CORE_URL);
  const coreKey = String(options.coreKey || process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "").trim();

  const state = {
    enabled: Boolean(legacyBase && coreBase && coreKey),
    blocked: Boolean(legacyBase && (!coreBase || !coreKey)),
    legacyBase,
    coreBase,
    fetch: originalFetch,
    responsibility: "routing_only",
    retired_runtime_business_patches: true,
  };

  globalThis.fetch = async function v9CoreRoutedFetch(input, init = {}) {
    const decision = classifyV9CoreRequest(input, { legacyBase, coreBase, coreKey });
    if (decision.action === "passthrough") return originalFetch(input, init);
    if (decision.action === "block") {
      throw new Error("V9_CORE_CREDENTIAL_REQUIRED: refusing legacy v9_* access");
    }

    const headers = routedHeaders(input, init, decision.coreKey);
    if (typeof Request !== "undefined" && input instanceof Request) {
      const request = new Request(decision.url, input);
      return originalFetch(request, { ...init, headers });
    }
    return originalFetch(decision.url, { ...init, headers });
  };

  globalThis[ROUTER_MARK] = state;
  if (state.enabled) {
    console.log(`[AIGUKA V9 Core] isolated routing enabled: ${new URL(coreBase).host}; legacy business patch chain retired`);
  } else {
    console.warn("[AIGUKA V9 Core] routing blocked: AIGUKA_V9_CORE_SERVICE_ROLE_KEY is missing; legacy v9_* access denied");
  }
  return state;
}

export const v9CoreRoutingState = installV9CoreFetchRouter();
