import assert from "node:assert/strict";
import test from "node:test";
import {
  decisionRetryReady,
  prioritizeUnhandledDecisions,
} from "../v10/core/decision-queue-priority.js";

function row(id, customerAt, extra = {}) {
  return {
    id,
    page_id: "page-1",
    sender_id: `customer-${id}`,
    source_event_id: `event-${id}`,
    created_at: customerAt,
    input_snapshot: {
      state: { last_customer_event_at: customerAt },
      conversation: { messages: [{ role: "customer", occurred_at: customerAt }] },
    },
    ...extra,
  };
}

function stateFor(value, overrides = {}) {
  return {
    last_source_event_id: value.source_event_id,
    last_customer_event_at: value.input_snapshot.state.last_customer_event_at,
    last_page_event_at: null,
    human_takeover: false,
    ...overrides,
  };
}

test("current unanswered customers outrank stale work and stay oldest-first", () => {
  const stale = row("stale", "2026-08-15T08:00:00Z");
  const older = row("older", "2026-08-15T09:00:00Z");
  const newer = row("newer", "2026-08-15T10:00:00Z");
  const states = new Map([
    ["page-1:customer-stale", stateFor(stale, { last_source_event_id: "another-event" })],
    ["page-1:customer-older", stateFor(older)],
    ["page-1:customer-newer", stateFor(newer)],
  ]);
  const sorted = prioritizeUnhandledDecisions([newer, stale, older], { statesByConversation: states });
  assert.deepEqual(sorted.map((item) => item.id), ["older", "newer", "stale"]);
});

test("a recovered provider immediately releases only provider-wait rows", () => {
  const nowMs = Date.parse("2026-08-16T10:00:00Z");
  const future = "2026-08-16T12:00:00Z";
  assert.equal(decisionRetryReady({ output: { retry_not_before: future, provider_wait_reason: "NO_AI_PROVIDER_CURRENTLY_AVAILABLE" } }, { nowMs, providerAvailable: true }), true);
  assert.equal(decisionRetryReady({ output: { retry_not_before: future, provider_wait_reason: "DECISION_RETRY" } }, { nowMs, providerAvailable: true }), false);
  assert.equal(decisionRetryReady({ output: { retry_not_before: future, provider_wait_reason: "NO_AI_PROVIDER_CURRENTLY_AVAILABLE" } }, { nowMs, providerAvailable: false }), false);
});

test("active human takeover removes a row from the untreated priority lane", () => {
  const human = row("human", "2026-08-15T08:00:00Z");
  const bot = row("bot", "2026-08-15T09:00:00Z");
  const states = new Map([
    ["page-1:customer-human", stateFor(human, { human_takeover: true, human_takeover_until: "2026-08-16T11:00:00Z" })],
    ["page-1:customer-bot", stateFor(bot)],
  ]);
  const sorted = prioritizeUnhandledDecisions([human, bot], {
    statesByConversation: states,
    nowMs: Date.parse("2026-08-16T10:00:00Z"),
  });
  assert.deepEqual(sorted.map((item) => item.id), ["bot", "human"]);
});

test("priority age follows the latest customer turn, not old conversation history", () => {
  const recentlyReturned = row("returned", "2026-08-16T09:00:00Z");
  recentlyReturned.input_snapshot.conversation.messages.unshift({
    role: "customer",
    occurred_at: "2026-08-01T09:00:00Z",
  });
  const waiting = row("waiting", "2026-08-16T08:00:00Z");
  const states = new Map([
    ["page-1:customer-returned", stateFor(recentlyReturned)],
    ["page-1:customer-waiting", stateFor(waiting)],
  ]);
  const sorted = prioritizeUnhandledDecisions([recentlyReturned, waiting], { statesByConversation: states });
  assert.deepEqual(sorted.map((item) => item.id), ["waiting", "returned"]);
});
