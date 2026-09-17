import crypto from "node:crypto";

const clean = (v) => String(v ?? "").trim();
const base = (v) => clean(v).replace(/\/$/, "");
const now = () => new Date().toISOString();

const coreBase = base(process.env.AIGUKA_V9_CORE_URL || process.env.SUPABASE_URL);
const publicKey = clean(process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY);
const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
const targetCryptoBase = base(process.env.AIGUKA_V9_KNOWLEDGE_URL || process.env.SUPABASE_URL);
const targetCryptoKey = clean(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY || process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

function keyFor(serviceKey, url) {
  return crypto.createHash("sha256").update(`${serviceKey}|${url}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(targetCryptoKey, targetCryptoBase), iv);
  const out = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${out.toString("base64")}`;
}
function decrypt(row, serviceKey, url) {
  const ciphertext = clean(row?.api_key_ciphertext);
  if (!ciphertext || !serviceKey || !url) return "";
  try {
    const parts = ciphertext.split(".");
    const key = keyFor(serviceKey, url);
    if (parts.length === 3) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64"));
      decipher.setAuthTag(Buffer.from(parts[1], "base64"));
      return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
    }
    const iv = clean(row?.api_key_iv);
    const tag = clean(row?.api_key_tag);
    if (iv && tag) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
    }
  } catch {}
  return "";
}

function legacySources() {
  const rows = [
    { label: "legacy", url: base(process.env.SUPABASE_URL), key: clean(process.env.SUPABASE_SERVICE_ROLE_KEY) },
    { label: "knowledge", url: base(process.env.AIGUKA_V9_KNOWLEDGE_URL), key: clean(process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY) },
    { label: "reporting", url: base(process.env.AIGUKA_V9_REPORTING_URL), key: clean(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY) },
  ];
  const seen = new Set();
  return rows.filter((x) => {
    if (!x.url || !x.key || x.url === coreBase) return false;
    const id = `${x.url}|${x.key.slice(-8)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function readLegacy(source, table) {
  const r = await fetch(`${source.url}/rest/v1/${table}?select=*`, {
    headers: { apikey: source.key, authorization: `Bearer ${source.key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function coreRest(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("apikey")) headers.set("apikey", publicKey);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${publicKey}`);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("x-aiguka-core-bridge", bridgeKey);
  const r = await fetch(`${coreBase}/rest/v1/${path}`, { ...init, headers, cache: "no-store", signal: init.signal || AbortSignal.timeout(30000) });
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!r.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_REST_${r.status}`);
  return data;
}

function id(row) {
  return clean(row?.provider_key).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

async function main() {
  if (!coreBase || !publicKey || !bridgeKey || !targetCryptoBase || !targetCryptoKey) throw new Error("MIGRATION_CONFIGURATION_INCOMPLETE");
  const bridge = await import("./v9-core-bridge-bootstrap.js");
  const state = await bridge.bootstrapV9CoreBridge();
  if (!state?.ready) throw new Error(`CORE_BRIDGE_NOT_READY:${state?.error || "unknown"}`);

  const sources = legacySources();
  let chosen = null;
  for (const source of sources) {
    for (const table of ["ai_providers", "v8_ai_providers"]) {
      const rows = await readLegacy(source, table).catch(() => []);
      console.log(`[AIGUKA key migration v2] source=${source.label}/${table} rows=${rows.length}`);
      if (!chosen || rows.length > chosen.rows.length) chosen = { source, table, rows };
    }
  }
  if (!chosen?.rows?.length) throw new Error("LEGACY_PROVIDER_STORE_NOT_REACHABLE");

  const currentRows = await coreRest("ai_providers?select=*");
  const current = new Map((Array.isArray(currentRows) ? currentRows : []).map((r) => [id(r), r]));
  const cryptoContexts = [chosen.source, ...sources.filter((s) => s !== chosen.source)];

  let restored = 0;
  let preserved = 0;
  let failed = 0;
  const legacyIds = new Set();

  for (const old of chosen.rows) {
    const providerKey = id(old);
    if (!providerKey) continue;
    legacyIds.add(providerKey);
    const cur = current.get(providerKey) || {};

    let secret = "";
    let decryptLabel = "";
    for (const ctx of cryptoContexts) {
      secret = decrypt(old, ctx.key, ctx.url);
      if (secret) { decryptLabel = ctx.label; break; }
    }

    let ciphertext = "";
    let hint = clean(old.api_key_hint);
    if (secret) {
      ciphertext = encrypt(secret);
      if (!hint) hint = `••••${secret.slice(-4)}`;
      restored += 1;
    } else if (clean(cur.api_key_ciphertext)) {
      ciphertext = cur.api_key_ciphertext;
      hint = clean(cur.api_key_hint) || hint;
      preserved += 1;
    } else {
      failed += 1;
      console.warn(`[AIGUKA key migration v2] ${providerKey}: key could not be decrypted`);
      continue;
    }

    const oldSettings = old.settings && typeof old.settings === "object" ? old.settings : {};
    const curSettings = cur.settings && typeof cur.settings === "object" ? cur.settings : {};
    const mode = clean(old.mode || oldSettings.mode || (old.is_enabled ? "PRODUCTION" : "OFF")).toUpperCase();
    const settings = {
      ...curSettings,
      ...oldSettings,
      mode: ["OFF", "TEST", "PRODUCTION"].includes(mode) ? mode : (old.is_enabled ? "PRODUCTION" : "OFF"),
      migrated_from_legacy_provider_store: true,
      migrated_at: now(),
      legacy_source: chosen.table,
    };
    if (Array.isArray(old.available_models)) settings.available_models = old.available_models;
    if (old.last_success_at) settings.last_success_at = old.last_success_at;

    const row = {
      provider_key: providerKey,
      provider_name: clean(old.provider_name || cur.provider_name || providerKey),
      provider_type: clean(old.provider_type || cur.provider_type || "openai_compatible"),
      base_url: clean(old.base_url || cur.base_url),
      model_name: clean(old.model_name || cur.model_name),
      api_key_ciphertext: ciphertext,
      api_key_hint: hint || null,
      is_enabled: old.is_enabled === true,
      connection_status: clean(old.connection_status || "configured"),
      settings,
      last_verified_at: old.last_verified_at || old.last_checked_at || cur.last_verified_at || null,
      last_error: old.last_error || null,
      updated_at: now(),
    };

    await coreRest("ai_providers?on_conflict=provider_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });
    console.log(`[AIGUKA key migration v2] migrated ${providerKey}; key=${secret ? `legacy:${decryptLabel}` : "preserved-current"}`);
  }

  const verify = await coreRest("ai_providers?select=provider_key,api_key_ciphertext,api_key_hint,settings");
  const migratedRows = (Array.isArray(verify) ? verify : []).filter((r) => legacyIds.has(id(r)));
  const withKey = migratedRows.filter((r) => clean(r.api_key_ciphertext)).length;
  console.log(`[AIGUKA key migration v2] VERIFY legacy=${legacyIds.size} present=${migratedRows.length} with_key=${withKey} restored=${restored} preserved=${preserved} failed=${failed}`);
  if (migratedRows.length !== legacyIds.size || withKey !== legacyIds.size || failed) throw new Error(`MIGRATION_INCOMPLETE:${migratedRows.length}/${legacyIds.size},keys=${withKey},failed=${failed}`);
}

await main().catch((e) => {
  console.error(`[AIGUKA key migration v2] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
