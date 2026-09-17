import crypto from "node:crypto";

const clean = (v) => String(v ?? "").trim();
const stripSlash = (v) => clean(v).replace(/\/$/, "");
const nowIso = () => new Date().toISOString();

const coreBase = stripSlash(process.env.AIGUKA_V9_CORE_URL || process.env.SUPABASE_URL);
const corePublic = clean(process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY);
const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
const legacyBase = stripSlash(process.env.AIGUKA_V9_KNOWLEDGE_URL);
const legacyService = clean(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY);

function encKey(service, base) {
  return crypto.createHash("sha256").update(`${service}|${base}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest();
}

function decryptLegacy(value) {
  const [iv, tag, data] = clean(value).split(".");
  if (!iv || !tag || !data) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(legacyService, legacyBase), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function encryptCurrent(secret) {
  // Current V10 admin routes intentionally use the retained Knowledge credentials
  // as the provider-key encryption root, so restored keys remain decryptable there.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(legacyService, legacyBase), iv);
  const out = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), out.toString("base64")].join(".");
}

async function legacyRows(table) {
  const r = await fetch(`${legacyBase}/rest/v1/${table}?select=*`, {
    headers: { apikey: legacyService, authorization: `Bearer ${legacyService}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function rpc(name, args = {}) {
  const r = await fetch(`${coreBase}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: corePublic,
      authorization: `Bearer ${corePublic}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_bridge_key: bridgeKey, ...args }),
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!r.ok) throw new Error(data?.error || data?.message || `RPC_${name}_${r.status}`);
  return data;
}

async function run() {
  if (!coreBase || !corePublic || !bridgeKey || !legacyBase || !legacyService) {
    console.warn("[AIGUKA provider migration] skipped: source/Core configuration incomplete");
    return;
  }

  let source = await legacyRows("ai_providers");
  if (!source.length) source = await legacyRows("v8_ai_providers");
  if (!source.length) {
    console.warn("[AIGUKA provider migration] no legacy provider rows found");
    return;
  }

  const listed = await rpc("v10_bridge_ai_provider_list");
  const currentRows = Array.isArray(listed?.data) ? listed.data : [];
  const current = new Map(currentRows.map((r) => [clean(r.provider_key).toLowerCase(), r]));
  let restored = 0;
  let skippedExisting = 0;
  let failedDecrypt = 0;

  for (const old of source) {
    const key = clean(old.provider_key).toLowerCase();
    if (!key) continue;
    const existing = current.get(key);
    if (existing?.api_key_ciphertext) {
      skippedExisting += 1;
      continue;
    }

    const secret = decryptLegacy(old.api_key_ciphertext);
    if (!secret) {
      failedDecrypt += 1;
      console.warn(`[AIGUKA provider migration] ${key}: legacy key could not be decrypted; skipped`);
      continue;
    }

    const oldSettings = old.settings && typeof old.settings === "object" ? old.settings : {};
    const settings = {
      ...oldSettings,
      restored_from_legacy: true,
      restored_at: nowIso(),
      smoke_test: null,
      cooldown_until: null,
      runtime_cooldown_until: null,
      runtime_state: "configured",
      runtime_error_class: null,
    };

    const row = {
      provider_name: clean(old.provider_name) || key,
      provider_type: clean(old.provider_type) || "openai_compatible",
      base_url: clean(old.base_url),
      model_name: clean(old.model_name),
      api_key_ciphertext: encryptCurrent(secret),
      api_key_hint: clean(old.api_key_hint) || `••••${secret.slice(-4)}`,
      is_enabled: old.is_enabled === true,
      connection_status: "configured",
      settings,
      last_verified_at: null,
      last_error: null,
      updated_at: nowIso(),
    };

    await rpc("v10_bridge_ai_provider_upsert", { p_provider_key: key, p_row: row });
    restored += 1;
    console.log(`[AIGUKA provider migration] restored ${key} from legacy encrypted store`);
  }

  console.log(`[AIGUKA provider migration] complete: source=${source.length}, restored=${restored}, kept_existing=${skippedExisting}, decrypt_failed=${failedDecrypt}`);
}

await run().catch((error) => {
  console.error(`[AIGUKA provider migration] failed safely: ${error instanceof Error ? error.message : String(error)}`);
});
