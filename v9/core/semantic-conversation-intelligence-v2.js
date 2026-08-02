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

function isCustomerEvent(event) {
  const type = String(event?.event_type || event?.eventType || "").toLowerCase();
  return ["customer_message", "customer_postback"].includes(type);
}

export function detectSemanticProductKeys(value, options = {}) {
  return detectSemanticProducts(value, { ...options, referral: safeReferral(options.referral) });
}

function segmentProducts(event) {
  const text = messageText(event);
  const normalized = normalizeVietnamese(text);
  const explicitProducts = detectSemanticProductKeys(text, { referral: { source: "ORGANIC" } });
  const referralEnhanced = detectSemanticProductKeys(text, { referral: safeReferral(event?.referral) });
  const hasReferralQualifier = /\b(vang guong|ma vang|mau vang|gold|mau den|black|mau nau|brown|van go|mau go|wood|10 canh|quat)\b/.test(normalized);

  // Referral may provide the product family for a short qualifier such as "vàng
  // gương". It must not turn a later generic phrase such as "cho xin giá" into a
  // new, less-specific product request that overwrites the prior exact color.
  if (explicitProducts.length || hasReferralQualifier) return referralEnhanced.length ? referralEnhanced : explicitProducts;
  return [];
}

function latestRequestProductState(safeEvents, turn) {
  const customerEvents = (safeEvents || []).filter(isCustomerEvent);
  const segments = customerEvents.map((event) => ({
    text: messageText(event),
    products: segmentProducts(event),
    occurredAt: event?.occurred_at || event?.occurredAt || null,
  }));
  const productSegments = segments.filter((segment) => segment.products.length);
  const latest = productSegments.at(-1) || null;
  const requestedProducts = unique(productSegments.flatMap((segment) => segment.products));
  const latestProducts = latest?.products || [];
  let allowedProducts = [];

  // A single quick-reply mentioning both bathroom and kitchen serves bathroom
  // first and keeps kitchen pending. A later separate request always supersedes it.
  if (latestProducts.includes("combo_phong_tam") && latestProducts.includes("phong_bep")) {
    allowedProducts = ["combo_phong_tam"];
  } else if (latestProducts.length) {
    allowedProducts = [latestProducts[0]];
  } else {
    const referralProducts = detectSemanticProductKeys("", { referral: safeReferral(turn?.referral) });
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
      // Follow-up messages normally omit referral. Carry the last real ad referral
      // forward instead of replacing it with an artificial ORGANIC referral.
      referral: hasRealReferral(event?.referral)
        ? event.referral
        : carriedReferral || safeReferral(event?.referral),
    };
  });
  const turn = buildSemanticTurn(safeEvents, options);
  if (!turn?.valid) return turn;

  const state = latestRequestProductState(safeEvents, turn);
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
