function parsedTime(value, fallback = Number.POSITIVE_INFINITY) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function decisionConversationKey(row = {}) {
  return `${String(row.page_id || "")}:${String(row.sender_id || "")}`;
}

export function decisionCustomerWaitAt(row = {}) {
  const stateAt = parsedTime(row?.input_snapshot?.state?.last_customer_event_at);
  const messageTimes = (row?.input_snapshot?.conversation?.messages || [])
    .filter((message) => message?.role === "customer")
    .map((message) => parsedTime(message?.occurred_at || message?.received_at))
    .filter(Number.isFinite);
  const messageAt = messageTimes.length ? Math.max(...messageTimes) : Number.POSITIVE_INFINITY;
  const candidates = [stateAt, messageAt].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : parsedTime(row.created_at, 0);
}

export function decisionIsCurrentUnhandled(row = {}, state = null, nowMs = Date.now()) {
  if (!state || String(state.last_source_event_id || "") !== String(row.source_event_id || "")) return false;
  const customerAt = parsedTime(state.last_customer_event_at, 0);
  const pageAt = parsedTime(state.last_page_event_at, 0);
  if (customerAt <= pageAt) return false;
  if (!state.human_takeover) return true;
  const takeoverUntil = parsedTime(state.human_takeover_until, Number.POSITIVE_INFINITY);
  return takeoverUntil <= nowMs;
}

export function decisionRetryReady(row = {}, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const retryAt = parsedTime(row?.output?.retry_not_before);
  if (!Number.isFinite(retryAt) || retryAt <= nowMs) return true;
  return options.providerAvailable === true
    && row?.output?.provider_wait_reason === "NO_AI_PROVIDER_CURRENTLY_AVAILABLE";
}

export function prioritizeUnhandledDecisions(rows = [], options = {}) {
  const states = options.statesByConversation instanceof Map ? options.statesByConversation : new Map();
  const nowMs = Number(options.nowMs || Date.now());
  return [...rows].sort((left, right) => {
    const leftCurrent = decisionIsCurrentUnhandled(left, states.get(decisionConversationKey(left)), nowMs);
    const rightCurrent = decisionIsCurrentUnhandled(right, states.get(decisionConversationKey(right)), nowMs);
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
    const customerDiff = decisionCustomerWaitAt(left) - decisionCustomerWaitAt(right);
    if (customerDiff) return customerDiff;
    const createdDiff = parsedTime(left.created_at, 0) - parsedTime(right.created_at, 0);
    if (createdDiff) return createdDiff;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
}

export const decisionQueuePriorityVersion = "v10_current_unanswered_fifo_v1";
