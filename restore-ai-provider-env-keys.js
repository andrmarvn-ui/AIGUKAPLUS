import crypto from "node:crypto";

const clean = (value) => String(value ?? "").trim();
const nowIso = () => new Date().toISOString();

const coreBase = clean(process.env.AIGUKA_V9_CORE_URL || process.env.SUPABASE_URL).replace(/\/$/, "");
const publicKey = clean(
  process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY
  || process.env.SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_ANON_KEY,
);
const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
const knowledgeBase = clean(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL).replace(/\/$/, "");
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

function encrypt(value) {
  const key = crypto.createHash("sha256").update(`${knowledgeKey}|${knowledgeBase}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

async function run() {
  if (!coreBase || !publicKey || !bridgeKey || !knowledgeBase || !knowledgeKey) {
    console.warn("[AIGUKA key recovery] skipped: Core/encryption configuration incomplete");
    return;
  }

  const list = await rpc("v10_bridge_ai_provider_list");
  const rows = Array.isArray(list?.data) ? list.data : [];
  let restored = 0;

  for (const row of rows) {
    const providerKey = clean(row?.provider_key).toLowerCase();
    if (!providerKey || row?.api_key_ciphertext) continue; // Never overwrite a stored key.
    const envSecret = firstEnv(ENV_ALIASES[providerKey] || []);
    if (!envSecret) continue;

    const secret = envSecret.value;
    await rpc("v10_bridge_ai_provider_patch", {
      p_provider_key: providerKey,
      p_patch: {
        api_key_ciphertext: encrypt(secret),
        api_key_hint: `••••${secret.slice(-4)}`,
        connection_status: "configured",
        last_error: null,
        updated_at: nowIso(),
      },
    });
    restored += 1;
    console.log(`[AIGUKA key recovery] restored ${providerKey} from ${envSecret.name} without exposing the secret`);
  }

  console.log(`[AIGUKA key recovery] completed: ${restored} missing provider key(s) restored from Railway environment`);
}

run().catch((error) => {
  console.error(`[AIGUKA key recovery] failed safely: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 0;
});
