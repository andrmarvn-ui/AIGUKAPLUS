const unique = (values) => [...new Set((values || []).filter(Boolean))];

const PRODUCT_RULES = [
  { key: "combo_phong_tam", label: "thiết bị/combo phòng tắm", aliases: ["thiet bi ve sinh", "thiet bi nha tam", "thiet bi phong tam", "combo nha tam", "combo phong tam", "tron bo nha tam", "phong ve sinh", "nha tam"] },
  { key: "phong_bep", label: "thiết bị phòng bếp", aliases: ["thiet bi nha bep", "thiet bi phong bep", "combo nha bep", "combo phong bep", "tron bo nha bep", "phong bep", "nha bep"] },
  { key: "chau_voi_rua_bat", label: "chậu/vòi rửa bát", aliases: ["chau rua bat", "chau 1 ho", "chau mot ho", "chau 2 ho", "chau hai ho", "bon rua bep", "voi rua bat", "chau bep"] },
  { key: "sen_tam", label: "sen tắm/sen cây", aliases: ["sen tam", "sen cay", "sen tam cay", "sen voi", "voi sen"] },
  { key: "bon_cau", label: "bồn cầu", aliases: ["bon cau", "bet ve sinh", "bet viglacera", "bet vilacera", "bet vilacela", "bet"] },
  { key: "lavabo", label: "lavabo/chậu rửa mặt", aliases: ["lavabo", "chau rua mat", "chau mat"] },
  { key: "tu_lavabo", label: "tủ lavabo", aliases: ["tu lavabo", "bo tu lavabo", "tu chau lavabo", "tu chau guong"] },
  { key: "guong_tu", label: "gương/tủ gương", aliases: ["guong tu", "tu guong", "guong nha tam"] },
  { key: "bon_tam", label: "bồn tắm", aliases: ["bon tam", "bon ngam"] },
  { key: "bep_tu_hut_mui", label: "bếp từ/máy hút mùi", aliases: ["bep tu", "bep dien", "bep 2 tu", "bep 3 tu", "may hut mui", "hut mui"] },
  { key: "gach_da_op_lat", label: "gạch/đá ốp lát", aliases: ["gach op lat", "gach lat", "gach op", "lat nen", "op tuong", "gach", "da op lat", "suong da"] },
  { key: "quat_10_canh", label: "quạt trần 10 cánh", aliases: ["quat 10 canh", "quat muoi canh", "10 canh", "vang guong", "ma vang"] },
  { key: "quat_tran", label: "quạt trần", aliases: ["quat tran", "quat canh", "quat"] },
  { key: "den_trum", label: "đèn chùm/đèn trang trí", aliases: ["den trum", "den chum", "den trang tri", "den tha"] },
];

const INTENT_RULES = [
  { key: "opt_out", aliases: ["unsubscribe", "huy dang ky", "dung nhan tin", "khong nhan tin", "stop"] },
  { key: "address", aliases: ["dia chi", "o dau", "kho o dau", "showroom", "cua hang o dau", "den xem"] },
  { key: "visit", aliases: ["toi xem", "den xem", "qua xem", "hom nao toi", "hom nao anh toi", "xem tan mat"] },
  { key: "price", aliases: ["gia bao nhieu", "bao gia", "xin gia", "gia si", "gia"] },
  { key: "samples", aliases: ["gui mau", "xem mau", "gui anh", "gui hinh", "cho xem", "xem cung duoc", "mau tham khao"] },
  { key: "specs", aliases: ["kich thuoc", "cong suat", "thong so", "sai canh", "rong bao nhieu", "cao bao nhieu"] },
  { key: "delivery", aliases: ["ship", "van chuyen", "giao hang", "giao tan noi", "giao cong trinh"] },
  { key: "purchase", aliases: ["muon mua", "can mua", "mua", "dat hang", "lay hang"] },
  { key: "brand", aliases: ["thuong hieu", "hang nao", "hang gi", "san xuat", "xuat xu"] },
  { key: "wholesale", aliases: ["gia si", "dai ly", "mua ve ban", "ban lai"] },
  { key: "contact_refusal", aliases: ["khong zalo", "noi o day", "nhan o day", "messenger", "zalo lam gi", "khong can so"] },
];

export function normalizeVietnamese(value) {
  return String(value || "")
    .replace(/[₫đĐ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAlias(normalized, alias) {
  const candidate = normalizeVietnamese(alias);
  if (!candidate) return false;
  return normalized.includes(candidate);
}

function isTileConstructionSentence(normalized) {
  const hasTileAction = /\b(op|lat|op lat|lat nen|op tuong)\b/.test(normalized);
  const hasQuantity = /\b\d+\s*(m2|m|wc|vs|v s)|\bkhoang\s*\d+/.test(normalized);
  return hasTileAction && hasQuantity;
}

function referralText(referral = {}) {
  const values = [
    referral.ad_title,
    referral.headline,
    referral.body,
    referral.source_url,
    referral.ads_context_data?.ad_title,
    referral.ads_context_data?.headline,
  ];
  return values.filter(Boolean).join(" ");
}

function addCandidate(map, candidate) {
  const key = `${candidate.type}:${candidate.key}`;
  const current = map.get(key) || {
    type: candidate.type,
    key: candidate.key,
    label: candidate.label || candidate.key,
    confidence: 0,
    sources: [],
    evidence: [],
  };
  current.confidence = Math.max(current.confidence, Number(candidate.confidence || 0));
  if (candidate.source && !current.sources.includes(candidate.source)) current.sources.push(candidate.source);
  if (candidate.evidence) {
    const signature = `${candidate.evidence.message_id || ""}:${candidate.evidence.text || ""}`;
    if (!current.evidence.some((item) => `${item.message_id || ""}:${item.text || ""}` === signature)) {
      current.evidence.push(candidate.evidence);
    }
  }
  map.set(key, current);
}

export function detectProductCandidates(text, options = {}) {
  const normalized = normalizeVietnamese(text);
  const candidates = [];
  if (!normalized) return candidates;

  const tileConstruction = isTileConstructionSentence(normalized);
  for (const rule of PRODUCT_RULES) {
    const hit = rule.aliases.find((alias) => containsAlias(normalized, alias));
    if (!hit) continue;

    if (tileConstruction && ["combo_phong_tam", "phong_bep"].includes(rule.key)) {
      candidates.push({
        type: "location_reference",
        key: rule.key,
        label: rule.label,
        confidence: 0.35,
        source: "message_location_context",
        matched_alias: hit,
      });
      continue;
    }

    let confidence = 0.92;
    if (["quat_tran", "combo_phong_tam", "phong_bep"].includes(rule.key)) confidence = 0.78;
    if (rule.key === "gach_da_op_lat" && tileConstruction) confidence = 0.99;
    candidates.push({
      type: "product",
      key: rule.key,
      label: rule.label,
      confidence,
      source: options.source || "message",
      matched_alias: hit,
    });
  }

  if (tileConstruction && !candidates.some((item) => item.type === "product" && item.key === "gach_da_op_lat")) {
    candidates.push({ type: "product", key: "gach_da_op_lat", label: "gạch/đá ốp lát", confidence: 0.98, source: "construction_context" });
  }
  if (tileConstruction && /\b(wc|vs|v s|phong ve sinh)\b/.test(normalized)
    && !candidates.some((item) => item.type === "location_reference" && item.key === "combo_phong_tam")) {
    candidates.push({ type: "location_reference", key: "combo_phong_tam", label: "khu vực phòng vệ sinh", confidence: 0.45, source: "construction_location" });
  }
  if (tileConstruction && /\b(phong bep|nha bep|bep)\b/.test(normalized)
    && !candidates.some((item) => item.type === "location_reference" && item.key === "phong_bep")) {
    candidates.push({ type: "location_reference", key: "phong_bep", label: "khu vực phòng bếp", confidence: 0.45, source: "construction_location" });
  }
  if (!tileConstruction && /\b\d+\s*bep\b/.test(normalized)
    && !candidates.some((item) => item.type === "product" && item.key === "phong_bep")) {
    candidates.push({ type: "product", key: "phong_bep", label: "thiết bị phòng bếp", confidence: 0.82, source: options.source || "message" });
  }
  return candidates;
}

export function detectIntentCandidates(text, options = {}) {
  const normalized = normalizeVietnamese(text);
  const candidates = [];
  if (!normalized) return candidates;
  for (const rule of INTENT_RULES) {
    const hit = rule.aliases.find((alias) => containsAlias(normalized, alias));
    if (!hit) continue;
    candidates.push({
      type: "intent",
      key: rule.key,
      label: rule.key,
      confidence: rule.key === "opt_out" ? 1 : 0.9,
      source: options.source || "message",
      matched_alias: hit,
    });
  }
  return candidates;
}

function customerMessages(messages = []) {
  return messages.filter((message) => message.role === "customer");
}

function buildRequestThreads(productCandidates = [], messages = []) {
  const byProduct = new Map();
  for (const candidate of productCandidates.filter((item) => item.type === "product")) {
    const thread = byProduct.get(candidate.key) || {
      product_key: candidate.key,
      label: candidate.label,
      confidence: 0,
      first_seen_at: null,
      last_seen_at: null,
      mentions: [],
      related_intents: [],
    };
    thread.confidence = Math.max(thread.confidence, candidate.confidence);
    for (const evidence of candidate.evidence || []) {
      if (!thread.first_seen_at || String(evidence.occurred_at || "") < thread.first_seen_at) thread.first_seen_at = evidence.occurred_at || null;
      if (!thread.last_seen_at || String(evidence.occurred_at || "") > thread.last_seen_at) thread.last_seen_at = evidence.occurred_at || null;
      if (!thread.mentions.some((item) => item.message_id === evidence.message_id)) thread.mentions.push(evidence);
    }
    byProduct.set(candidate.key, thread);
  }

  for (const message of customerMessages(messages)) {
    const intents = detectIntentCandidates(message.text).map((item) => item.key);
    const products = detectProductCandidates(message.text).filter((item) => item.type === "product").map((item) => item.key);
    for (const product of products) {
      const thread = byProduct.get(product);
      if (thread) thread.related_intents = unique([...thread.related_intents, ...intents]);
    }
  }
  return [...byProduct.values()].sort((a, b) => String(a.first_seen_at || "").localeCompare(String(b.first_seen_at || "")));
}

export function buildAdvisoryBundle({ messages = [], referral = null, customer = {}, state = {}, mappingCandidates = [], catalog = [] } = {}) {
  const map = new Map();
  for (const message of customerMessages(messages)) {
    const evidence = {
      message_id: message.id || null,
      occurred_at: message.occurred_at || null,
      text: message.text || "",
    };
    for (const candidate of detectProductCandidates(message.text, { source: "customer_message" })) {
      addCandidate(map, { ...candidate, evidence });
    }
    for (const candidate of detectIntentCandidates(message.text, { source: "customer_message" })) {
      addCandidate(map, { ...candidate, evidence });
    }
  }

  const referralValue = referralText(referral || {});
  if (referralValue) {
    for (const candidate of detectProductCandidates(referralValue, { source: "ad_referral" })) {
      addCandidate(map, { ...candidate, confidence: Math.min(candidate.confidence, 0.55), evidence: { message_id: null, occurred_at: null, text: referralValue } });
    }
  }

  for (const mapping of mappingCandidates || []) {
    const keys = Array.isArray(mapping.catalog_keys) ? mapping.catalog_keys : [];
    for (const key of keys) {
      addCandidate(map, {
        type: "catalog_candidate",
        key: String(key),
        label: String(key),
        confidence: Number(mapping.confidence || 0.45),
        source: "mapping",
        evidence: { message_id: null, occurred_at: null, text: `mapping:${mapping.ad_id || mapping.campaign_id || "unknown"}` },
      });
    }
  }

  const allCandidates = [...map.values()];
  const productCandidates = allCandidates.filter((item) => item.type === "product");
  const intentCandidates = allCandidates.filter((item) => item.type === "intent");
  const latestCustomer = customerMessages(messages).at(-1) || null;
  const latestIntents = detectIntentCandidates(latestCustomer?.text || "").map((item) => item.key);

  const catalogAvailability = (catalog || []).map((node) => ({
    catalog_key: node.catalog_key,
    display_name: node.display_name,
    aliases: Array.isArray(node.aliases) ? node.aliases.slice(0, 12) : [],
    asset_count: Array.isArray(node.assets) ? node.assets.filter((asset) => asset?.source_url).length : 0,
  }));

  return {
    advisory_only: true,
    policy: "Product and intent candidates are non-binding evidence. Mandatory commerce-integrity rules validate the AI proposal.",
    product_candidates: productCandidates,
    intent_candidates: intentCandidates,
    location_references: allCandidates.filter((item) => item.type === "location_reference"),
    mapping_candidates: allCandidates.filter((item) => item.type === "catalog_candidate"),
    request_threads: buildRequestThreads(productCandidates, messages),
    latest_message_advice: {
      message_id: latestCustomer?.id || null,
      text: latestCustomer?.text || "",
      intents: latestIntents,
      note: "Latest message is context, not an override of earlier unresolved needs.",
    },
    contact_advice: {
      known_phone: customer.phone || state.phone || null,
      known_zalo: customer.zalo || state.zalo || null,
      contact_status: state.contact_status || "missing",
      do_not_ask_again: Boolean(customer.phone || customer.zalo || state.phone || state.zalo),
    },
    channel_advice: {
      prefers_messenger: intentCandidates.some((item) => item.key === "contact_refusal"),
    },
    catalog_availability: catalogAvailability,
  };
}

export function hasOptOutIntent(messages = []) {
  const latest = customerMessages(messages).at(-1);
  return detectIntentCandidates(latest?.text || "").some((item) => item.key === "opt_out");
}

export const PRODUCT_LABELS = Object.fromEntries(PRODUCT_RULES.map((item) => [item.key, item.label]));
