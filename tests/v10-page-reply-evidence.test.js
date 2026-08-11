import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildObservedPageReplyEvent,
  customerSlaSourceIds,
  observedPageReplyDisposition,
  observedPageReplyStatePatch,
} from "../v10/core/page-reply-evidence.js";

test("AICake is persisted as automation and never as human takeover", () => {
  const disposition = observedPageReplyDisposition({ source_system: "aicake" });
  assert.equal(disposition.actor_type, "automation");
  assert.equal(disposition.event_type, "automation_message");
  assert.equal(disposition.human_takeover, false);

  const patch = observedPageReplyStatePatch({ state: "RECEIVED", human_takeover: false }, {
    source_system: "aicake",
    sent_at: "2026-08-11T09:03:44Z",
  }, Date.parse("2026-08-11T09:03:45Z"));
  assert.equal(patch.state, "BOT_REPLIED");
  assert.equal(patch.response_deadline_at, null);
  assert.equal(patch.human_takeover, undefined);
});

test("verified human replies retain the permanent human takeover rule", () => {
  const patch = observedPageReplyStatePatch({ state: "RECEIVED" }, {
    source_system: "human_admin",
    sent_at: "2026-08-11T09:03:44Z",
  }, Date.parse("2026-08-11T09:03:45Z"));
  assert.equal(patch.state, "ANSWERED_BY_HUMAN");
  assert.equal(patch.human_takeover, true);
  assert.equal(patch.human_takeover_until, null);
});

test("Pancake evidence becomes an idempotent non-customer Core event", () => {
  const event = buildObservedPageReplyEvent({
    page_id: "104810069068200",
    sender_id: "28740137332243072",
  }, {
    source_system: "page",
    sent_at: "2026-08-11T09:03:44Z",
    conversation_id: "page_customer",
    message_text: "Anh ở khu vực nào?",
  }, Date.parse("2026-08-11T09:03:45Z"));
  assert.equal(event.source_system, "pancake_live");
  assert.equal(event.actor_type, "page_unknown");
  assert.equal(event.event_type, "page_message");
  assert.equal(event.customer_id, "28740137332243072");
  assert.match(event.source_event_id, /^pancake_live:/);
});

test("all customer events in the active snapshot can have their SLA resolved", () => {
  const decision = {
    input_snapshot: {
      conversation: {
        messages: [
          { role: "customer", id: "legacy_inbox:old", occurred_at: "2026-08-10T09:00:00Z" },
          { role: "customer", id: "legacy_inbox:first", occurred_at: "2026-08-11T09:00:00Z" },
          { role: "customer", id: "legacy_inbox:second", occurred_at: "2026-08-11T09:02:00Z" },
          { role: "page", id: "page:reply" },
          { role: "customer", id: "legacy_inbox:second", occurred_at: "2026-08-11T09:02:00Z" },
        ],
      },
    },
  };
  assert.deepEqual(customerSlaSourceIds(decision), ["legacy_inbox:first", "legacy_inbox:second"]);
});

test("live worker persists Page evidence, closes SLA and clears the response deadline", () => {
  const worker = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  assert.match(worker, /persistObservedPageReply/);
  assert.match(worker, /v9_events\?on_conflict=source_system,source_event_id/);
  assert.match(worker, /v9_sla_events\?source_event_id=eq\./);
  assert.match(worker, /response_deadline_at: null/);
  assert.match(worker, /v10_outbound_single_gateway_v16_page_reply_evidence/);
});
