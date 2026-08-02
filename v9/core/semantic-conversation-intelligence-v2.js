import {
  buildConversationTurn as buildSemanticTurn,
  detectSemanticProductKeys as detectSemanticProducts,
  detectSemanticIntents,
  PRODUCT_LABELS,
  normalizeVietnamese,
} from "./semantic-conversation-intelligence.js";

const unique = (values) => [...new Set((values || []).filter(Boolean))];

function safeReferral(value) {
  return value && typeof value === "object" ? value : { source: "ORGANIC" };
}

function hasRealReferral(value) {
  if (!value || typeof value !== "object") return false;
  const source = String(value.source || "").toUpperCase();
  return Boolean(
    value.ad_id
    || value.ads_context_data
    || value.adsContextData
    || source === "ADS"
    || source === "AD"
  );
}

function messageText(message) {
  return String(message?.text ?? message?.message_text ?? "");
}

export function detectSemanticProductKeys(value, options = {}) {
  return detectSemanticProducts(value, { ...options, referral: safeReferral(options.referral) });
}

function latestRequestProductState(turn) {
  const currentMessages = Array.isArray(turn?.customerMessages) ? turn.customerMessages : [];
  const contextMessages = Array.isArray(turn?.contextCustomerMessages) ? turn.contextCustomerMessages : currentMessages;
  const referral = safeReferral(turn?.referral);
  const segments = contextMessages.map((message) => ({
    text: messageText(message),
    products: detectSemanticProductKeys(messageText(message), { referral }),
  }));
  const productSegments = segments.filter((segment) => segment.products.length);
  const latest = productSegments.at(-1) || null;
  const requestedProducts = unique(productSegments.flatMap((segment) => segment.products));
  const latestProducts = latest?.products || [];
  let allowedProducts = [];

  // A single quick-reply mentioning both bathroom and kitchen must serve the first
  // requested group (bathroom) and preserve kitchen as pending. A later, separate
  // request such as "Tư vấn gạch ốp lát" always supersedes that earlier group.
  if (latestProducts.includes("combo_phong_tam") && latestProducts.includes("phong_bep")) {
    allowedProducts = ["combo_phong_tam"];
  } else if (latestProducts.length) {
    allowedProducts = [latestProducts[0]];
  } else {
    const referralProducts = detectSemanticProductKeys("", { referral });
    allowedProducts = referralProducts.length ? [referralProducts[0]] : [];
  }

  return {
    segments,
    requestedProducts,
    allowedProducts,
    primaryProduct: allowedProducts[0] || null,
    pendingProducts: requestedProducts.filter((key) => !allowedProducts.includes(key)),
  };
}

export function buildConversationTurn(events, options = {}) {
  let carriedReferral = null;
  const safeEvents = (events || []).map((event) => {
    if (hasRealReferral(event?.referral)) carriedReferral = event.referral;
    return {
      ...event,
      // Follow-up messages normally omit the referral payload. Carry the last real
      // ad referral forward instead of replacing it with a fake ORGANIC referral.
      referral: hasRealReferral(event?.referral)
        ? event.referral
        : carriedReferral || safeReferral(event?.referral),
    };
  });
  const turn = buildSemanticTurn(safeEvents, options);
  if (!turn?.valid) return turn;

  const state = latestRequestProductState(turn);
  const originalSignals = turn.salesSignals || {};
  turn.salesSignals = {
    ...originalSignals,
    products: state.allowedProducts,
    allowedProducts: state.allowedProducts,
    primaryProduct: state.primaryProduct,
    requestedProducts: state.requestedProducts,
    pendingProducts: state.pendingProducts,
    productLock: state.allowedProducts.length ? "hard" : "none",
    productSource: state.allowedProducts.length
      ? "latest_product_request_segment"
      : originalSignals.productSource || null,
    requestSegments: state.segments,
  };
  turn.contextPolicy = {
    ...(turn.contextPolicy || {}),
    semantic_product_lock: turn.salesSignals.productLock,
    semantic_primary_product: state.primaryProduct,
    semantic_pending_products: state.pendingProducts,
    semantic_request_order: state.requestedProducts,
  };
  return turn;
}

export { detectSemanticIntents, PRODUCT_LABELS, normalizeVietnamese };
