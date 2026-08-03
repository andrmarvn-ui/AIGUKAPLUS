const MARK = Symbol.for("aiguka.v10.providerRuntimePolicy.v2");

function isProviderQuery(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return /\/rest\/v1\/ai_providers$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function withRuntimeFields(input) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const select = new Set(String(url.searchParams.get("select") || "").split(",").map((x) => x.trim()).filter(Boolean));
  for (const field of ["settings", "connection_status", "last_error", "last_verified_at"]) select.add(field);
  url.searchParams.set("select", [...select].join(","));
  return url;
}

function priority(row) {
  const value = Number(row?.settings?.runtime_order ?? 100);
  return Number.isFinite(value) ? Math.max(1, value) : 100;
}

function ready(row) {
  const smoke = row?.settings?.smoke_test;
  if (!row?.is_enabled) return false;
  if (row?.connection_status === "error") return false;
  if (smoke && smoke.ok === false) return false;
  return true;
}

function providerRows(value) {
  return Array.isArray(value) && value.length > 0 && value.every((row) => row && typeof row === "object" && row.provider_key && row.api_key_ciphertext);
}

export function installProviderRuntimePolicy() {
  if (globalThis[MARK]) return globalThis[MARK];
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const nativeSort = Array.prototype.sort;

  globalThis.fetch = async function providerPolicyFetch(input, init = {}) {
    if (!isProviderQuery(input)) return nativeFetch(input, init);
    const requestUrl = withRuntimeFields(input);
    const response = await nativeFetch(requestUrl, init);
    if (!response.ok) return response;
    const raw = await response.text();
    let rows;
    try { rows = raw ? JSON.parse(raw) : []; } catch { return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    if (!Array.isArray(rows)) return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });

    const sorted = nativeSort.call(rows.filter(ready), (a, b) => priority(a) - priority(b) || String(a.provider_key || "").localeCompare(String(b.provider_key || "")));
    return new Response(JSON.stringify(sorted), { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  Array.prototype.sort = function aigukaProviderAwareSort(compareFn) {
    if (providerRows(this)) {
      return nativeSort.call(this, (a, b) => priority(a) - priority(b) || String(a.provider_key || "").localeCompare(String(b.provider_key || "")));
    }
    return nativeSort.call(this, compareFn);
  };

  globalThis[MARK] = { version: "v2", source: "/ai-providers", priority: "settings.runtime_order", productionGate: "smoke_test", schedulerOverride: true };
  console.log("[AIGUKA V10] provider runtime policy v2 enabled: /ai-providers priority overrides legacy Gemini-first sorting");
  return globalThis[MARK];
}

installProviderRuntimePolicy();
