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
    legacyBase,
    coreBase,
    fetch: originalFetch,
  };

  if (!state.enabled) {
    console.warn("[AIGUKA V9 Core] isolated database routing disabled: AIGUKA_V9_CORE_SERVICE_ROLE_KEY is missing");
    globalThis[ROUTER_MARK] = state;
    return state;
  }

  globalThis.fetch = async function v9CoreRoutedFetch(input, init = {}) {
    const target = buildV9CoreTarget(input, { legacyBase, coreBase, coreKey });
    if (!target) return originalFetch(input, init);

    const headers = routedHeaders(input, init, target.coreKey);
    if (typeof Request !== "undefined" && input instanceof Request) {
      const request = new Request(target.url, input);
      return originalFetch(request, { ...init, headers });
    }
    return originalFetch(target.url, { ...init, headers });
  };

  globalThis[ROUTER_MARK] = state;
  console.log(`[AIGUKA V9 Core] isolated routing enabled: ${new URL(coreBase).host}`);
  return state;
}

installV9CoreFetchRouter();
