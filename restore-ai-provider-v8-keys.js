import crypto from "node:crypto";

const clean = (value) => String(value ?? "").trim();
const base = (value) => clean(value).replace(/\/$/, "");
const nowIso = () => new Date().toISOString();

const OLD_AIGUKA_URL = "https://ezygfpeeqbbirdeazene.supabase.co";
const coreBase = base(process.env.AIGUKA_V9_CORE_URL || process.env.SUPABASE_URL);
const publicKey = clean(
  process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY
  || process.env.SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_ANON_KEY,
);
const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
const knowledgeBase = base(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL);
const knowledgeKey = clean(
  process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY
  || process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const aliasKey = (value) => {
  const key = clean(value).toLowerCase();
  if (key === "gemini2" || key === "google") return "geminiplus";
  if (key === "nvidia-claude") return "nvidia";
  return key.replace(/[^a-z0-9_-]/g, "-");
};

function timingSafeHex(a, b) {
  try {
    const left = Buffer.from(String(a || ""), "hex");
    const right = Buffer.from(String(b || ""), "hex");
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  } catch { return false; }
}

async function rpc(name, args = {}) {
  const response = await fetch(`${coreBase}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: publicKey,
      authorization: `Bearer ${publicKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_bridge_key: bridgeKey, ...args }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!response.ok) throw new Error(data?.message || data?.error || `RPC_${name}_${response.status}`);
  return data;
}

function currentEncryptionKey() {
  return crypto.createHash("sha256")
    .update(`${knowledgeKey}|${knowledgeBase}|AIGUKA_AI_PROVIDER_KEYS_V1`)
    .digest();
}

function encryptCurrent(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", currentEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function fromB64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
}

function decryptV3(ciphertext, serviceKey) {
  const parts = clean(ciphertext).split(".");
  if (parts.length !== 3 || parts[0] !== "v3") return "";
  try {
    const key = crypto.createHash("sha256").update(`AIGUKA_AI_PROVIDER_KEY_V3:${serviceKey}`).digest();
    const iv = fromB64Url(parts[1]);
    const packed = fromB64Url(parts[2]);
    if (packed.length <= 16) return "";
    const data = packed.subarray(0, packed.length - 16);
    const tag = packed.subarray(packed.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

function decryptV1(ciphertext, serviceKey, sourceBase) {
  const parts = clean(ciphertext).split(".");
  if (parts.length !== 3 || parts[0] === "v3") return "";
  try {
    const key = crypto.createHash("sha256")
      .update(`${serviceKey}|${sourceBase}|AIGUKA_AI_PROVIDER_KEYS_V1`)
      .digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

function recoverSecret(row, source) {
  const ciphertext = clean(row?.api_key_ciphertext);
  let secret = decryptV1(ciphertext, source.key, source.base);
  if (!secret) secret = decryptV3(ciphertext, source.key);
  if (!secret) {
    const secretName = clean(row?.api_key_secret_name);
    if (secretName && secretName !== "AIGUKA_V8_ADMIN_SECRET") secret = clean(process.env[secretName]);
  }
  return secret;
}

function sourceCandidates() {
  const keys = [
    ["knowledge", clean(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY), base(process.env.AIGUKA_V9_KNOWLEDGE_URL)],
    ["reporting", clean(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY), base(process.env.AIGUKA_V9_REPORTING_URL)],
    ["legacy", clean(process.env.SUPABASE_SERVICE_ROLE_KEY), base(process.env.SUPABASE_URL)],
  ];
  const out = [];
  const seen = new Set();
  for (const [label, key, configuredBase] of keys) {
    if (!key) continue;
    for (const candidateBase of [configuredBase, OLD_AIGUKA_URL]) {
      if (!candidateBase || candidateBase === coreBase) continue;
      const id = `${candidateBase}|${key.slice(-10)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ label, key, base: candidateBase });
    }
  }
  return out;
}

async function readRows(source) {
  const response = await fetch(`${source.base}/rest/v1/v8_ai_providers?select=*`, {
    headers: { apikey: source.key, authorization: `Bearer ${source.key}` },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!response.ok) return [];
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function safeSettings(row) {
  const settings = row?.settings && typeof row.settings === "object" ? row.settings : {};
  const runtimeOrder = Math.max(1, Number(settings.runtime_order || 100));
  const enabled = row?.is_enabled === true;
  const available = Array.isArray(row?.available_models) ? row.available_models : [];
  return {
    runtime_order: runtimeOrder,
    endpoint_style: clean(settings.endpoint_style) || undefined,
    upstream_base_url: clean(settings.upstream_base_url) || undefined,
    available_models: available,
    mode: enabled ? "PRODUCTION" : "OFF",
    runtime_state: "configured",
    runtime_auto_recover: true,
    restored_from_v8: true,
    restored_at: nowIso(),
  };
}

async function run() {
  if (!coreBase || !publicKey || !bridgeKey || !knowledgeBase || !knowledgeKey) {
    console.warn("[AIGUKA V8 key restore] skipped: Core/encryption configuration incomplete");
    return;
  }

  const bridge = await import("./v9-core-bridge-bootstrap.js");
  await bridge.bootstrapV9CoreBridge();

  const currentResult = await rpc("v10_bridge_ai_provider_list");
  const currentRows = Array.isArray(currentResult?.data) ? currentResult.data : [];
  const current = new Map(currentRows.map((row) => [aliasKey(row?.provider_key), row]));

  let best = null;
  for (const source of sourceCandidates()) {
    const rows = await readRows(source).catch(() => []);
    if (!best || rows.length > best.rows.length) best = { source, rows };
  }

  if (!best?.rows?.length) {
    console.warn("[AIGUKA V8 key restore] no reachable legacy v8_ai_providers source");
    return;
  }

  let restored = 0;
  let preserved = 0;
  let failed = 0;
  const restoredProviders = [];
  const failedProviders = [];

  for (const oldRow of best.rows) {
    const providerKey = aliasKey(oldRow?.provider_key);
    if (!providerKey) continue;
    const existing = current.get(providerKey) || null;
    const existingCiphertext = clean(existing?.api_key_ciphertext);
    let ciphertext = existingCiphertext;
    let secret = "";

    if (!ciphertext) {
      secret = recoverSecret(oldRow, best.source);
      if (secret) ciphertext = encryptCurrent(secret);
    }

    if (!ciphertext) {
      failed += 1;
      failedProviders.push(providerKey);
    } else if (existingCiphertext) {
      preserved += 1;
    } else {
      restored += 1;
      restoredProviders.push(providerKey);
    }

    const row = {
      provider_name: clean(oldRow?.provider_name || existing?.provider_name || providerKey),
      provider_type: clean(oldRow?.provider_type || existing?.provider_type || "openai_compatible"),
      base_url: clean(oldRow?.base_url || existing?.base_url || ""),
      model_name: clean(oldRow?.model_name || existing?.model_name || ""),
      api_key_ciphertext: ciphertext || null,
      api_key_hint: clean(existing?.api_key_hint || oldRow?.api_key_hint) || (secret ? `••••${secret.slice(-4)}` : null),
      is_enabled: Boolean(ciphertext) && oldRow?.is_enabled === true,
      connection_status: ciphertext ? "configured" : "missing_key",
      settings: safeSettings(oldRow),
      last_verified_at: null,
      last_error: ciphertext ? null : "legacy_key_recovery_failed",
      updated_at: nowIso(),
    };

    await rpc("v10_bridge_ai_provider_upsert", { p_provider_key: providerKey, p_row: row });
  }

  console.log(`[AIGUKA V8 key restore] source=${best.source.label}@${best.source.base}; rows=${best.rows.length}; restored=${restored}; preserved=${preserved}; failed=${failed}`);
  if (restoredProviders.length) console.log(`[AIGUKA V8 key restore] restored providers: ${restoredProviders.join(",")}`);
  if (failedProviders.length) console.warn(`[AIGUKA V8 key restore] failed providers: ${failedProviders.join(",")}`);
}

await run().catch((error) => {
  console.error(`[AIGUKA V8 key restore] failed safely: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
});
