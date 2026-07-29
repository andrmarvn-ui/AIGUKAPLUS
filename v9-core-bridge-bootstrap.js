const DEFAULT_CORE_URL = "https://xqcxckyrlsobdrnidtrp.supabase.co";
const DEFAULT_CORE_PUBLISHABLE_KEY = "sb_publishable_FsKYB8CS7h6VmJhLfMAGvw_IPpvoa3W";

function cleanBase(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function coreHeaders(apiKey, bridgeKey = "") {
  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (bridgeKey) headers["x-aiguka-core-bridge"] = bridgeKey;
  return headers;
}

async function verifyCore(base, apiKey, bridgeKey = "") {
  const response = await fetch(`${base}/rest/v1/v9_runtime_config?select=id,mode,ingest_mode&id=eq.1&limit=1`, {
    method: "GET",
    headers: coreHeaders(apiKey, bridgeKey),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!response.ok || !Array.isArray(data) || !data[0]) {
    throw new Error(data?.message || data?.error || `CORE_BRIDGE_VERIFY_HTTP_${response.status}`);
  }
  return data[0];
}

async function fetchDatabaseBootstrap(legacyBase, legacyServiceKey) {
  const response = await fetch(`${legacyBase}/rest/v1/rpc/v9_get_core_bridge_bootstrap`, {
    method: "POST",
    headers: {
      apikey: legacyServiceKey,
      authorization: `Bearer ${legacyServiceKey}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || `CORE_BRIDGE_BOOTSTRAP_HTTP_${response.status}`);
  if (!data?.bridge_key || String(data.bridge_key).length < 64) throw new Error("CORE_BRIDGE_BOOTSTRAP_INVALID");
  return data;
}

export const v9CoreBridgeState = {
  ready: false,
  mode: "missing",
  coreBase: "",
  keyVersion: null,
  runtime: null,
  error: null,
};

export async function bootstrapV9CoreBridge() {
  const coreBase = cleanBase(process.env.AIGUKA_V9_CORE_URL || DEFAULT_CORE_URL);
  const serviceRoleKey = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "").trim();

  try {
    if (serviceRoleKey) {
      const runtime = await verifyCore(coreBase, serviceRoleKey);
      process.env.AIGUKA_V9_CORE_URL = coreBase;
      process.env.AIGUKA_V9_CORE_API_KEY = serviceRoleKey;
      process.env.AIGUKA_V9_CORE_AUTH_MODE = "service_role";
      Object.assign(v9CoreBridgeState, { ready: true, mode: "service_role", coreBase, runtime, error: null });
      console.log(`[AIGUKA V9 Core] service-role connection verified: ${new URL(coreBase).host}`);
      return v9CoreBridgeState;
    }

    const legacyBase = cleanBase(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL);
    const legacyServiceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!legacyBase || !legacyServiceKey) throw new Error("LEGACY_SERVICE_CREDENTIAL_REQUIRED_FOR_CORE_BRIDGE");

    const bootstrap = await fetchDatabaseBootstrap(legacyBase, legacyServiceKey);
    const resolvedBase = cleanBase(bootstrap.core_url || coreBase || DEFAULT_CORE_URL);
    const publishableKey = String(
      process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY
      || bootstrap.core_publishable_key
      || DEFAULT_CORE_PUBLISHABLE_KEY,
    ).trim();
    const bridgeKey = String(bootstrap.bridge_key || "").trim();
    if (!resolvedBase || !publishableKey || !bridgeKey) throw new Error("CORE_BRIDGE_CONFIGURATION_INCOMPLETE");

    const runtime = await verifyCore(resolvedBase, publishableKey, bridgeKey);
    process.env.AIGUKA_V9_CORE_URL = resolvedBase;
    process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY = publishableKey;
    process.env.AIGUKA_V9_CORE_API_KEY = publishableKey;
    process.env.AIGUKA_V9_CORE_BRIDGE_KEY = bridgeKey;
    process.env.AIGUKA_V9_CORE_AUTH_MODE = "database_bridge";
    Object.assign(v9CoreBridgeState, {
      ready: true,
      mode: "database_bridge",
      coreBase: resolvedBase,
      keyVersion: Number(bootstrap.key_version || 1),
      runtime,
      error: null,
    });
    console.log(`[AIGUKA V9 Core] database bridge verified: ${new URL(resolvedBase).host}; key v${v9CoreBridgeState.keyVersion}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(v9CoreBridgeState, { ready: false, mode: "blocked", coreBase, runtime: null, error: message });
    console.error(`[AIGUKA V9 Core] bridge bootstrap failed: ${message}`);
  }
  return v9CoreBridgeState;
}

export const __private__ = { cleanBase, coreHeaders, verifyCore, fetchDatabaseBootstrap };
