const TERMINAL_ACTORS = new Set(["sale", "admin"]);

function time(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildConversationTurn(events, options = {}) {
  const debounceSeconds = Math.max(5, Math.min(60, Number(options.debounceSeconds || 20)));
  const ordered = [...(events || [])]
    .filter((event) => event && event.occurred_at)
    .sort((a, b) => time(a.occurred_at) - time(b.occurred_at));

  const customerEvents = ordered.filter((event) => event.actor_type === "customer" && ["customer_message", "customer_postback"].includes(event.event_type));
  if (!customerEvents.length) return null;

  const latest = customerEvents.at(-1);
  const cutoff = time(latest.occurred_at) - debounceSeconds * 1000;
  const turnEvents = customerEvents.filter((event) => time(event.occurred_at) >= cutoff);
  const firstAt = turnEvents[0].occurred_at;
  const lastAt = latest.occurred_at;

  const pageEventsAfterFirst = ordered.filter((event) => time(event.occurred_at) >= time(firstAt) && event.actor_type !== "customer");
  const verifiedHumanAfterCustomer = pageEventsAfterFirst.find((event) => TERMINAL_ACTORS.has(event.actor_type) && event.actor_evidence?.human_verified === true);
  const automationAfterCustomer = pageEventsAfterFirst.filter((event) => ["automation", "bot", "page_unknown"].includes(event.actor_type));

  const text = turnEvents.map((event) => String(event.message_text || "").trim()).filter(Boolean).join("\n");
  const attachments = turnEvents.flatMap((event) => Array.isArray(event.attachments) ? event.attachments : []);

  return {
    sourceEventIds: turnEvents.map((event) => event.source_event_id),
    firstAt,
    lastAt,
    text,
    attachments,
    messageCount: turnEvents.length,
    verifiedHumanAfterCustomer: Boolean(verifiedHumanAfterCustomer),
    verifiedHumanEventId: verifiedHumanAfterCustomer?.source_event_id || null,
    nonHumanPageEventsAfterCustomer: automationAfterCustomer.map((event) => ({
      source_event_id: event.source_event_id,
      actor_type: event.actor_type,
      provider: event.actor_evidence?.provider || null,
    })),
    shouldSuppressBot: Boolean(verifiedHumanAfterCustomer),
    suppressionReason: verifiedHumanAfterCustomer ? "verified_human_takeover" : null,
  };
}
