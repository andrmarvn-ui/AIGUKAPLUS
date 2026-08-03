import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __private__ as bridgePrivate } from "../v9-core-bridge-bootstrap.js";

const bootstrapSource = fs.readFileSync(new URL("../v9-core-bridge-bootstrap.js", import.meta.url), "utf8");
const inboxBridgeSource = fs.readFileSync(new URL("../v9-legacy-inbox-bridge.js", import.meta.url), "utf8");
const startSource = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
const routerSource = fs.readFileSync(new URL("../v9-core-fetch-router.js", import.meta.url), "utf8");


test("Core bridge headers use the public API key plus a separate database-only credential", () => {
  const headers = bridgePrivate.coreHeaders("sb_publishable_test", "bridge-secret-test-value");
  assert.equal(headers.apikey, "sb_publishable_test");
  assert.equal(headers.authorization, "Bearer sb_publishable_test");
  assert.equal(headers["x-aiguka-core-bridge"], "bridge-secret-test-value");
});


test("Core URL matching never classifies the legacy project as Core", () => {
  const core = bridgePrivate.urlFromInput("https://xqcxckyrlsobdrnidtrp.supabase.co/rest/v1/v9_pages");
  const legacy = bridgePrivate.urlFromInput("https://ezygfpeeqbbirdeazene.supabase.co/rest/v1/v9_pages");
  assert.equal(core.origin, "https://xqcxckyrlsobdrnidtrp.supabase.co");
  assert.notEqual(core.origin, legacy.origin);
});


test("bootstrap runs before Meta token store, server patches and current Core workers", () => {
  const bootstrapAt = startSource.indexOf("await bootstrapV9CoreBridge()");
  const tokenStoreAt = startSource.indexOf('await import("./meta-token-store.js")');
  const serverAt = startSource.indexOf('await safeImport("./patch-server.js")');
  const workerAt = Math.max(
    startSource.indexOf('startDetached("./v10-direct-core-worker.js")'),
    startSource.indexOf('startDetached("./v9-direct-core-worker.js")'),
  );
  assert.ok(bootstrapAt >= 0);
  assert.ok(tokenStoreAt > bootstrapAt);
  assert.ok(serverAt > tokenStoreAt);
  assert.ok(workerAt > serverAt);
});


test("database bridge compatibility key is explicitly documented as publishable, not service-role", () => {
  assert.match(bootstrapSource, /Compatibility only/);
  assert.match(bootstrapSource, /never a Core service-role key/);
  assert.match(bootstrapSource, /AIGUKA_V9_CORE_AUTH_MODE = "database_bridge"/);
  assert.match(bootstrapSource, /installV9CoreBridgeFetch/);
});


test("bridge source contains no deployed database secret or secret hash", () => {
  assert.doesNotMatch(bootstrapSource, /e3bcdfd89c3a93ffb66e30cb447569eb/i);
  assert.doesNotMatch(bootstrapSource, /[a-f0-9]{96}/i);
  assert.doesNotMatch(startSource, /[a-f0-9]{96}/i);
});


test("router remains fail-closed when bootstrap does not provide a usable key", () => {
  assert.match(routerSource, /V9_CORE_CREDENTIAL_REQUIRED/);
  assert.match(routerSource, /refusing legacy v9_\* access/);
  assert.match(startSource, /v9CoreBridgeState\.ready === true/);
});


test("cutover timestamp is normalized and propagated to the inbox bridge", () => {
  const iso = "2026-07-29T18:55:08.230Z";
  assert.equal(bridgePrivate.validIso(iso), iso);
  assert.equal(bridgePrivate.validIso("invalid", iso), iso);
  assert.match(bootstrapSource, /bootstrap\.cutover_at/);
  assert.match(bootstrapSource, /AIGUKA_V9_BRIDGE_CUTOVER_AT = cutoverAt/);
});


test("legacy inbox bridge accepts only rows created after the durable cutover", () => {
  assert.match(inboxBridgeSource, /v9_legacy_inbox_bridge_v2_cutover/);
  assert.match(inboxBridgeSource, /created_at=gte\.\$\{encodeURIComponent\(CUTOVER_AT\)\}/);
  assert.match(inboxBridgeSource, /historical_replay_enabled: false/);
  assert.match(inboxBridgeSource, /cutover_at: CUTOVER_AT/);
  assert.doesNotMatch(inboxBridgeSource, /replaying durable legacy inbox/);
});
