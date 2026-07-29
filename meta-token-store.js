import crypto from "node:crypto";

const LEGACY_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const LEGACY_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CORE_URL = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const CORE_INTEGRATION_KEY = "meta_primary";

function legacyReady() {
  return Boolean(LEGACY_URL && LEGACY_KEY && META_APP_SECRET);
}

function coreReady() {
  return Boolean(CORE_URL && CORE_KEY && META_APP_SECRET);
}

function deriveKey() {
  if (!META_APP_SECRET) throw new Error("MISSING_META_APP_SECRET");
  return crypto.scryptSync(META_APP_SECRET, "aiguka-meta-oauth-v1", 32);
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    token_cipher: encrypted.toString("base64"),
    token_iv: iv.toString("base64"),
    token_tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptToken(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(),
    Buffer.from(row.token_iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.token_cipher, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function headers(key, extra = {}) {
  if (!key) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function request(base, key, path, options = {}) {
  if (!base) throw new Error("MISSING_SUPABASE_URL");
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: headers(key, options.headers || {}),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || `SUPABASE_HTTP_${response.status}`);
  return data;
}

function publicConnection({ facebookUserId, facebookUserName, scopes, adAccounts, updatedAt, active = true }) {
  return {
    facebook_user_id: facebookUserId,
    facebook_user_name: facebookUserName,
    granted_scopes: scopes || [],
    ad_accounts: adAccounts || [],
    active,
    updated_at: updatedAt,
  };
}

async function saveCoreConnection({ facebookUserId, facebookUserName, accessToken, scopes, adAccounts }) {
  const encrypted = encryptToken(accessToken);
  const now = new Date().toISOString();
  return request(CORE_URL, CORE_KEY, "/rest/v1/v9_integrations?on_conflict=integration_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      integration_key: CORE_INTEGRATION_KEY,
      integration_type: "meta_oauth",
      display_name: facebookUserName || "Meta OAuth",
      status: "ready",
      encrypted_payload: encrypted,
      public_config: {
        facebook_user_id: String(facebookUserId),
        facebook_user_name: facebookUserName || null,
        granted_scopes: scopes || [],
        ad_accounts: adAccounts || [],
      },
      secret_version: 1,
      last_verified_at: now,
      last_error: null,
      updated_at: now,
    }),
  });
}

async function loadCoreConnection() {
  if (!coreReady()) return null;
  const rows = await request(
    CORE_URL,
    CORE_KEY,
    `/rest/v1/v9_integrations?integration_key=eq.${CORE_INTEGRATION_KEY}&integration_type=eq.meta_oauth&status=eq.ready&select=*&limit=1`,
    { method: "GET" },
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const config = row.public_config || {};
  return {
    facebookUserId: config.facebook_user_id,
    facebookUserName: config.facebook_user_name,
    accessToken: decryptToken(row.encrypted_payload || {}),
    scopes: config.granted_scopes || [],
    adAccounts: config.ad_accounts || [],
    updatedAt: row.updated_at,
    source: "v9_core",
  };
}

async function saveLegacyConnection({ facebookUserId, facebookUserName, accessToken, scopes, adAccounts }) {
  const encrypted = encryptToken(accessToken);
  await request(LEGACY_URL, LEGACY_KEY, "/rest/v1/v8_meta_oauth_connections?active=eq.true", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
  const payload = {
    facebook_user_id: String(facebookUserId),
    facebook_user_name: facebookUserName || null,
    ...encrypted,
    granted_scopes: scopes || [],
    ad_accounts: adAccounts || [],
    active: true,
    updated_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
  };
  return request(LEGACY_URL, LEGACY_KEY, "/rest/v1/v8_meta_oauth_connections?on_conflict=facebook_user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
}

async function loadLegacyConnection() {
  if (!legacyReady()) return null;
  const rows = await request(
    LEGACY_URL,
    LEGACY_KEY,
    "/rest/v1/v8_meta_oauth_connections?active=eq.true&select=*&order=updated_at.desc&limit=1",
    { method: "GET" },
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return {
    facebookUserId: row.facebook_user_id,
    facebookUserName: row.facebook_user_name,
    accessToken: decryptToken(row),
    scopes: row.granted_scopes || [],
    adAccounts: row.ad_accounts || [],
    updatedAt: row.updated_at,
    source: "v8_legacy",
  };
}

export async function saveMetaConnection(connection) {
  if (coreReady()) return saveCoreConnection(connection);
  if (legacyReady()) return saveLegacyConnection(connection);
  throw new Error("META_OAUTH_STORE_NOT_CONFIGURED");
}

export async function loadActiveMetaConnection() {
  if (coreReady()) {
    try {
      const core = await loadCoreConnection();
      if (core) return core;
    } catch (error) {
      console.error(`[AIGUKA Meta store] Core load failed, using legacy fallback: ${error.message}`);
    }
  }
  return loadLegacyConnection();
}

export async function listMetaConnections() {
  if (coreReady()) {
    try {
      const rows = await request(
        CORE_URL,
        CORE_KEY,
        "/rest/v1/v9_integrations?integration_type=eq.meta_oauth&select=public_config,status,updated_at&order=updated_at.desc",
        { method: "GET" },
      );
      if (Array.isArray(rows) && rows.length) {
        return rows.map((row) => {
          const config = row.public_config || {};
          return publicConnection({
            facebookUserId: config.facebook_user_id,
            facebookUserName: config.facebook_user_name,
            scopes: config.granted_scopes,
            adAccounts: config.ad_accounts,
            updatedAt: row.updated_at,
            active: row.status === "ready",
          });
        });
      }
    } catch (error) {
      console.error(`[AIGUKA Meta store] Core list failed, using legacy fallback: ${error.message}`);
    }
  }
  if (!legacyReady()) return [];
  const rows = await request(
    LEGACY_URL,
    LEGACY_KEY,
    "/rest/v1/v8_meta_oauth_connections?select=facebook_user_id,facebook_user_name,granted_scopes,ad_accounts,active,updated_at&order=updated_at.desc",
    { method: "GET" },
  );
  return Array.isArray(rows) ? rows : [];
}

export function metaOAuthStoreConfigured() {
  return coreReady() || legacyReady();
}
