const clean = (value) => String(value ?? "").trim();

export function createV10AdminBridgeClient(options = {}) {
  const base = clean(process.env.AIGUKA_V9_CORE_URL || options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
  const endpoint = base ? `${base}/functions/v1/aiguka-v10-admin-bridge` : "";

  async function call(op, args = {}, timeoutMs = 45_000) {
    if (!endpoint || !bridgeKey) throw new Error(`V10_ADMIN_BRIDGE_NOT_CONFIGURED:${op}`);
    const response = await fetch(endpoint, {
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
