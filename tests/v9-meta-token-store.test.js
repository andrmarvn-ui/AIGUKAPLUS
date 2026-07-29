import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

function encryptToken(token, secret) {
  const key = crypto.scryptSync(secret, "aiguka-meta-oauth-v1", 32);
  const iv = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    token_cipher: encrypted.toString("base64"),
    token_iv: iv.toString("base64"),
    token_tag: cipher.getAuthTag().toString("base64"),
  };
}

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function setEnv() {
  process.env.SUPABASE_URL = "https://legacy.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "legacy-service-role";
  process.env.AIGUKA_V9_CORE_URL = "https://core.example";
  process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY = "core-service-role";
  process.env.META_APP_SECRET = "meta-app-secret-test";
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("loads Meta OAuth from V9 Core before legacy", async () => {
  setEnv();
  const calls = [];
  const encrypted = encryptToken("EAAB-core-token", process.env.META_APP_SECRET);
  global.fetch = async (url) => {
    calls.push(String(url));
    assert.match(String(url), /^https:\/\/core\.example\/rest\/v1\/v9_integrations/);
    return response([{
      integration_key: "meta_primary",
      integration_type: "meta_oauth",
      status: "ready",
      encrypted_payload: encrypted,
      public_config: {
        facebook_user_id: "user-1",
        facebook_user_name: "Owner",
        granted_scopes: ["pages_messaging"],
        ad_accounts: [{ id: "act_1" }],
      },
      updated_at: "2026-07-29T09:00:00Z",
    }]);
  };
  const store = await import(`../meta-token-store.js?core=${Date.now()}`);
  const value = await store.loadActiveMetaConnection();
  assert.equal(value.accessToken, "EAAB-core-token");
  assert.equal(value.source, "v9_core");
  assert.equal(calls.length, 1);
});

test("falls back to legacy when Core has no active connection", async () => {
  setEnv();
  const calls = [];
  const encrypted = encryptToken("EAAB-legacy-token", process.env.META_APP_SECRET);
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://core.example")) return response([]);
    return response([{
      facebook_user_id: "user-legacy",
      facebook_user_name: "Legacy Owner",
      ...encrypted,
      granted_scopes: ["pages_messaging"],
      ad_accounts: [],
      active: true,
      updated_at: "2026-07-29T08:00:00Z",
    }]);
  };
  const store = await import(`../meta-token-store.js?fallback=${Date.now()}`);
  const value = await store.loadActiveMetaConnection();
  assert.equal(value.accessToken, "EAAB-legacy-token");
  assert.equal(value.source, "v8_legacy");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^https:\/\/legacy\.example\/rest\/v1\/v8_meta_oauth_connections/);
});

test("saves new Meta OAuth connection to V9 Core only", async () => {
  setEnv();
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response([{ integration_key: "meta_primary" }]);
  };
  const store = await import(`../meta-token-store.js?save=${Date.now()}`);
  await store.saveMetaConnection({
    facebookUserId: "user-2",
    facebookUserName: "Owner 2",
    accessToken: "EAAB-new-token",
    scopes: ["pages_messaging"],
    adAccounts: [{ id: "act_2" }],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/core\.example\/rest\/v1\/v9_integrations/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.integration_key, "meta_primary");
  assert.equal(body.status, "ready");
  assert.notEqual(body.encrypted_payload.token_cipher, "EAAB-new-token");
  assert.equal(body.public_config.facebook_user_id, "user-2");
});

test.after(() => {
  process.env = originalEnv;
  global.fetch = originalFetch;
});
