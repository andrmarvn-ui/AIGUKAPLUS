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

function firstEnv(names) {
  for (const name of names) {
    const value = clean(process.env[name]);
    if (value) return { name, value };
  }
  return null;
}

const ENV_ALIASES = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"],
  geminiplus: ["GEMINI_API_KEY_2", "GEMINI_API_KEY2", "GEMINI2_API_KEY", "GOOGLE_GEMINI_API_KEY_2"],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_K2_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

async function rpc(name, args = {}) {
  const response = await fetch(`${coreBase}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: publicKey,
      authorization: `Bearer ${publicKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_bridge_key: bridgeKey, ...args }),
    signal: AbortSignal.timeout(20_000),
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

function canonicalLegacyProvider(row) {
  const text = `${clean(row?.provider_key)} ${clean(row?.provider_name)} ${clean(row?.provider_alias)} ${clean(row?.base_url)}`.toLowerCase();
  if (text.includes("openrouter")) return "openrouter";
  if (text.includes("nvidia")) return "nvidia";
  if (text.includes("moonshot") || text.includes("kimi")) return "kimi";
  if (text.includes("x.ai") || text.includes("grok") || /\bxai\b/.test(text)) return "grok";
  if (text.includes("deepseek")) return "deepseek";
  if (text.includes("openai")) return "openai";
  if (text.includes("gemini")) return /(plus|secondary|second|gemini.?2)/.test(text) ? "geminiplus" : "gemini";
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

async function readLegacyRows(source) {
  const response = await fetch(`${source.base}/rest/v1/v8_ai_providers?select=*`, {
    headers: { apikey: source.key, authorization: `Bearer ${source.key}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) return [];
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function patchSecret(providerKey, secret, sourceLabel) {
  await rpc("v10_bridge_ai_provider_patch", {
    p_provider_key: providerKey,
    p_patch: {
      api_key_ciphertext: encryptForCurrent(secret),
      api_key_hint: `••••${secret.slice(-4)}`,
      connection_status: "configured",
      last_error: null,
      updated_at: nowIso(),
    },
  });
  console.log(`[AIGUKA key recovery] restored ${providerKey} from ${sourceLabel} without exposing the secret`);
}

async function run() {
  if (!coreBase || !publicKey || !bridgeKey || !knowledgeBase || !knowledgeKey) {
    console.warn("[AIGUKA key recovery] skipped: Core/encryption configuration incomplete");
    return;
  }

  // Install the same authenticated Core fetch bridge used by production before
  // calling protected V10 RPCs. Captured legacy credentials above remain intact.
  const bridge = await import("./v9-core-bridge-bootstrap.js");
  await bridge.bootstrapV9CoreBridge();

  const list = await rpc("v10_bridge_ai_provider_list");
  const rows = Array.isArray(list?.data) ? list.data : [];
  const current = new Map(rows.map((row) => [clean(row?.provider_key).toLowerCase(), row]));
  const restored = new Set();

  // First recover encrypted provider keys from any still-connected legacy/Knowledge database.
  for (const source of legacySources()) {
    const legacyRows = await readLegacyRows(source).catch(() => []);
    for (const oldRow of legacyRows) {
      const providerKey = canonicalLegacyProvider(oldRow);
      if (!providerKey || !current.has(providerKey) || current.get(providerKey)?.api_key_ciphertext || restored.has(providerKey)) continue;
      const secret = decryptLegacy(oldRow, source.key, source.base);
      if (!secret) continue;
      await patchSecret(providerKey, secret, `${source.label} provider store`);
      restored.add(providerKey);
    }
  }

  // Then fill any remaining gaps from Railway environment variables.
  for (const [providerKey, row] of current.entries()) {
    if (!providerKey || row?.api_key_ciphertext || restored.has(providerKey)) continue;
    const envSecret = firstEnv(ENV_ALIASES[providerKey] || []);
    if (!envSecret) continue;
    await patchSecret(providerKey, envSecret.value, envSecret.name);
    restored.add(providerKey);
  }

  console.log(`[AIGUKA key recovery] completed: ${restored.size} missing provider key(s) restored`);
}

run().catch((error) => {
  console.error(`[AIGUKA key recovery] failed safely: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
});
