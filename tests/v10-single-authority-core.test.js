import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { humanTakeoverActive, resolveChannelAuthority } from "../v10/core/constitution.js";
import { createMessageGateway, DISPATCH_OWNERS } from "../v10/core/message-gateway.js";

const primaryRuntime = {
  mode: "ACTIVE",
  ingest_mode: "DIRECT_CORE",
  external_bot_mode: "AICAKE_DISABLED",
  external_bot_policy: "AIGUKA_PRIMARY",
};
const supportRuntime = {
  mode: "ACTIVE",
  ingest_mode: "DIRECT_CORE",
  external_bot_mode: "AICAKE_ACTIVE",
  external_bot_policy: "AICAKE_PRIMARY_SUPPORT",
};

test("one constitution assigns non-overlapping live ownership", () => {
  const primary = resolveChannelAuthority({
    runtime: primaryRuntime,
    page: { is_active: true, operating_mode: "ACTIVE", coexistence_mode: "AICAKE_DISABLED", settings: {} },
    channel: "live",
  });
  assert.equal(primary.text_owner, "aiguka");
  assert.equal(primary.media_owner, "aiguka");

  const support = resolveChannelAuthority({
    runtime: supportRuntime,
    page: { is_active: true, operating_mode: "SUPPORT", coexistence_mode: "AICAKE_ACTIVE", settings: { support_enabled: true } },
    channel: "live",
  });
  assert.equal(support.text_owner, "aicake");
  assert.equal(support.media_owner, "aiguka");
  assert.equal(support.operational_fallback_owner, "aiguka");

  const mismatched = resolveChannelAuthority({
    runtime: supportRuntime,
    page: { is_active: true, operating_mode: "ACTIVE", coexistence_mode: "AICAKE_DISABLED", settings: {} },
  });
  assert.equal(mismatched.allowed, false);
});

test("verified human takeover has no artificial timeout", () => {
  assert.equal(humanTakeoverActive({ human_takeover: true, human_takeover_until: null }), true);
  assert.equal(humanTakeoverActive({ human_takeover: true, human_takeover_until: "2000-01-01T00:00:00Z" }), false);
  assert.equal(humanTakeoverActive({ human_takeover: false }), false);
});

test("both delivery workers depend on the sole Message Gateway", () => {
  const outbound = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  const followup = fs.readFileSync(new URL("../v10-followup-worker.js", import.meta.url), "utf8");
  const gateway = fs.readFileSync(new URL("../v10/core/message-gateway.js", import.meta.url), "utf8");
  for (const worker of [outbound, followup]) {
    assert.match(worker, /createMessageGateway/);
    assert.match(worker, /claimDispatch/);
    assert.match(worker, /releaseDispatch/);
    assert.doesNotMatch(worker, /graph\.facebook\.com|["'`]me\/messages/);
  }
  assert.match(gateway, /graph\.facebook\.com/);
  assert.match(gateway, /["'`]me\/messages/);
});

test("gateway obtains a database lease before using Meta transport", async () => {
  const rpcCalls = [];
  const metaCalls = [];
  const gateway = createMessageGateway({
    coreRequest: async (path, options) => {
      rpcCalls.push({ path, options });
      if (path.includes("claim")) return [{ granted: true, current_owner: DISPATCH_OWNERS.LIVE }];
      return [{ released: true }];
    },
    loadConnection: async () => ({ accessToken: "user-token" }),
    fetchImpl: async (url, options = {}) => {
      metaCalls.push({ url: String(url), options });
      if (String(url).includes("me/accounts")) {
        return new Response(JSON.stringify({ data: [{ id: "page-1", access_token: "page-token" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message_id: "mid-1" }), { status: 200 });
    },
  });

  const claim = await gateway.claimDispatch({ pageId: "page-1", senderId: "customer-1", owner: DISPATCH_OWNERS.LIVE, dedupeKey: "live:d1", priority: 100 });
  assert.equal(claim.granted, true);
  const sent = await gateway.sendText("page-1", "customer-1", "Dạ em đã nhận ạ.");
  assert.equal(sent.message_id, "mid-1");
  await gateway.releaseDispatch({ pageId: "page-1", senderId: "customer-1", owner: DISPATCH_OWNERS.LIVE, dedupeKey: "live:d1", result: "sent" });

  assert.deepEqual(rpcCalls.map((call) => call.path), ["rpc/v10_claim_message_dispatch", "rpc/v10_release_message_dispatch"]);
  assert.equal(metaCalls.filter((call) => call.options.method === "POST").length, 1);
});

test("dispatch migration is private, bridge-authorized and live-first", () => {
  const migration = fs.readFileSync(new URL("../supabase/migrations/20260811153000_v10_single_message_gateway_dispatch_lease.sql", import.meta.url), "utf8");
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.v10_message_dispatch from public, anon, authenticated/i);
  assert.match(migration, /v9_bridge_request_allowed\(\)/);
  assert.match(migration, /p_owner='aiguka_followup' and exists/);
  assert.match(migration, /LIVE_DECISION_PENDING/);
});

test("load shed circuit only observes the Supabase Data API", () => {
  const source = fs.readFileSync(new URL("../patch-supabase-load-shed-fetch.js", import.meta.url), "utf8");
  assert.match(source, /!url\.pathname\.startsWith\("\/rest\/v1\/"\)/);
  assert.match(source, /if \(wasOpen\) console\.log\("\[AIGUKA load shed\] Supabase recovered/);
});

