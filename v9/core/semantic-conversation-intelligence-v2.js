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

function sourceEventId(event) {
  return String(event?.source_event_id || event?.sourceEventId || "");
}

function isCustomerEvent(event) {
  const type = String(event?.event_type || event?.eventType || "").toLowerCase();
  return ["customer_message", "customer_postback"].includes(type);
}

function hasPriorityInstruction(value) {
  const normalized = normalizeVietnamese(value);
  return /\b(truoc|uu tien|lam truoc|tu van truoc)\b/.test(normalized)
    || /(?:^|\s)da$/.test(normalized);
}

function tileConstructionOnly(normalized) {
  const tileAction = /\b(op|lat|gach|op lat|lat nen|op tuong)\b/.test(normalized);
  const projectQuantity = /\b([0-9]+\s*(m2|m)|[0-9]+\s*v\s*s|[0-9]+\s*wc|khoang\s*[0-9]+)\b/.test(normalized);
  const explicitOtherProduct = /\b(thiet bi ve sinh|thiet bi nha tam|thiet bi phong tam|combo nha tam|combo phong tam|bon cau|lavabo|tu lavabo|sen tam|sen cay|bon tam|bep tu|bep dien|may hut mui|hut mui|chau rua bat|chau 1 ho|voi rua bat|tu van nha tam|tu van phong tam|tu van nha bep|tu van phong bep)\b/.test(normalized);
  return tileAction && projectQuantity && !explicitOtherProduct;
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

  // In a construction sentence such as "ốp 4 WC và khu bếp khoảng 100m",
  // WC/kitchen describe tile locations, not requests for bathroom/kitchen equipment.
  if (tileConstructionOnly(normalized)) return ["gach_da_op_lat"];

  // Referral may supply a family for a short qualifier such as "vàng gương".
  // Generic follow-ups such as "cho xin giá" must not create a new product.
  if (explicitProducts.length || hasReferralQualifier) {
    return referralEnhanced.length ? referralEnhanced : explicitProducts;
  }
  return [];
}

function buildSegments(safeEvents) {
  return (safeEvents || [])
    .filter(isCustomerEvent)
    .map((event, index) => {
      const text = messageText(event);
      const intentInfo = detectSemanticIntents(text);
      return {
        index,
        sourceEventId: sourceEventId(event) || null,
        text,
        products: segmentProducts(event),
        intents: Array.isArray(intentInfo?.intents) ? intentInfo.intents : [],
        explicitPriority: hasPriorityInstruction(text),
        occurredAt: event?.occurred_at || event?.occurredAt || null,
      };
    });
}

function multiProductRequestState(safeEvents, turn) {
  const segments = buildSegments(safeEvents);
  const activeIds = new Set((turn?.customerMessages || []).map((item) => String(item?.sourceEventId || item?.source_event_id || "")).filter(Boolean));
  const activeSegments = segments.filter((segment) => activeIds.has(String(segment.sourceEventId || "")));
  const activeProductSegments = activeSegments.filter((segment) => segment.products.length);
  const contextProductSegments = segments.filter((segment) => segment.products.length);
  const prioritySegments = activeProductSegments.filter((segment) => segment.explicitPriority);

  let activeProducts = [];
  let selectionReason = "none";

  if (prioritySegments.length) {
    // A customer can explicitly say "nhà tắm trước". Only that explicitly
    // prioritised segment is active; the other requested groups remain pending.
    activeProducts = unique(prioritySegments.at(-1).products);
    selectionReason = "explicit_priority_segment";
  } else if (activeProductSegments.length) {
    // All groups mentioned in the same active customer turn are active. Never
    // collapse a multi-product request to products[0].
    activeProducts = unique(activeProductSegments.flatMap((segment) => segment.products));
    selectionReason = activeProducts.length > 1 ? "active_turn_multi_product" : "active_turn_product";
  } else if (contextProductSegments.length) {
    // An anaphoric follow-up such as "cho xem" inherits the complete latest
    // product-bearing segment, not only its first product.
    activeProducts = unique(contextProductSegments.at(-1).products);
    selectionReason = "latest_context_segment";
  } else {
    const referralProducts = detectSemanticProductKeys("", { referral: safeReferral(turn?.referral) });
    activeProducts = unique(referralProducts);
    selectionReason = activeProducts.length ? "referral_product" : "none";
  }

  const requestedProducts = unique(contextProductSegments.flatMap((segment) => segment.products));
  for (const product of activeProducts) {
    if (!requestedProducts.includes(product)) requestedProducts.push(product);
  }
  const pendingProducts = requestedProducts.filter((key) => !activeProducts.includes(key));

  const requestPlan = requestedProducts.map((productKey, order) => {
    const related = contextProductSegments.filter((segment) => segment.products.includes(productKey));
    const latest = related.at(-1) || null;
    return {
      productKey,
      order,
      state: activeProducts.includes(productKey) ? "active" : "pending",
      sourceEventId: latest?.sourceEventId || null,
      requestedAt: latest?.occurredAt || null,
      explicitPriority: Boolean(latest?.explicitPriority && activeProducts.includes(productKey)),
      intents: unique(related.flatMap((segment) => segment.intents)),
      text: latest?.text || "",
    };
  });

  return {
    segments,
    requestPlan,
    requestedProducts,
    activeProducts,
    allowedProducts: activeProducts,
    primaryProduct: activeProducts[0] || null,
    pendingProducts,
    selectionReason,
  };
}

export function buildConversationTurn(events, options = {}) {
  let carriedReferral = null;
  const safeEvents = (events || []).map((event) => {
    if (hasRealReferral(event?.referral)) carriedReferral = event.referral;
    return {
      ...event,
      referral: hasRealReferral(event?.referral)
        ? event.referral
        : carriedReferral || safeReferral(event?.referral),
    };
  });

  const turn = buildSemanticTurn(safeEvents, options);
  if (!turn?.valid) return turn;

  const state = multiProductRequestState(safeEvents, turn);
  const originalSignals = turn.salesSignals || {};
  const lock = state.allowedProducts.length > 1
    ? "hard_multi"
    : state.allowedProducts.length === 1 ? "hard" : "none";

  turn.salesSignals = {
    ...originalSignals,
    products: state.allowedProducts,
    activeProducts: state.activeProducts,
    allowedProducts: state.allowedProducts,
    primaryProduct: state.primaryProduct,
    requestedProducts: state.requestedProducts,
    pendingProducts: state.pendingProducts,
    requestPlan: state.requestPlan,
    productLock: lock,
    productSource: state.allowedProducts.length
      ? state.selectionReason
      : originalSignals.productSource || null,
    requestSegments: state.segments,
    multiProduct: state.allowedProducts.length > 1,
  };

  turn.contextPolicy = {
    ...(turn.contextPolicy || {}),
    semantic_product_lock: lock,
    semantic_primary_product: state.primaryProduct,
    semantic_active_products: state.activeProducts,
    semantic_pending_products: state.pendingProducts,
    semantic_request_order: state.requestedProducts,
    semantic_request_plan: state.requestPlan,
    semantic_selection_reason: state.selectionReason,
  };
  return turn;
}

export { detectSemanticIntents, PRODUCT_LABELS, normalizeVietnamese };
