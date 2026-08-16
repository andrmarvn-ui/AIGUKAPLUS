import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { currentUnansweredRecoveryEligible, prioritizeOutboundDecisions } from "../v10/core/outbound-priority.js";
import { createPancakeConversationSnapshotCache } from "../v10/core/pancake-conversation-snapshot.js";
import { bridgeFreshCutoff, prioritizeBridgeCandidates } from "../v9/core/bridge-priority.js";

function decision(id, customerAt, createdAt = customerAt) {
  return {
    id,
    created_at: createdAt,
    input_snapshot: {
      state: { last_customer_event_at: customerAt },
      conversation: {
        messages: [{ role: "customer", occurred_at: customerAt }],
      },
    },
  };
}

test("fresh Trần Hồng decision jumps ahead of a recovered historical backlog", () => {
  const nowMs = Date.parse("2026-08-08T16:54:48Z");
  const backlog = Array.from({ length: 30 }, (_, index) => decision(
    `recovery-${index}`,
    new Date(Date.parse("2026-08-08T15:07:00Z") + index * 60_000).toISOString(),
    new Date(Date.parse("2026-08-08T16:52:00Z") + index * 1000).toISOString(),
  ));
  const tranHong = decision(
    "tran-hong-26891422560552569",
    "2026-08-08T16:54:35.876Z",
    "2026-08-08T16:54:47.864Z",
  );
  const result = prioritizeOutboundDecisions([...backlog, tranHong], {
    nowMs,
    responseSlaSeconds: 45,
  });
  assert.equal(result.rows[0].id, tranHong.id);
  assert.equal(result.fresh_count, 1);
  assert.equal(result.recovery_count, 30);
});

test("fresh lane remains FIFO so normal live traffic is fair", () => {
  const result = prioritizeOutboundDecisions([
    decision("newer", "2026-08-08T16:54:40Z"),
    decision("older", "2026-08-08T16:54:20Z"),
  ], {
    nowMs: Date.parse("2026-08-08T16:55:00Z"),
    responseSlaSeconds: 45,
  });
  assert.deepEqual(result.rows.map((row) => row.id), ["older", "newer"]);
});

test("recovery backlog is oldest-first after the fresh SLA lane", () => {
  const result = prioritizeOutboundDecisions([
    decision("newer-recovery", "2026-08-16T06:00:00Z"),
    decision("older-recovery", "2026-08-15T06:00:00Z"),
    decision("fresh", "2026-08-16T09:59:40Z"),
  ], {
    nowMs: Date.parse("2026-08-16T10:00:00Z"),
    responseSlaSeconds: 45,
  });
  assert.deepEqual(result.rows.map((row) => row.id), ["fresh", "older-recovery", "newer-recovery"]);
});

test("an old decision is recoverable only for the exact unanswered frontier", () => {
  const old = {
    ...decision("old", "2026-08-15T14:00:00Z"),
    source_event_id: "event-old",
  };
  const state = {
    last_source_event_id: "event-old",
    last_customer_event_at: "2026-08-15T14:00:00Z",
    last_page_event_at: "2026-08-15T13:59:00Z",
  };
  const options = {
    nowMs: Date.parse("2026-08-16T10:00:00Z"),
    maxAgeMs: 23.75 * 60 * 60_000,
  };
  assert.equal(currentUnansweredRecoveryEligible(old, state, options), true);
  assert.equal(currentUnansweredRecoveryEligible(old, { ...state, last_source_event_id: "newer-event" }, options), false);
  assert.equal(currentUnansweredRecoveryEligible(old, { ...state, last_page_event_at: "2026-08-15T14:01:00Z" }, options), false);
  assert.equal(currentUnansweredRecoveryEligible(old, { ...state, last_customer_event_at: "2026-08-15T08:00:00Z" }, options), false);
});

test("Pancake page snapshot is shared across concurrent recipient checks", async () => {
  let calls = 0;
  const cache = createPancakeConversationSnapshotCache({
    maxPages: 1,
    ttlMs: 5000,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { conversations: [{ id: "page_customer", updated_at: "2026-08-08T16:54:40Z" }] };
        },
      };
    },
  });
  const [first, second] = await Promise.all([
    cache.load("104810069068200", "token"),
    cache.load("104810069068200", "token"),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first.rows, second.rows);
});

test("bridge serves fresh rows first and caps recovery work", () => {
  assert.equal(
    bridgeFreshCutoff(Date.parse("2026-08-08T16:54:00Z"), 120_000),
    "2026-08-08T16:52:00.000Z",
  );
  const rows = prioritizeBridgeCandidates(
    [{ id: "fresh-1" }, { id: "fresh-2" }],
    [{ id: "old-1" }, { id: "fresh-1" }, { id: "old-2" }],
    4,
  );
  assert.deepEqual(rows.map((row) => [row.id, row.bridge_lane]), [
    ["fresh-1", "fresh"],
    ["fresh-2", "fresh"],
    ["old-1", "recovery"],
    ["old-2", "recovery"],
  ]);
});

test("release keeps the fresh queue and shared Pancake snapshot guards", () => {
  const outbound = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  const bridge = fs.readFileSync(new URL("../v9-legacy-inbox-bridge.js", import.meta.url), "utf8");
  const pancakeGuard = fs.readFileSync(new URL("../patch-v10-live-page-reply-guard.js", import.meta.url), "utf8");
  assert.match(outbound, /order=created_at\.desc&limit=\$\{CANDIDATE_SCAN_LIMIT\}/);
  assert.match(outbound, /fresh_sla_first_then_oldest_unanswered_recovery/);
  assert.match(outbound, /currentUnansweredRecoveryEligible/);
  assert.match(outbound, /MAX_UNANSWERED_RECOVERY_AGE_MS/);
  assert.match(bridge, /fresh_received_first_then_bounded_recovery/);
  assert.match(bridge, /AIGUKA_V9_BRIDGE_RECOVERY_BATCH/);
  assert.match(bridge, /const common = `v8_webhook_inbox\?\$\{select\}/);
  assert.match(pancakeGuard, /createPancakeConversationSnapshotCache/);
  assert.match(pancakeGuard, /pancake_live_shared_page_snapshot/);
});

test("slide test recipient validation follows the live Core event source", () => {
  const slideManager = fs.readFileSync(new URL("../drive-slide-manager-v4.js", import.meta.url), "utf8");
  const slidePatch = fs.readFileSync(new URL("../patch-slide-generic-carousel.js", import.meta.url), "utf8");
  const liveMediaPatch = fs.readFileSync(new URL("../patch-v10-media-delivery-proxy.js", import.meta.url), "utf8");
  const liveOutbound = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  assert.match(slideManager, /v9_events\?page_id=eq\./);
  assert.match(slideManager, /actor_type=eq\.customer&event_type=eq\.customer_message/);
  assert.match(slideManager, /!recentLegacy\?\.length && !recentCore\?\.length/);
  assert.match(slidePatch, /prepareCarouselAssets/);
  assert.match(slidePatch, /supabase_storage_static/);
  assert.match(slidePatch, /const imageUrl = asset\.source_url/);
  assert.match(slidePatch, /default_action:\s*\{\s*type: "web_url",\s*url: imageUrl,/);
  assert.doesNotMatch(slidePatch, /default_action:\s*\{[\s\S]{0,160}url: "https:\/\/zalo\.me\//);
  assert.match(slidePatch, /buttons:\s*\[[\s\S]{0,180}url: "https:\/\/zalo\.me\/0989882690"/);
  assert.match(liveOutbound, /default_action:\s*\{\s*type: "web_url",\s*url: asset\.source_url,/);
  assert.match(liveMediaPatch, /storage_url,storage_status,delivery_url,delivery_status/);
  assert.match(liveMediaPatch, /prepareCarouselAssets/);
});
