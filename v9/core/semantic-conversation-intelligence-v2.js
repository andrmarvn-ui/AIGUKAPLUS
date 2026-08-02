import {
  buildConversationTurn as buildSemanticTurn,
  detectSemanticProductKeys as detectSemanticProducts,
  detectSemanticIntents,
  PRODUCT_LABELS,
  normalizeVietnamese,
} from "./semantic-conversation-intelligence.js";

function safeReferral(value) {
  return value && typeof value === "object" ? value : { source: "ORGANIC" };
}

export function detectSemanticProductKeys(value, options = {}) {
  return detectSemanticProducts(value, { ...options, referral: safeReferral(options.referral) });
}

export function buildConversationTurn(events, options = {}) {
  const safeEvents = (events || []).map((event) => ({
    ...event,
    referral: safeReferral(event?.referral),
  }));
  return buildSemanticTurn(safeEvents, options);
}

export { detectSemanticIntents, PRODUCT_LABELS, normalizeVietnamese };
