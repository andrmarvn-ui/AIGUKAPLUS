export const CONVERSATION_STATES = Object.freeze([
  "RECEIVED",
  "DEBOUNCING",
  "CONTACT_CAPTURED",
  "CONTEXT_READY",
  "DECIDED",
  "STAGED",
  "SENT",
  "ANSWERED_BY_HUMAN",
  "SUPERSEDED_BY_NEW_MESSAGE",
  "RETRYABLE_ERROR",
  "DEAD_LETTER",
]);

const TERMINAL = new Set(["CONTACT_CAPTURED", "SENT", "ANSWERED_BY_HUMAN", "DEAD_LETTER"]);

export function reduceConversationState(current, event, contact, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const slaSeconds = Math.max(30, Number(options.slaSeconds || 90));
  const previous = current || {};

  if (!event || !event.eventType) throw new TypeError("V9_EVENT_REQUIRED");

  if (event.eventType === "customer_message" || event.eventType === "customer_postback") {
    const nextVersion = Number(previous.version || 0) + 1;
    if (contact?.contactCaptured) {
      return {
        ...previous,
        state: "CONTACT_CAPTURED",
        version: nextVersion,
        contactStatus: "captured",
        phone: contact.primaryPhone || previous.phone || null,
        lastCustomerEventAt: event.occurredAt,
        responseDeadlineAt: null,
        updatedAt: now.toISOString(),
      };
    }

    return {
      ...previous,
      state: "RECEIVED",
      version: nextVersion,
      contactStatus: previous.contactStatus || "missing",
      lastCustomerEventAt: event.occurredAt,
      responseDeadlineAt: new Date(now.getTime() + slaSeconds * 1000).toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  if (event.eventType === "page_message") {
    return {
      ...previous,
      // A Page-originated message is not automatically a verified human answer.
      state: previous.state || "RECEIVED",
      version: Number(previous.version || 0) + 1,
      lastPageEventAt: event.occurredAt,
      updatedAt: now.toISOString(),
    };
  }

  return {
    ...previous,
    state: previous.state || "RECEIVED",
    version: Number(previous.version || 0) + 1,
    updatedAt: now.toISOString(),
  };
}

export function canTransition(from, to) {
  if (!CONVERSATION_STATES.includes(to)) return false;
  if (!from) return to === "RECEIVED" || to === "CONTACT_CAPTURED";
  if (from === to) return true;
  if (TERMINAL.has(from)) return to === "SUPERSEDED_BY_NEW_MESSAGE";
  return true;
}
