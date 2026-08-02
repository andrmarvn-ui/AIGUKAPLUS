import {
  buildConversationTurn as buildBaseConversationTurn,
  normalizeVietnamese,
} from "./conversation-intelligence.js";

const unique = (values) => [...new Set((values || []).filter(Boolean))];

const PRODUCT_LABELS = {
  combo_phong_tam: "thiết bị vệ sinh/phòng tắm",
  phong_bep: "thiết bị phòng bếp",
  bep_tu_hut_mui: "bếp từ/máy hút mùi",
  chau_voi_rua_bat: "chậu vòi rửa bát",
  guong_tu: "tủ lavabo",
  lavabo: "lavabo",
  bon_cau: "bồn cầu",
  sen_tam: "sen tắm",
  gach_da_op_lat: "gạch ốp lát",
  quat_tran: "quạt trần",
  quat_10_canh: "quạt trần 10 cánh",
  quat_10_canh_gold: "quạt 10 cánh vàng gương",
  quat_10_canh_black: "quạt 10 cánh màu đen",
  quat_10_canh_brown: "quạt 10 cánh màu nâu",
  quat_10_canh_wood: "quạt 10 cánh vân gỗ",
  den_trum: "đèn trang trí",
  bon_tam: "bồn tắm",
};

function orderedMatches(normalized, rules) {
  return rules
    .map(([key, pattern, priority = 0]) => {
      const index = normalized.search(pattern);
      return index >= 0 ? { key, index, priority } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index || b.priority - a.priority)
    .map((item) => item.key);
}

function referralText(referral = {}) {
  const data = referral?.ads_context_data || referral?.adsContextData || {};
  return [data.ad_title, data.title, referral.ad_title, referral.title].filter(Boolean).join(" ");
}

function fanColorKey(normalized) {
  if (!/\bquat(?: tran)? 10 canh\b/.test(normalized) && !/\b10 canh\b/.test(normalized)) return null;
  if (/\b(vang guong|ma vang|mau vang|gold)\b/.test(normalized)) return "quat_10_canh_gold";
  if (/\b(van go|mau go|wood)\b/.test(normalized)) return "quat_10_canh_wood";
  if (/\b(mau den|black)\b/.test(normalized)) return "quat_10_canh_black";
  if (/\b(mau nau|brown)\b/.test(normalized)) return "quat_10_canh_brown";
  return "quat_10_canh";
}

export function detectSemanticProductKeys(value, options = {}) {
  const normalized = normalizeVietnamese(value);
  const referralNormalized = normalizeVietnamese(referralText(options.referral));
  if (!normalized) {
    const referralFan = fanColorKey(referralNormalized);
    return referralFan ? [referralFan] : [];
  }

  const explicitAppliance = /\b(bep tu|bep dien|bep [1-9] (tu|vung)|hut mui|may hut mui|may hut khoi|hut khoi)\b/.test(normalized);
  const tileAction = /\b(gach|op lat|lat nen|op tuong|op [0-9]+|[0-9]+ ?m2|[0-9]+ ?m)\b/.test(normalized)
    && /\b(op|lat|gach)\b/.test(normalized);
  const vanity = /\b(tu lavabo|tu chau lavabo|bo tu lavabo|tu rua mat|tu phong tam)\b/.test(normalized);
  const sink = /\b(chau (1|mot) (ho|hoc)|chau inox (1|mot) (ho|hoc)|chau rua bat|chau rua chen|chau rua bep|voi rua bat|voi rua chen|bon rua bat|bon rua bep)\b/.test(normalized);
  const bathroom = /\b(thiet bi ve sinh|thiet bi nha tam|thiet bi phong tam|nha tam|phong tam|nha ve sinh|combo (nha tam|phong tam|ve sinh)|bo (nha tam|phong tam|ve sinh)|wc)\b/.test(normalized)
    || /\b[0-9]+ v s\b/.test(normalized);
  const broadKitchen = /\b(nha bep|phong bep|thiet bi bep|thiet bi nha bep)\b/.test(normalized);

  const rules = [
    ["combo_phong_tam", /\b(thiet bi ve sinh|thiet bi nha tam|thiet bi phong tam|nha tam|phong tam|nha ve sinh|combo (nha tam|phong tam|ve sinh)|bo (nha tam|phong tam|ve sinh)|wc)\b|\b[0-9]+ v s\b/, 20],
    ["guong_tu", /\b(tu lavabo|tu chau lavabo|bo tu lavabo|tu rua mat|tu phong tam|guong tu|tu guong)\b/, 30],
    ["chau_voi_rua_bat", /\b(chau (1|mot) (ho|hoc)|chau inox (1|mot) (ho|hoc)|chau rua bat|chau rua chen|chau rua bep|voi rua bat|voi rua chen|bon rua bat|bon rua bep)\b/, 30],
    ["bep_tu_hut_mui", /\b(bep tu|bep dien|bep [1-9] (tu|vung)|hut mui|may hut mui|may hut khoi|hut khoi)\b/, 30],
    ["phong_bep", /\b(nha bep|phong bep|thiet bi bep|thiet bi nha bep)\b/, 10],
    ["gach_da_op_lat", /\b(gach|op lat|lat nen|op tuong)\b/, 25],
    ["bon_cau", /\b(bon cau|toilet)\b/, 20],
    ["lavabo", /\b(lavabo|chau rua mat)\b/, 10],
    ["sen_tam", /\b(sen tam|sen cay|voi tam)\b/, 20],
    ["quat_tran", /\b(quat tran|quat nay)\b/, 5],
    ["den_trum", /\b(den chum|den trum|den trang tri|den tha)\b/, 20],
    ["bon_tam", /\b(bon tam|jacuzzi)\b/, 20],
  ];

  let products = orderedMatches(normalized, rules);
  const fanKey = fanColorKey(`${normalized} ${referralNormalized}`);
  if (fanKey) products = [fanKey, ...products.filter((key) => key !== "quat_tran")];
  if (vanity) products = products.filter((key) => key !== "lavabo");
  if (sink) products = products.filter((key) => key !== "lavabo");
  if (tileAction && !explicitAppliance) {
    products = products.filter((key) => !["bep_tu_hut_mui", "phong_bep"].includes(key));
    if (!products.includes("gach_da_op_lat")) products.unshift("gach_da_op_lat");
  }
  if (broadKitchen && !tileAction && !explicitAppliance && !products.includes("phong_bep")) products.push("phong_bep");
  if (bathroom && !products.includes("combo_phong_tam")) products.unshift("combo_phong_tam");
  if (!products.length && fanKey) products = [fanKey];
  return unique(products);
}

export function detectSemanticIntents(value) {
  const normalized = normalizeVietnamese(value);
  const intents = [];
  const push = (item) => { if (item && !intents.includes(item)) intents.push(item); };
  if (/\b(gia|bao nhieu|bao gia|chi phi|bn)\b/.test(normalized)) push("price");
  if (/\b(dia chi|o dau|vi tri|showroom|duong di|co so|cua hang|kho)\b/.test(normalized)) push("address");
  if (/\b(den|qua|len|ghe|toi) (xem|cua hang|showroom)\b|\bxem truc tiep\b/.test(normalized)) push("visit");
  if (/\b(gui|cho|xem) (mau|hinh|anh|catalog|slide)\b|\b(mau|hinh|anh|catalog|slide) (nao|dau|them)\b/.test(normalized)
    || /^(cho )?xem( voi| nhe| a| di)?$/.test(normalized)) push("samples");
  if (/\b(sai canh|soai canh|cong suat|kich thuoc|thong so|bao nhieu canh|[0-9]+x[0-9]+)\b/.test(normalized)) push("specs");
  if (/\b(vua quat|hang gi|thuong hieu|chinh hang)\b/.test(normalized)) push("brand_verification");
  if (/\b(giam|bot|uu dai|gia tot|khuyen mai)\b/.test(normalized)) push("discount");
  if (/\b(xem het|tat ca|day du|noi that nha moi|hoan thien nha)\b/.test(normalized)) push("all_products");
  if (/\b(mua|chot|dat hang|dat coc|lay bo|lay combo)\b/.test(normalized)) push("purchase");
  if (/\b(ship|giao hang|van chuyen)\b/.test(normalized)) push("delivery");
  const contactRefused = /\b(zalo lam gi|khong zalo|khong can zalo|khong can sdt|khong can so|noi luon|bao luon|tra loi o day|gui o day|nhan o day)\b/.test(normalized);
  if (contactRefused) push("messenger_preference");
  return { intents, contactRefused };
}

function segmentFromMessage(message, referral) {
  const value = message?.text ?? message?.message_text ?? "";
  const semantic = detectSemanticIntents(value);
  return {
    sourceEventId: message?.sourceEventId || message?.source_event_id || null,
    occurredAt: message?.occurredAt || message?.occurred_at || null,
    text: value,
    products: detectSemanticProductKeys(value, { referral }),
    intents: semantic.intents,
    contactRefused: semantic.contactRefused,
  };
}

const orderedRequestedProducts = (segments) => unique((segments || []).flatMap((segment) => segment.products || []));

export function buildConversationTurn(events, options = {}) {
  const turn = buildBaseConversationTurn(events, options);
  if (!turn?.valid) return turn;
  const currentMessages = Array.isArray(turn.customerMessages) ? turn.customerMessages : [];
  const contextMessages = Array.isArray(turn.contextCustomerMessages) ? turn.contextCustomerMessages : currentMessages;
  const requestSegments = contextMessages.map((message) => segmentFromMessage(message, turn.referral));
  const currentSegments = currentMessages.map((message) => segmentFromMessage(message, turn.referral));
  const currentProducts = orderedRequestedProducts(currentSegments);
  const contextProducts = orderedRequestedProducts(requestSegments);
  const referralProducts = detectSemanticProductKeys("", { referral: turn.referral });
  let allowedProducts = currentProducts.length ? currentProducts : contextProducts.length ? [contextProducts[contextProducts.length - 1]] : referralProducts;
  if (currentProducts.includes("combo_phong_tam") && currentProducts.includes("phong_bep")) allowedProducts = ["combo_phong_tam"];
  const primaryProduct = allowedProducts[0] || null;
  const requestedProducts = unique([...contextProducts, ...currentProducts, ...referralProducts]);
  const pendingProducts = requestedProducts.filter((key) => !allowedProducts.includes(key));
  const currentIntentInfo = detectSemanticIntents(turn.combinedText);
  const contextIntentInfo = detectSemanticIntents(turn.contextText);
  const intents = unique([...currentIntentInfo.intents, ...(turn.salesSignals?.intents || []).filter((item) => item !== "samples")]);
  const contactRefused = currentIntentInfo.contactRefused || contextIntentInfo.contactRefused;
  const productConfidence = currentProducts.length ? 1 : contextProducts.length ? 0.9 : referralProducts.length ? 0.84 : 0;
  turn.salesSignals = {
    ...(turn.salesSignals || {}), intents, products: allowedProducts, currentProducts, contextProducts,
    referralProducts, requestedProducts, pendingProducts, primaryProduct, allowedProducts,
    productSource: currentProducts.length ? "current_turn_semantic" : contextProducts.length ? "recent_customer_semantic" : referralProducts.length ? "referral_semantic" : turn.salesSignals?.productSource || null,
    productConfidence, productLock: allowedProducts.length ? "hard" : "none", requestSegments,
    contactRefused, preferredChannel: contactRefused ? "messenger" : null,
    explicitSampleRequest: intents.includes("samples"), multiProduct: requestedProducts.length > 1, multiIntent: intents.length > 1,
  };
  turn.shouldRequestContact = Boolean(turn.shouldRequestContact && !contactRefused);
  turn.contextPolicy = {
    ...(turn.contextPolicy || {}), semantic_product_lock: turn.salesSignals.productLock,
    semantic_primary_product: primaryProduct, semantic_pending_products: pendingProducts, contact_refused: contactRefused,
  };
  return turn;
}

export { PRODUCT_LABELS, normalizeVietnamese };
