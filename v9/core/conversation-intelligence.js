import { detectContact } from "./contact-detector.js";

const CUSTOMER_TYPES = new Set(["customer_message", "customer_postback"]);
const RESPONSE_TYPES = new Set(["human_message", "automation_message", "bot_message", "page_message"]);

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeVietnamese(value) {
  return text(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function timeOf(event) {
  const parsed = Date.parse(String(event?.occurred_at || event?.occurredAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventId(event) {
  return String(event?.source_event_id || event?.sourceEventId || "");
}

function eventType(event) {
  return event?.event_type || event?.eventType || "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function push(array, item) {
  if (item && !array.includes(item)) array.push(item);
}

const PRODUCT_RULES = [
  ["combo_phong_tam", /\b(combo|bo) (thiet bi )?(phong tam|nha tam)\b|\bphong tam tron bo\b/],
  ["bon_cau", /\bbon cau\b|\btoilet\b/],
  ["lavabo", /\blavabo\b|\bchau rua mat\b/],
  ["sen_tam", /\bsen tam\b|\bsen cay\b|\bvoi tam\b/],
  ["bep_tu_hut_mui", /\bbep\b|\bbep dien\b|\bbep [1-9] (tu|vung)\b|\bbep tu\b|\bhut mui\b|\bmay hut mui\b|\bhut khoi\b/],
  ["chau_voi_rua_bat", /\bchau (voi )?rua (bat|chen)\b|\bvoi rua (bat|chen)\b|\bbon rua (bat|bep)\b/],
  ["quat_tran", /\bquat tran\b|\bquat [0-9]+ canh\b/],
  ["den_trang_tri", /\bden chum\b|\bden trang tri\b|\bden tha\b/],
  ["gach_op_lat", /\bgach\b|\bop lat\b|\bgach men\b/],
  ["guong_tu", /\bguong tu\b|\btu guong\b|\btu lavabo\b|\btu chau\b/],
  ["bon_tam", /\bbon tam\b|\bjacuzzi\b/],
];

export function detectProductKeys(value) {
  const normalized = normalizeVietnamese(value);
  const products = [];
  for (const [key, pattern] of PRODUCT_RULES) {
    if (pattern.test(normalized)) push(products, key);
  }
  if (products.includes("bep_tu_hut_mui") && products.includes("chau_voi_rua_bat")
    && /\b(rua bep|bon rua bep)\b/.test(normalized)
    && !/\bbep (dien|tu|[1-9])\b|\bhut mui\b/.test(normalized)) {
    products.splice(products.indexOf("bep_tu_hut_mui"), 1);
  }
  return products;
}

function detectIntents(value, options = {}) {
  const normalized = normalizeVietnamese(value);
  const intents = [];
  const hasProductContext = Boolean(options.hasProductContext);

  const address = /\b(dia chi|o dau|vi tri|showroom|duong di|co so|cua hang)\b/.test(normalized);
  const visit = /\b(den|qua|len|ghe|toi|sang|chieu) (xem|cua hang|showroom)\b|\bxem truc tiep\b|\btruc tiep (xem|qua)\b/.test(normalized);
  const explicitMedia = /\b(mau|hinh|anh|catalog|catalogue|slide)\b|\bchup .* xem\b|\bchup (cho|de)\b|\bgui .*\b(xem|mau|anh|hinh|qua day)\b|\bxem (mau|anh|hinh|catalog|slide)\b/.test(normalized);
  const bareView = /^(cho )?xem( voi| nhe| a| di)?$/.test(normalized) || /\bcho (anh|chi|minh|toi|em)? ?xem\b/.test(normalized);

  if (/\b(gia|bao nhieu|bao gia|chi phi)\b/.test(normalized)) push(intents, "price");
  if (address) push(intents, "address");
  if (visit) push(intents, "visit");
  if (explicitMedia || (bareView && hasProductContext && !visit)) push(intents, "samples");
  if (/\b(xem het|tat ca|day du|co nhung gi)\b/.test(normalized)) push(intents, "all_products");
  if (/\b(mua|chot|dat hang|dat coc|lay bo|lay combo)\b/.test(normalized)) push(intents, "purchase");
  if (/\b(ship|giao hang|van chuyen)\b/.test(normalized)) push(intents, "delivery");
  if (/\b(bao hanh|doi tra)\b/.test(normalized)) push(intents, "warranty");

  return { intents, address, visit, explicitMedia, bareView };
}

export function extractSalesSignals(value, options = {}) {
  const currentProducts = detectProductKeys(value);
  const contextProducts = detectProductKeys(options.contextText || "");
  const fallbackProduct = text(options.lastProductKey);
  const preProductContext = currentProducts.length || contextProducts.length || fallbackProduct;
  const intentInfo = detectIntents(value, { hasProductContext: Boolean(preProductContext) });

  let products = currentProducts;
  let productSource = currentProducts.length ? "current_turn" : null;
  let productConfidence = currentProducts.length ? 0.98 : 0;

  if (!products.length && contextProducts.length) {
    products = contextProducts;
    productSource = "recent_customer_context";
    productConfidence = 0.88;
  }

  const addressOnly = intentInfo.intents.includes("address")
    && !intentInfo.intents.some((item) => ["samples", "price", "purchase", "all_products"].includes(item));
  const anaphoric = intentInfo.bareView
    || /\b(gui qua day|gui day|moi do duoc|chua do|tu van tiep|loai do|mau do)\b/.test(normalizeVietnamese(value));

  if (!products.length && fallbackProduct && !addressOnly
    && (anaphoric || intentInfo.intents.some((item) => ["samples", "price", "purchase", "all_products"].includes(item)))) {
    products = [fallbackProduct];
    productSource = "customer_memory";
    productConfidence = 0.72;
  }

  return {
    intents: intentInfo.intents,
    products: unique(products),
    currentProducts,
    contextProducts,
    productSource,
    productConfidence,
    explicitSampleRequest: intentInfo.explicitMedia || (intentInfo.bareView && Boolean(products.length)),
    visitIntent: intentInfo.visit,
    multiIntent: intentInfo.intents.length > 1,
    multiProduct: unique(products).length > 1,
  };
}

function customerEventsForContext(sorted, latestCustomerIndex, options = {}) {
  const latestAt = timeOf(sorted[latestCustomerIndex]);
  const maxMessages = Math.max(2, Math.min(20, Number(options.contextCustomerMessages || 12)));
  const maxAgeMs = Math.max(5, Math.min(180, Number(options.contextMaxMinutes || 45))) * 60 * 1000;
  const referralEvent = [...sorted.slice(0, latestCustomerIndex + 1)].reverse().find((event) => {
    const referral = event?.referral;
    return CUSTOMER_TYPES.has(eventType(event)) && referral && typeof referral === "object"
      && (referral.ad_id || referral.adset_id || referral.campaign_id || referral.source);
  });
  const referralAt = timeOf(referralEvent);
  const cutoff = Math.max(latestAt - maxAgeMs, referralAt > 0 && referralAt <= latestAt ? referralAt : 0);

  return sorted
    .slice(0, latestCustomerIndex + 1)
    .filter((event) => CUSTOMER_TYPES.has(eventType(event)) && timeOf(event) >= cutoff)
    .slice(-maxMessages);
}

function latestReferral(sorted, latestCustomerIndex) {
  return [...sorted.slice(0, latestCustomerIndex + 1)].reverse().find((event) => {
    const referral = event?.referral;
    return referral && typeof referral === "object"
      && (referral.ad_id || referral.adset_id || referral.campaign_id || referral.source);
  })?.referral || null;
}

export function buildConversationTurn(events, options = {}) {
  const maxGapMs = Math.max(15, Number(options.maxGapSeconds || 90)) * 1000;
  const coexistenceMode = String(options.coexistenceMode || "AICAKE_ACTIVE").toUpperCase();
  const supportSlideOnly = options.supportSlideOnly === true;
  const state = options.state || {};
  const customer = options.customer || {};
  const sorted = [...(events || [])].sort((a, b) => timeOf(a) - timeOf(b) || eventId(a).localeCompare(eventId(b)));

  let latestCustomerIndex = -1;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (CUSTOMER_TYPES.has(eventType(sorted[index]))) {
      latestCustomerIndex = index;
      break;
    }
  }
  if (latestCustomerIndex < 0) {
    return { valid: false, action: "no_customer_turn", customerMessages: [], combinedText: "", contextText: "" };
  }

  const activeCustomerEvents = [sorted[latestCustomerIndex]];
  for (let index = latestCustomerIndex - 1; index >= 0; index -= 1) {
    const current = sorted[index];
    const next = activeCustomerEvents[0];
    if (!CUSTOMER_TYPES.has(eventType(current))) break;
    if (timeOf(next) - timeOf(current) > maxGapMs) break;
    activeCustomerEvents.unshift(current);
  }

  const contextCustomerEvents = customerEventsForContext(sorted, latestCustomerIndex, options);
  const combinedText = activeCustomerEvents.map((event) => text(event?.message_text ?? event?.text)).filter(Boolean).join("\n");
  const contextText = contextCustomerEvents.map((event) => text(event?.message_text ?? event?.text)).filter(Boolean).join("\n");
  const contact = detectContact(contextText || combinedText);
  const salesSignals = extractSalesSignals(combinedText, {
    contextText,
    lastProductKey: customer.last_product_key || customer.profile?.last_product_key,
  });

  const latestCustomerAt = timeOf(sorted[latestCustomerIndex]);
  const responses = sorted.filter((event) => RESPONSE_TYPES.has(eventType(event)) && timeOf(event) >= latestCustomerAt);
  const verifiedHuman = responses.find((event) => eventType(event) === "human_message" && event?.actor_evidence?.human_verified === true);
  const automation = responses.find((event) => eventType(event) === "automation_message");
  const bot = responses.find((event) => eventType(event) === "bot_message");
  const ambiguous = responses.find((event) => eventType(event) === "page_message");

  let action = "needs_ai_decision";
  if (contact.contactCaptured) action = "contact_captured";
  else if (verifiedHuman || state.human_takeover === true || state.humanTakeover === true) action = "human_takeover_active";
  else if (bot) action = "aiguka_already_replied";
  else if (!supportSlideOnly && automation && coexistenceMode === "AICAKE_ACTIVE") action = "external_bot_replied";
  else if (!supportSlideOnly && ambiguous) action = "wait_actor_reconciliation";

  const mapEvent = (event) => ({
    sourceEventId: eventId(event),
    occurredAt: event?.occurred_at || event?.occurredAt || null,
    text: event?.message_text ?? event?.text ?? null,
    attachments: Array.isArray(event?.attachments) ? event.attachments : [],
  });

  return {
    valid: true,
    action,
    customerMessages: activeCustomerEvents.map(mapEvent),
    contextCustomerMessages: contextCustomerEvents.map(mapEvent),
    combinedText,
    contextText,
    referral: latestReferral(sorted, latestCustomerIndex),
    hasImage: contextCustomerEvents.some((event) => Array.isArray(event?.attachments)
      && event.attachments.some((attachment) => String(attachment?.type || attachment?.mime_type || "").toLowerCase().includes("image"))),
    contact,
    salesSignals,
    responseEvidence: {
      verifiedHuman: verifiedHuman ? eventId(verifiedHuman) : null,
      automation: automation ? { sourceEventId: eventId(automation), provider: automation?.actor_evidence?.provider || null } : null,
      bot: bot ? eventId(bot) : null,
      ambiguousPage: ambiguous ? eventId(ambiguous) : null,
    },
    shouldRequestContact: !contact.contactCaptured && action === "needs_ai_decision",
    contextPolicy: {
      active_gap_seconds: Math.round(maxGapMs / 1000),
      context_customer_messages: contextCustomerEvents.length,
      product_source: salesSignals.productSource,
    },
  };
}
