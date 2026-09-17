import crypto from "node:crypto";

const clean = (value) => String(value ?? "").trim();
const nowIso = () => new Date().toISOString();
const normalizedBase = (value) => clean(value).replace(/\/$/, "");

const coreBase = normalizedBase(process.env.AIGUKA_V9_CORE_URL || process.env.SUPABASE_URL);
const publicKey = clean(
  process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY
  || process.env.SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_ANON_KEY,
);
const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
const knowledgeBase = normalizedBase(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL);
const knowledgeKey = clean(
  process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY
  || process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const ENV_ALIASES = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"],
  google: ["GEMINI_API_KEY_2", "GEMINI_API_KEY2", "GEMINI2_API_KEY", "GOOGLE_GEMINI_API_KEY_2"],
  geminiplus: ["GEMINI_API_KEY_2", "GEMINI_API_KEY2", "GEMINI2_API_KEY", "GOOGLE_GEMINI_API_KEY_2"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_K2_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
};

function firstEnv(names) {
  for (const name of names || []) {
    const value = clean(process.env[name]);
    if (value) return { name, value };
  }
  return null;
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

function cryptoKey(serviceKey, base) {
  return crypto.createHash("sha256").update(`${serviceKey}|${base}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest();
}

function encryptForCurrent(value) {
  const key = cryptoKey(knowledgeKey, knowledgeBase);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decryptLegacy(row, serviceKey, base) {
  const ciphertext = clean(row?.api_key_ciphertext);
  if (!ciphertext) return "";
  const key = cryptoKey(serviceKey, base);
  try {
    const pieces = ciphertext.split(".");
    if (pieces.length === 3) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(pieces[0], "base64"));
      decipher.setAuthTag(Buffer.from(pieces[1], "base64"));
      return Buffer.concat([decipher.update(Buffer.from(pieces[2], "base64")), decipher.final()]).toString("utf8");
    }
    const iv = clean(row?.api_key_iv);
    const tag = clean(row?.api_key_tag);
    if (iv && tag) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
    }
  } catch {
    return "";
  }
  return "";
}

function legacySources() {
  const candidates = [
    { label: "knowledge", base: normalizedBase(process.env.AIGUKA_V9_KNOWLEDGE_URL), key: clean(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY) },
    { label: "legacy", base: normalizedBase(process.env.SUPABASE_URL), key: clean(process.env.SUPABASE_SERVICE_ROLE_KEY) },
    { label: "reporting", base: normalizedBase(process.env.AIGUKA_V9_REPORTING_URL), key: clean(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY) },
  ];
  const seen = new Set();
  return candidates.filter((item) => {
    if (!item.base || !item.key || item.base === coreBase) return false;
    const id = `${item.base}|${item.key.slice(-8)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function readTable(source, table) {
  const response = await fetch(`${source.base}/rest/v1/${table}?select=*`, {
    headers: { apikey: source.key, authorization: `Bearer ${source.key}` },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!response.ok) return [];
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function readLegacyRows(source) {
  const modern = await readTable(source, "ai_providers").catch(() => []);
  if (modern.length) return { table: "ai_providers", rows: modern };
  const legacy = await readTable(source, "v8_ai_providers").catch(() => []);
  return { table: "v8_ai_providers", rows: legacy };
}

function providerKeyOf(row) {
  return clean(row?.provider_key).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function compatibleSettings(oldRow, currentRow) {
  const oldSettings = oldRow?.settings && typeof oldRow.settings === "object" ? oldRow.settings : {};
  const currentSettings = currentRow?.settings && typeof currentRow.settings === "object" ? currentRow.settings : {};
  const mode = clean(oldRow?.mode || oldSettings.mode || (oldRow?.is_enabled ? "PRODUCTION" : "OFF")).toUpperCase();
  return {
    ...oldSettings,
    ...currentSettings,
    mode: ["OFF", "TEST", "PRODUCTION"].includes(mode) ? mode : (oldRow?.is_enabled ? "PRODUCTION" : "OFF"),
    available_models: Array.isArray(oldRow?.available_models)
      ? oldRow.available_models
      : (Array.isArray(oldSettings.available_models) ? oldSettings.available_models : currentSettings.available_models),
    last_success_at: oldRow?.last_success_at || oldSettings.last_success_at || currentSettings.last_success_at || null,
    migrated_from_legacy_provider_store: true,
    migrated_at: nowIso(),
  };
}

async function upsertProvider(oldRow, currentRow, secret, sourceLabel) {
  const providerKey = providerKeyOf(oldRow);
  if (!providerKey) return false;

  const existingCiphertext = clean(currentRow?.api_key_ciphertext);
  const ciphertext = existingCiphertext || (secret ? encryptForCurrent(secret) : "");
  if (!ciphertext) return false;

  const hint = clean(currentRow?.api_key_hint || oldRow?.api_key_hint)
    || (secret ? `••••${secret.slice(-4)}` : "");
  const settings = compatibleSettings(oldRow, currentRow);

  const row = {
    provider_name: clean(oldRow?.provider_name || currentRow?.provider_name || providerKey),
    provider_type: clean(oldRow?.provider_type || currentRow?.provider_type || "openai_compatible"),
    base_url: clean(oldRow?.base_url || currentRow?.base_url || ""),
    model_name: clean(oldRow?.model_name || currentRow?.model_name || ""),
    api_key_ciphertext: ciphertext,
    api_key_hint: hint || null,
    is_enabled: oldRow?.is_enabled === true,
    connection_status: existingCiphertext
      ? clean(currentRow?.connection_status || oldRow?.connection_status || "configured")
      : "configured",
    settings,
    last_verified_at: oldRow?.last_verified_at || oldRow?.last_checked_at || currentRow?.last_verified_at || null,
    last_error: existingCiphertext ? (currentRow?.last_error || null) : null,
    updated_at: nowIso(),
  };

  await rpc("v10_bridge_ai_provider_upsert", { p_provider_key: providerKey, p_row: row });
  console.log(`[AIGUKA key migration] ${providerKey}: ${existingCiphertext ? "kept current key" : `restored key from ${sourceLabel}`}`);
  return true;
}

async function run() {
  if (!coreBase || !publicKey || !bridgeKey || !knowledgeBase || !knowledgeKey) {
    console.warn("[AIGUKA key migration] skipped: Core/encryption configuration incomplete");
    return;
  }

  // Prestart runs in its own process. Install the authenticated Core fetch bridge
  // before protected V10 RPC calls so the transfer targets the live production Core.
  const bridge = await import("./v9-core-bridge-bootstrap.js");
  await bridge.bootstrapV9CoreBridge();

  const list = await rpc("v10_bridge_ai_provider_list");
  const currentRows = Array.isArray(list?.data) ? list.data : [];
  const current = new Map(currentRows.map((row) => [providerKeyOf(row), row]));

  let best = null;
  for (const source of legacySources()) {
    const result = await readLegacyRows(source);
    if (!best || result.rows.length > best.rows.length) best = { ...result, source };
  }

  if (!best?.rows?.length) {
    console.warn("[AIGUKA key migration] no legacy provider rows reachable; falling back to Railway env only");
    let restoredFromEnv = 0;
    for (const [providerKey, row] of current.entries()) {
      if (clean(row?.api_key_ciphertext)) continue;
      const envSecret = firstEnv(ENV_ALIASES[providerKey]);
      if (!envSecret) continue;
      const synthetic = { ...row, provider_key: providerKey };
      if (await upsertProvider(synthetic, row, envSecret.value, envSecret.name)) restoredFromEnv += 1;
    }
    console.log(`[AIGUKA key migration] completed from Railway env: ${restoredFromEnv}`);
    return;
  }

  let migrated = 0;
  let decrypted = 0;
  let preserved = 0;
  let failed = 0;

  for (const oldRow of best.rows) {
    const providerKey = providerKeyOf(oldRow);
    if (!providerKey) continue;
    const currentRow = current.get(providerKey) || null;

    if (clean(currentRow?.api_key_ciphertext)) {
      if (await upsertProvider(oldRow, currentRow, "", `${best.source.label}/${best.table}`)) {
        migrated += 1;
        preserved += 1;
      }
      continue;
    }

    let secret = decryptLegacy(oldRow, best.source.key, best.source.base);
    let sourceLabel = `${best.source.label}/${best.table}`;
    if (!secret) {
      const envSecret = firstEnv(ENV_ALIASES[providerKey]);
      if (envSecret) {
        secret = envSecret.value;
        sourceLabel = envSecret.name;
      }
    }
    if (!secret) {
      console.warn(`[AIGUKA key migration] ${providerKey}: encrypted key could not be recovered`);
      failed += 1;
      continue;
    }

    if (await upsertProvider(oldRow, currentRow, secret, sourceLabel)) {
      migrated += 1;
      decrypted += 1;
    }
  }

  console.log(`[AIGUKA key migration] completed: legacy_rows=${best.rows.length}, migrated=${migrated}, restored_keys=${decrypted}, kept_current_keys=${preserved}, failed=${failed}, source=${best.source.label}/${best.table}`);
}

await run().catch((error) => {
  console.error(`[AIGUKA key migration] failed safely: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
});
