function parsedTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function outboundDecisionCustomerAt(decision = {}) {
  const snapshot = decision?.input_snapshot || {};
  const stateAt = parsedTime(snapshot?.state?.last_customer_event_at);
  const latestAt = parsedTime(snapshot?.conversation?.latest_customer_message?.occurred_at);
  const messageAt = Math.max(0, ...(snapshot?.conversation?.messages || [])
    .filter((message) => message?.role === "customer")
    .map((message) => parsedTime(message?.occurred_at)));
  return Math.max(stateAt, latestAt, messageAt, parsedTime(decision.created_at));
}

export function currentUnansweredRecoveryEligible(decision = {}, state = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeMs = Math.max(1, Number(options.maxAgeMs || 72 * 60 * 60_000));
  const createdAt = parsedTime(decision.created_at);
  if (!createdAt || nowMs - createdAt > maxAgeMs) return false;
  if (String(state.last_source_event_id || "") !== String(decision.source_event_id || "")) return false;
  const customerAt = parsedTime(state.last_customer_event_at);
  const pageAt = parsedTime(state.last_page_event_at);
  return customerAt > pageAt;
}

export function prioritizeOutboundDecisions(decisions = [], options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const responseSlaSeconds = Math.max(1, Number(options.responseSlaSeconds || 45));
  const freshWindowMs = Math.max(120_000, responseSlaSeconds * 2_000);
  const annotated = (Array.isArray(decisions) ? decisions : []).map((decision, index) => {
    const customerAt = outboundDecisionCustomerAt(decision);
    const ageMs = Math.max(0, nowMs - customerAt);
    return {
      decision,
      index,
      customerAt,
      ageMs,
      lane: ageMs <= freshWindowMs ? "fresh_sla" : "recovery_backlog",
    };
  });

  annotated.sort((left, right) => {
    if (left.lane !== right.lane) return left.lane === "fresh_sla" ? -1 : 1;
    if (left.lane === "fresh_sla") {
      return left.customerAt - right.customerAt || left.index - right.index;
    }
    return left.customerAt - right.customerAt || left.index - right.index;
  });

  return {
    rows: annotated.map((item) => item.decision),
    fresh_count: annotated.filter((item) => item.lane === "fresh_sla").length,
    recovery_count: annotated.filter((item) => item.lane === "recovery_backlog").length,
    fresh_window_ms: freshWindowMs,
    newest_customer_at: annotated.length ? new Date(Math.max(...annotated.map((item) => item.customerAt))).toISOString() : null,
  };
}

export const outboundPriorityVersion = "v10_outbound_priority_v2_fresh_then_oldest_recovery";

