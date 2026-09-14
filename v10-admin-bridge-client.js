const clean = (value) => String(value ?? "").trim();
const BRIDGE_FETCH_MARK = Symbol.for("aiguka.v9.core.database.bridge.fetch");

export function createV10AdminBridgeClient(options = {}) {
  const base = clean(process.env.AIGUKA_V9_CORE_URL || options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
  const endpoint = base ? `${base}/functions/v1/aiguka-v10-admin-bridge` : "";

  async function call(op, args = {}, timeoutMs = 45_000) {
    if (!endpoint || !bridgeKey) throw new Error(`V10_ADMIN_BRIDGE_NOT_CONFIGURED:${op}`);
    // The V9 database bridge globally wraps fetch() for same-origin PostgREST calls
    // and injects the restricted Core API key. This Edge Function is authenticated
    // by its own high-entropy bridge header, so use the preserved raw fetch to avoid
    // the database-key resource allowlist being applied to /functions/v1/.
    const rawFetch = globalThis[BRIDGE_FETCH_MARK]?.fetch || globalThis.fetch.bind(globalThis);
    const response = await rawFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aiguka-core-bridge": bridgeKey,
      },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { data = { raw: raw.slice(0, 800) }; }
    if (!response.ok) throw new Error(data?.error || data?.message || data?.hint || `ADMIN_BRIDGE_HTTP_${response.status}:${op}`);
    return data;
  }

  return { call, ready: Boolean(endpoint && bridgeKey), endpoint };
}
