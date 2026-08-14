import { detectIntentCandidates, detectProductCandidates, normalizeVietnamese } from "./advisory-engine.js";
import { commentPrivateReplyContextFromMessages } from "../../v9/core/comment-private-reply.js";

const PRODUCT_GROUPS = Object.freeze({
  combo_phong_tam: { label: "thiết bị/combo phòng tắm", aliases: ["combo phong tam", "combo nha tam", "thiet bi ve sinh", "thiet bi phong tam", "thiet bi nha tam", "nha tam"] },
  phong_bep: { label: "thiết bị phòng bếp", aliases: ["phong bep", "nha bep", "combo phong bep", "combo nha bep", "thiet bi phong bep", "thiet bi nha bep"] },
  chau_voi_rua_bat: { label: "chậu/vòi rửa bát", aliases: ["chau rua bat", "chau rua chen", "chau bep", "bon rua bep", "voi rua bat", "chau 1 ho", "chau 2 ho", "chau 3 ho"] },
  bep_tu_hut_mui: { label: "bếp từ/máy hút mùi", aliases: ["bep tu", "bep dien", "may hut mui", "hut mui"] },
  bon_cau: { label: "bồn cầu/bệt", aliases: ["bon cau", "bet ve sinh", "bet lien khoi", "bet thong minh", "toilet", "bet"] },
  sen_tam: { label: "sen tắm/sen cây", aliases: ["sen tam", "sen cay", "voi sen"] },
  lavabo: { label: "lavabo/chậu rửa mặt", aliases: ["lavabo", "chau rua mat", "chau mat"] },
  tu_lavabo: { label: "tủ lavabo", aliases: ["tu lavabo", "tu chau lavabo", "tu chau guong"] },
  guong_tu: { label: "gương/tủ gương", aliases: ["guong tu", "tu guong", "guong nha tam", "guong dien"] },
  bon_tam: { label: "bồn tắm", aliases: ["bon tam", "bon ngam"] },
  quat_5_6_canh: { label: "quạt trần 5/6 cánh", aliases: ["quat 5/6 canh", "quat 5 canh", "quat 6 canh", "quat nam canh", "quat sau canh"] },
  quat_8_canh: { label: "quạt trần 8 cánh", aliases: ["quat 8 canh", "quat tam canh"] },
  quat_10_canh: { label: "quạt trần 10 cánh", aliases: ["quat 10 canh", "quat muoi canh"] },
  quat_tran: { label: "quạt trần", aliases: ["quat tran"] },
  den_trum: { label: "đèn chùm/đèn trang trí", aliases: ["den trum", "den chum", "den trang tri", "den tha"] },
  gach_da_op_lat: { label: "gạch/đá ốp lát", aliases: ["gach op lat", "gach lat", "gach op", "lat nen", "op tuong", "da op lat", "gach"] },
});

const BATHROOM_CHILDREN = new Set(["bon_cau", "sen_tam", "lavabo", "tu_lavabo", "guong_tu", "bon_tam"]);
const KITCHEN_CHILDREN = new Set(["chau_voi_rua_bat", "bep_tu_hut_mui"]);
const FAN_CHILDREN = new Set(["quat_5_6_canh", "quat_8_canh", "quat_10_canh"]);
const SPECIFIC_REFERENCE = /\b(mau nay|loai nay|cai nay|bo nay|hai mau|2 mau|ba mau|3 mau|mau tren|mau duoi|trong anh|anh nay|hinh nay|san pham nay)\b|\b(?:mau|loai|san pham|bon cau|bet|chau|quat|bep|sen|lavabo)(?: [a-z0-9./-]+){0,4} nay\b/;
const SPECIFIC_ATTRIBUTE = /\b(kich thuoc|thong so|cong suat|dong co|chat lieu|xuat xu|thuong hieu|bao hanh|lap dat|phien ban|model|ma san pham|mau sac|sai canh|dien ap|rong bao nhieu|cao bao nhieu|dai bao nhieu|[123]\s*ho|mot ho|hai ho|ba ho|2 ngan|3 ngan)\b/;
const PRICE_RANGE = /(?:từ\s*)?\d+(?:[.,]\d+)?\s*(?:-|–|—|đến|tới)\s*\d+(?:[.,]\d+)?\s*(?:triệu|trieu|nghìn|nghin|k|đ|₫|vnd|đồng|dong)(?:\s*\/\s*m2)?/iu;
const NUMERIC_FACT = /\b\d+(?:[.,]\d+)?\s*(?:%|triệu|trieu|nghìn|nghin|k|đ|₫|vnd|đồng|dong|mm|cm|km|m2|m²|m|w|kw|kg|l|tháng|thang|năm|nam)\b/giu;

function customerMessages(modelInput = {}) {
  const messages = Array.isArray(modelInput?.conversation?.messages) ? modelInput.conversation.messages : [];
  return messages.filter((message) => message?.role === "customer");
}

function currentCustomerCluster(modelInput = {}) {
  const messages = Array.isArray(modelInput?.conversation?.messages) ? modelInput.conversation.messages : [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "customer") {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1).filter((message) => message?.role === "customer");
}

function groupForCandidateKey(value) {
  const key = String(value || "").trim();
  if (!key) return null;
  if (/^quat_(?:5_6|5|6)_canh(?:_|$)/.test(key)) return "quat_5_6_canh";
  if (/^quat_8_canh(?:_|$)/.test(key)) return "quat_8_canh";
  if (/^quat_10_canh(?:_|$)/.test(key)) return "quat_10_canh";
  if (key === "quat_tran" || key.startsWith("quat_tran_")) return "quat_tran";
  if (key === "gach_op_lat" || key.startsWith("gach_") || key.startsWith("da_op")) return "gach_da_op_lat";
  if (key === "bon_cau" || key.startsWith("bon_cau") || key.startsWith("bet_")) return "bon_cau";
  if (key === "bep_tu_hut_mui" || key.startsWith("bep_tu") || key.startsWith("may_hut_mui")) return "bep_tu_hut_mui";
  if (key === "chau_voi_rua_bat" || key.startsWith("chau_") || key.startsWith("voi_rua")) return "chau_voi_rua_bat";
  if (key === "combo_phong_tam" || key.startsWith("combo_phong_tam")) return "combo_phong_tam";
  if (key === "phong_bep" || key.startsWith("combo_phong_bep")) return "phong_bep";
  for (const group of Object.keys(PRODUCT_GROUPS)) {
    if (key === group || key.startsWith(`${group}_`)) return group;
  }
  return null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function mostSpecificGroups(values = []) {
  const groups = unique(values);
  return groups.filter((group) => {
    if (group === "combo_phong_tam" && groups.some((candidate) => BATHROOM_CHILDREN.has(candidate))) return false;
    if (group === "phong_bep" && groups.some((candidate) => KITCHEN_CHILDREN.has(candidate))) return false;
    if (group === "quat_tran" && groups.some((candidate) => FAN_CHILDREN.has(candidate))) return false;
    return true;
  });
}

function explicitFanGroups(value = "") {
  const normalized = normalizeVietnamese(value);
  const groups = [];
  if (/\bquat\s*(?:5\s*\/\s*6|5|6|nam|sau)\s*canh\b/.test(normalized)) groups.push("quat_5_6_canh");
  if (/\bquat\s*(?:8|tam)\s*canh\b/.test(normalized)) groups.push("quat_8_canh");
  if (/\bquat\s*(?:10|muoi)\s*canh\b/.test(normalized)) groups.push("quat_10_canh");
  return groups;
}

function directProductGroups(messages = []) {
  return mostSpecificGroups(messages.flatMap((message) => [
    ...explicitFanGroups(message?.text || ""),
    ...detectProductCandidates(message?.text || "")
      .filter((candidate) => candidate.type === "product")
      .map((candidate) => groupForCandidateKey(candidate.key)),
  ]));
}

function advisorCustomerGroups(modelInput, currentIds) {
  const candidates = Array.isArray(modelInput?.knowledge_advisors?.product_candidates)
    ? modelInput.knowledge_advisors.product_candidates
    : [];
  return mostSpecificGroups(candidates.flatMap((candidate) => {
    const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : [];
    const sources = Array.isArray(candidate?.sources) ? candidate.sources : [];
    const currentEvidence = evidence.some((item) => currentIds.has(String(item?.message_id || "")));
    if (!currentEvidence && !sources.includes("customer_message")) return [];
    return [groupForCandidateKey(candidate?.key)];
  }));
}

function visionGroups(modelInput = {}) {
  const values = [
    ...(Array.isArray(modelInput?.vision_results) ? modelInput.vision_results : []),
    ...(Array.isArray(modelInput?.conversation?.vision_results) ? modelInput.conversation.vision_results : []),
  ];
  return mostSpecificGroups(values
    .filter((item) => Number(item?.confidence || 0) >= 0.7)
    .map((item) => groupForCandidateKey(item?.product_group || item?.product_key || item?.catalog_key)));
}

function mappingGroups(modelInput = {}) {
  const mappings = Array.isArray(modelInput?.knowledge_advisors?.ad_mappings)
    ? modelInput.knowledge_advisors.ad_mappings
    : [];
  return mostSpecificGroups(mappings.flatMap((mapping) => [
    ...(Array.isArray(mapping?.fallback_catalog_keys) ? mapping.fallback_catalog_keys : []),
    ...(Array.isArray(mapping?.catalog_keys) ? mapping.catalog_keys : []),
  ].map(groupForCandidateKey)));
}

function customerHasAttachments(messages = []) {
  return messages.some((message) => Array.isArray(message?.attachments) && message.attachments.length > 0);
}

function requestText(messages = []) {
  return messages.map((message) => String(message?.text || "")).join(" ").replace(/\s+/g, " ").trim();
}

function requestIntentKeys(text) {
  return detectIntentCandidates(text).map((item) => item.key);
}

function containsModelCode(raw) {
  return /\b[A-Za-z]{1,10}[-_.\/]?\d{2,8}[A-Za-z0-9._\/-]*\b/.test(String(raw || ""));
}

function contactKnown(modelInput = {}) {
  const state = modelInput.state || {};
  const customer = modelInput.customer || {};
  return Boolean(state.phone || state.zalo || customer.phone || customer.zalo || ["captured", "verified", "known"].includes(String(state.contact_status || "").toLowerCase()));
}

function contactRefused(modelInput = {}) {
  const text = normalizeVietnamese(requestText(currentCustomerCluster(modelInput)));
  return /\b(khong cho so|khong can goi|khong lien he|khong sdt|khong so dien thoai|khong zalo|noi o day|nhan o day|messenger thoi)\b/.test(text);
}

function contactRequestDetected(value) {
  const text = normalizeVietnamese(value);
  return /\b(xin|cho|gui|de lai|nhan|qua).{0,40}\b(sdt|so dien thoai|zalo|so lien he)\b|\b(sdt|so dien thoai|zalo|so lien he).{0,30}\b(nhe|a|de|qua|cho em|gui em)\b/.test(text);
}

function contactCooldown(modelInput = {}) {
  const messages = Array.isArray(modelInput?.conversation?.messages)
    ? [...modelInput.conversation.messages]
    : [];
  messages.sort((left, right) => Date.parse(left?.occurred_at || "") - Date.parse(right?.occurred_at || ""));
  let lastRequestIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "customer" && contactRequestDetected(messages[index]?.text || "")) lastRequestIndex = index;
  }
  if (lastRequestIndex < 0) return { active: false, customerMessagesSince: 999 };
  const customerMessagesSince = messages.slice(lastRequestIndex + 1).filter((message) => message?.role === "customer").length;
  return { active: customerMessagesSince < 2, customerMessagesSince };
}

function phoneInCurrentCluster(modelInput = {}) {
  const raw = requestText(currentCustomerCluster(modelInput));
  const digits = raw.replace(/\D/g, "");
  const normalized = digits.startsWith("84") ? `0${digits.slice(2)}` : digits;
  return /^0\d{9}$/.test(normalized);
}

function contactDisposition(modelInput = {}) {
  const known = contactKnown(modelInput) || phoneInCurrentCluster(modelInput);
  const refused = !known && contactRefused(modelInput);
  const cooldown = !known && !refused ? contactCooldown(modelInput) : { active: false, customerMessagesSince: 999 };
  return {
    known,
    refused,
    cooldown,
    shouldRequest: !known && !refused && !cooldown.active,
    state: known ? "known" : (refused ? "refused_messenger_only" : (cooldown.active ? "missing_recently_requested" : "missing")),
  };
}

function salutation(modelInput = {}) {
  const raw = requestText(customerMessages(modelInput).slice(-12));
  const text = normalizeVietnamese(raw);
  const preferred = normalizeVietnamese(modelInput?.customer?.preferred_salutation || "");
  const self = (term) => new RegExp(`(?:^|[.!?\\n]\\s*)${term}\\s+(?:dang|muon|can|hoi|xem|mua|lay|dat|o|ranh|co nhu cau|quan tam|xin|nhan)\\b`, "i").test(text);
  if (self("co") || preferred === "co") return { customer: "cô", seller: "cháu" };
  if (self("chu") || preferred === "chu") return { customer: "chú", seller: "cháu" };
  if (self("bac") || preferred === "bac") return { customer: "bác", seller: "cháu" };
  if (self("chi") || preferred === "chi") return { customer: "chị", seller: "em" };
  if (self("anh") || preferred === "anh") return { customer: "anh", seller: "em" };
  return { customer: "anh/chị", seller: "em" };
}

function groupLabel(groups = []) {
  if (groups.length !== 1) return "mẫu mình đang hỏi";
  return PRODUCT_GROUPS[groups[0]]?.label || "mẫu mình đang hỏi";
}

function contactSentence(modelInput = {}) {
  const style = salutation(modelInput);
  const contact = contactDisposition(modelInput);
  if (contact.known) {
    return `${style.seller[0].toLocaleUpperCase("vi-VN") + style.seller.slice(1)} chuyển chuyên viên kiểm tra đúng mẫu và gửi thông tin theo liên hệ mình đã để lại ạ.`;
  }
  if (contact.refused) {
    return `${style.customer[0].toLocaleUpperCase("vi-VN") + style.customer.slice(1)} gửi thêm ảnh hoặc mã đầy đủ, ${style.seller} hỗ trợ tiếp ngay tại Messenger ạ.`;
  }
  if (contact.cooldown.active) {
    return `${style.seller[0].toLocaleUpperCase("vi-VN") + style.seller.slice(1)} đã ghi nhận yêu cầu này và chờ thông tin liên hệ để chuyên viên kiểm tra đúng mẫu, gửi hình và báo giá cho tiện ạ.`;
  }
  return `${style.customer[0].toLocaleUpperCase("vi-VN") + style.customer.slice(1)} cho ${style.seller} xin SĐT hoặc Zalo để chuyên viên lọc đúng mẫu, gửi hình, tư vấn và báo giá cho tiện nhé.`;
}

function documentLines(modelInput = {}) {
  const documents = Array.isArray(modelInput?.knowledge_advisors?.documents)
    ? modelInput.knowledge_advisors.documents
    : [];
  return documents.flatMap((document) => String(document?.content || "")
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/u))
    .map((line) => line.trim())
    .filter(Boolean));
}

function verifiedAddressReply(modelInput = {}) {
  const knowledge = normalizeVietnamese(documentLines(modelInput).join(" "));
  const current = normalizeVietnamese(requestText(currentCustomerCluster(modelInput)));
  const addresses = [];
  if (knowledge.includes("254 pho keo kim son gia lam ha noi")) addresses.push("254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội");
  else if (knowledge.includes("254 pho keo gia lam ha noi")) addresses.push("254 Phố Keo, Gia Lâm, Hà Nội");
  if (knowledge.includes("pho dan tri qua thuan thanh bac ninh")) addresses.push("Phố Dàn, Trí Quả, Thuận Thành, Bắc Ninh");
  if (knowledge.includes("khu do thi dinh to luxury homes thuan thanh bac ninh")) addresses.push("Khu đô thị Đình Tổ Luxury Homes, Thuận Thành, Bắc Ninh");
  if (knowledge.includes("khu do thi khai son long bien ha noi")) addresses.push("Khu đô thị Khai Sơn, Long Biên, Hà Nội");
  if (!addresses.length) return null;

  let selected = addresses;
  if (/\b(bac ninh|thuan thanh|tri qua|pho dan|dinh to)\b/.test(current)) {
    selected = addresses.filter((address) => /Bắc Ninh|Thuận Thành/iu.test(address));
  } else if (/\b(long bien|khai son)\b/.test(current)) {
    selected = addresses.filter((address) => /Long Biên|Khai Sơn/iu.test(address));
  } else if (/\b(gia lam|kim son|pho keo|hung yen|thuong tin|ha noi)\b/.test(current)) {
    selected = addresses.filter((address) => /Gia Lâm|Long Biên/iu.test(address));
  }
  if (!selected.length) selected = addresses;
  return `Showroom ÁNH DƯƠNG có ${selected.map((address) => `cơ sở tại ${address}`).join("; ")}.`;
}

function lineMentionsGroup(line, group) {
  const normalized = normalizeVietnamese(line);
  const metadata = PRODUCT_GROUPS[group];
  if (!metadata) return false;
  return metadata.aliases.some((alias) => normalized.includes(normalizeVietnamese(alias)));
}

function scopedKnowledgeLines(modelInput, groups) {
  const lines = documentLines(modelInput);
  if (!groups.length) return [];
  return lines.filter((line) => groups.some((group) => lineMentionsGroup(line, group)));
}

function priceRangeForGroup(modelInput, group) {
  for (const line of scopedKnowledgeLines(modelInput, [group])) {
    const match = line.match(PRICE_RANGE);
    if (!match) continue;
    let value = String(match[0]).replace(/\s+/g, " ").trim();
    if (!/^từ\b/iu.test(value)) value = `từ ${value}`;
    value = value
      .replace(/(\d)\.(\d)(?=\s*(?:-|–|—|đến|tới|triệu|trieu))/giu, "$1,$2")
      .replace(/\s*(?:-|—)\s*/g, "–")
      .replace(/\s+đến\s+/giu, "–")
      .replace(/\s+tới\s+/giu, "–");
    return { value, line };
  }
  return null;
}

function numericFacts(value) {
  return String(value || "").match(NUMERIC_FACT) || [];
}

function normalizedFact(value) {
  return normalizeVietnamese(value).replace(/[\s.,]/g, "");
}

function policyClaimWithoutEvidence(reply, modelInput, groups = []) {
  const raw = String(reply || "");
  const normalized = normalizeVietnamese(reply);
  const lines = scopedKnowledgeLines(modelInput, groups).map(normalizeVietnamese);
  const claims = [
    { pattern: /\bmien phi van chuyen\b/, evidence: "mien phi van chuyen" },
    { pattern: /\b(?:tru|giam them|chiet khau them).{0,20}\d+(?:[.,]\d+)?\b/, evidence: null },
    { pattern: /\bma giam gia\b/, evidence: "ma giam gia" },
    { pattern: /\bkho (?:tai|o) [a-z]/, evidence: null },
    { pattern: /\b(?:con hang|co san|san kho|con kho)\b/, evidence: null },
  ];
  for (const claim of claims) {
    const match = normalized.match(claim.pattern);
    if (!match) continue;
    const phrase = claim.evidence || match[0];
    if (!lines.some((line) => line.includes(phrase))) return true;
  }
  if (/(?:trừ|giảm thêm|chiết khấu thêm).{0,20}\d+(?:[.,]\d+)?\s*%/iu.test(raw)) {
    const rawClaim = normalizeVietnamese(raw.match(/(?:trừ|giảm thêm|chiết khấu thêm).{0,20}\d+(?:[.,]\d+)?\s*%/iu)?.[0] || "");
    if (rawClaim && !lines.some((line) => line.includes(rawClaim))) return true;
  }
  return false;
}

function unsupportedScopedNumericFact(reply, modelInput, groups) {
  const facts = numericFacts(reply);
  if (!facts.length) return false;
  const customer = normalizeVietnamese(requestText(currentCustomerCluster(modelInput))).replace(/[\s.,]/g, "");
  const evidence = scopedKnowledgeLines(modelInput, groups).map((line) => normalizeVietnamese(line).replace(/[\s.,]/g, ""));
  return facts.some((fact) => {
    const normalized = normalizedFact(fact);
    if (!normalized || customer.includes(normalized)) return false;
    return !evidence.some((line) => line.includes(normalized));
  });
}

function unsupportedBareSensitiveNumber(reply, modelInput, groups) {
  const normalized = normalizeVietnamese(reply);
  if (!/\b(kich thuoc|rong|cao|dai|sau|cong suat|bao hanh|chiet khau|giam|tru|khoang cach|van chuyen)\b/.test(normalized)) return false;
  const numbers = String(reply || "").match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  if (!numbers.length) return false;
  const evidenceValues = [
    requestText(currentCustomerCluster(modelInput)),
    ...scopedKnowledgeLines(modelInput, groups),
  ];
  const evidenceNumbers = new Set(evidenceValues.flatMap((value) => String(value || "").match(/\b\d+(?:[.,]\d+)?\b/g) || [])
    .map((value) => value.replace(/[.,]/g, "")));
  return numbers.some((value) => !evidenceNumbers.has(value.replace(/[.,]/g, "")));
}

function languageIssue(value) {
  const text = String(value || "");
  const normalized = normalizeVietnamese(text);
  if (!text.trim()) return "EMPTY_REPLY";
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0370-\u03ff\u0400-\u04ff�]/u.test(text)) return "FOREIGN_SCRIPT_OR_REPLACEMENT_GLYPH";
  if (/[řŘůŮěĚšŠčČžŽňŇďĎťŤľĽĺĹŕŔäÄöÖüÜßåÅøØæÆłŁćĆśŚźŹżŻńŃ]/u.test(text)) return "NON_VIETNAMESE_DIACRITIC";
  if (/\b(katalog|de\s*sale|desale|tr ruznych|showoom|pho keo noi|zddw|cosi)\b/.test(normalized) || /\btrưng bình\b/iu.test(text)) return "KNOWN_PROVIDER_LANGUAGE_CORRUPTION";
  if (/<[^>]{1,120}>|selected_catalog_keys|final_reply|decision_reason|tool[_ .-]?call/i.test(text)) return "INTERNAL_OR_MARKUP_LEAK";
  return null;
}

function catalogMap(modelInput = {}) {
  const catalog = Array.isArray(modelInput?.knowledge_advisors?.catalog) ? modelInput.knowledge_advisors.catalog : [];
  return new Map(catalog.map((item) => [String(item?.catalog_key || ""), item]).filter(([key]) => key));
}

function catalogGroup(key, modelInput) {
  const byKey = catalogMap(modelInput);
  let cursor = String(key || "");
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    const group = groupForCandidateKey(cursor);
    if (group) return group;
    visited.add(cursor);
    cursor = String(byKey.get(cursor)?.parent_key || "");
  }
  return null;
}

function groupCompatible(ground, candidate) {
  if (!ground || !candidate) return false;
  if (ground === candidate) return true;
  if (ground === "combo_phong_tam" && BATHROOM_CHILDREN.has(candidate)) return true;
  if (ground === "phong_bep" && KITCHEN_CHILDREN.has(candidate)) return true;
  if (ground === "quat_tran" && FAN_CHILDREN.has(candidate)) return true;
  return false;
}

function filterCatalogKeys(decision, modelInput, grounds) {
  const selected = Array.isArray(decision?.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  if (!grounds.length) return [];
  return unique(selected.filter((key) => {
    const candidateGroup = catalogGroup(key, modelInput) || groupForCandidateKey(key);
    return grounds.some((ground) => groupCompatible(ground, candidateGroup));
  }));
}

export function commerceRequestContext(modelInput = {}) {
  const cluster = currentCustomerCluster(modelInput);
  const raw = requestText(cluster);
  const normalized = normalizeVietnamese(raw);
  const currentIds = new Set(cluster.map((message) => String(message?.id || "")).filter(Boolean));
  const direct = directProductGroups(cluster);
  const vision = visionGroups(modelInput);
  const advisor = advisorCustomerGroups(modelInput, currentIds);
  const mapping = mappingGroups(modelInput);
  let groups = direct;
  let groundingSource = direct.length ? "customer_text" : null;
  if (!groups.length && vision.length) {
    groups = vision;
    groundingSource = "vision";
  }
  if (!groups.length && advisor.length) {
    groups = advisor;
    groundingSource = "customer_advisor_evidence";
  }
  if (!groups.length && mapping.length) {
    groups = mapping;
    groundingSource = "mapping_fallback";
  }
  groups = mostSpecificGroups(groups);

  const intents = requestIntentKeys(raw);
  const asksPrice = intents.includes("price") || /\b(gia|bao gia|bao nhieu|tien)\b/.test(normalized);
  const asksSpecs = intents.includes("specs") || SPECIFIC_ATTRIBUTE.test(normalized);
  const asksAddress = intents.includes("address") || intents.includes("visit");
  const hasAttachments = customerHasAttachments(cluster);
  const hasReference = SPECIFIC_REFERENCE.test(normalized);
  const hasCode = containsModelCode(raw);
  const specific = asksSpecs || hasReference || hasCode || (asksPrice && hasAttachments);
  const generalGroupPrice = asksPrice
    && !specific
    && groups.length === 1
    && ["customer_text", "customer_advisor_evidence"].includes(String(groundingSource));
  const comment = commentPrivateReplyContextFromMessages(modelInput?.conversation?.messages || []);

  return {
    cluster,
    raw,
    normalized,
    intents,
    groups,
    groundingSource,
    hasAttachments,
    hasReference,
    hasCode,
    asksPrice,
    asksSpecs,
    asksAddress,
    specific,
    generalGroupPrice,
    comment,
  };
}

function safeSpecialistReply(modelInput, context) {
  const style = salutation(modelInput);
  const label = groupLabel(context.groups);
  const intro = context.groups.length
    ? `Dạ ${style.customer}, ${label} có nhiều model, kích thước/cấu hình và thương hiệu; thông tin và giá cần kiểm tra đúng mẫu theo chương trình từng thời điểm.`
    : `Dạ ${style.customer}, mẫu mình đang hỏi có nhiều model, phiên bản và thương hiệu; giá còn phụ thuộc đúng mẫu và chương trình từng thời điểm.`;
  return `${intro} ${contactSentence(modelInput)}`.replace(/\s+/g, " ").trim();
}

function safeGeneralPriceReply(modelInput, context, range) {
  const style = salutation(modelInput);
  const label = groupLabel(context.groups);
  return `Dạ ${style.customer}, khoảng giá ${label} bên ${style.seller} hiện ${range.value}. Giá từng mẫu còn tùy model, thương hiệu và chương trình tại thời điểm chọn ạ.`;
}

function safeLanguageFallback(modelInput, context) {
  const style = salutation(modelInput);
  if (context.asksAddress) {
    const address = verifiedAddressReply(modelInput);
    if (address) return `Dạ ${style.customer}, ${address}`;
  }
  if (context.groups.length || context.asksPrice || context.asksSpecs) return safeSpecialistReply(modelInput, context);
  return `Dạ ${style.customer}, ${style.seller} đã nhận nội dung và sẽ hỗ trợ mình ngay tại Messenger ạ.`;
}

export function commerceDecisionViolations(decision = {}, modelInput = {}) {
  const context = commerceRequestContext(modelInput);
  const violations = [];
  const reply = String(decision?.final_reply || "");
  const language = languageIssue(reply);
  if (language) violations.push(`CORRUPTED_VIETNAMESE:${language}`);

  const replyGroups = directProductGroups([{ text: reply }]);
  if (replyGroups.some((replyGroup) => !context.groups.some((ground) => groupCompatible(ground, replyGroup)))) {
    violations.push(context.groups.length ? "CROSS_PRODUCT_REPLY_CLAIM" : "UNGROUNDED_PRODUCT_CLAIM");
  }

  const selected = Array.isArray(decision?.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  if (selected.length && filterCatalogKeys(decision, modelInput, context.groups).length !== selected.length) {
    violations.push("CROSS_PRODUCT_CATALOG_SELECTION");
  }
  if (context.specific) {
    const contact = contactDisposition(modelInput);
    const safeHandoff = contact.known
      ? !decision?.should_request_contact && !contactRequestDetected(reply)
      : (contact.refused || contact.cooldown.active)
        ? !decision?.should_request_contact && !contactRequestDetected(reply)
        : decision?.should_request_contact && contactRequestDetected(reply);
    if (numericFacts(reply).length || !safeHandoff || decision?.needs_slides || decision?.action === "reply_with_slides") {
      violations.push("SPECIFIC_PRODUCT_INFORMATION_REQUIRES_CONTACT_HANDOFF");
    }
  }
  if (context.generalGroupPrice) {
    const range = priceRangeForGroup(modelInput, context.groups[0]);
    if (!range) violations.push("GROUP_PRICE_RANGE_NOT_CONFIGURED");
    else if (!normalizeVietnamese(reply).includes(normalizeVietnamese(range.value).replace(/^tu\s+/, ""))) violations.push("GROUP_PRICE_RANGE_MISSING_OR_WRONG");
  } else if (unsupportedScopedNumericFact(reply, modelInput, context.groups)) {
    violations.push("UNSCOPED_NUMERIC_FACT");
  }
  if (unsupportedBareSensitiveNumber(reply, modelInput, context.groups)) violations.push("UNSCOPED_SENSITIVE_NUMBER");
  if (policyClaimWithoutEvidence(reply, modelInput, context.groups)) violations.push("UNVERIFIED_COMMERCIAL_POLICY_CLAIM");
  if (context.comment && (decision?.needs_slides || decision?.action === "reply_with_slides")) {
    violations.push("COMMENT_PRIVATE_REPLY_TEXT_ONLY");
  }
  return unique(violations);
}

export function enforceCommerceIntegrity(input = {}, modelInput = {}) {
  const decision = structuredClone(input || {});
  const context = commerceRequestContext(modelInput);
  const initialViolations = commerceDecisionViolations(decision, modelInput);
  const filteredCatalog = filterCatalogKeys(decision, modelInput, context.groups);
  let repairMode = "verified_passthrough";

  decision.selected_catalog_keys = filteredCatalog;
  if (!context.groups.length) decision.selected_products = [];
  else decision.selected_products = context.groups.map((group) => PRODUCT_GROUPS[group]?.label || group);

  const language = languageIssue(decision.final_reply);
  const replyGroups = directProductGroups([{ text: decision.final_reply || "" }]);
  const productMismatch = replyGroups.some((replyGroup) => !context.groups.some((ground) => groupCompatible(ground, replyGroup)));
  const unsafeNumeric = !context.generalGroupPrice && unsupportedScopedNumericFact(decision.final_reply, modelInput, context.groups);
  const unsafeSensitiveNumber = unsupportedBareSensitiveNumber(decision.final_reply, modelInput, context.groups);
  const unsafePolicy = policyClaimWithoutEvidence(decision.final_reply, modelInput, context.groups);
  const contact = contactDisposition(modelInput);
  const addressOnly = context.asksAddress && !context.asksPrice && !context.asksSpecs && !context.specific;

  if (addressOnly) {
    const address = verifiedAddressReply(modelInput);
    if (address) {
      const style = salutation(modelInput);
      decision.final_reply = `Dạ ${style.customer}, ${address}`;
      decision.should_request_contact = false;
      decision.contact_state = contact.known ? "known" : "unclear";
      repairMode = "deterministic_verified_address";
    } else {
      decision.final_reply = safeSpecialistReply(modelInput, context);
      decision.should_request_contact = contact.shouldRequest;
      decision.contact_state = contact.state;
      repairMode = "address_not_configured_contact_handoff";
    }
    decision.action = "reply_text";
    decision.needs_slides = false;
    decision.selected_catalog_keys = [];
  } else if (context.generalGroupPrice) {
    const range = priceRangeForGroup(modelInput, context.groups[0]);
    if (range) {
      decision.final_reply = safeGeneralPriceReply(modelInput, context, range);
      decision.should_request_contact = false;
      decision.contact_state = contact.known ? "known" : "unclear";
      repairMode = "deterministic_group_price_range";
    } else {
      decision.final_reply = safeSpecialistReply(modelInput, context);
      decision.should_request_contact = contact.shouldRequest;
      decision.contact_state = contact.state;
      repairMode = "group_price_range_missing_handoff";
    }
    decision.action = "reply_text";
    decision.needs_slides = false;
    decision.selected_catalog_keys = [];
  } else if (context.specific || productMismatch || unsafeNumeric || unsafeSensitiveNumber || unsafePolicy || (!context.groups.length && replyGroups.length)) {
    decision.final_reply = safeSpecialistReply(modelInput, context);
    decision.should_request_contact = contact.shouldRequest;
    decision.contact_state = contact.state;
    decision.action = "reply_text";
    decision.needs_slides = false;
    decision.selected_catalog_keys = [];
    repairMode = context.specific
      ? "specific_request_contact_handoff"
      : (productMismatch ? "cross_product_claim_blocked" : (unsafePolicy ? "commercial_policy_claim_blocked" : "unscoped_fact_blocked"));
  } else if (language) {
    decision.final_reply = safeLanguageFallback(modelInput, context);
    decision.should_request_contact = Boolean((context.groups.length || context.asksPrice || context.asksSpecs) && contact.shouldRequest);
    decision.contact_state = contact.known ? "known" : (contact.refused ? "refused_messenger_only" : (contact.cooldown.active ? "missing_recently_requested" : (decision.should_request_contact ? "missing" : "unclear")));
    decision.action = "reply_text";
    decision.needs_slides = false;
    decision.selected_catalog_keys = [];
    repairMode = "corrupted_language_replaced";
  }

  if (context.comment) {
    if (phoneInCurrentCluster(modelInput)) {
      const style = salutation(modelInput);
      decision.final_reply = `Dạ ${style.customer}, ${style.seller} đã nhận SĐT và chuyển chuyên viên liên hệ để kiểm tra đúng mẫu, gửi hình và báo giá cho mình ạ.`;
      decision.should_request_contact = false;
      decision.contact_state = "known";
      repairMode = repairMode === "verified_passthrough" ? "comment_contact_acknowledgement" : `${repairMode}+comment_contact_acknowledgement`;
    }
    decision.action = "reply_text";
    decision.needs_slides = false;
    decision.selected_catalog_keys = [];
    repairMode = repairMode === "verified_passthrough" ? "comment_private_reply_text_only" : `${repairMode}+comment_private_reply_text_only`;
  }

  decision.contact_benefit = "chuyên viên lọc đúng mẫu, gửi hình, tư vấn và báo giá hiện tại";
  decision.commerce_integrity = {
    version: "v10_commerce_integrity_v1",
    grounding_source: context.groundingSource,
    grounded_product_groups: context.groups,
    specific_request: context.specific,
    general_group_price: context.generalGroupPrice,
    comment_private_reply: Boolean(context.comment),
    initial_violations: initialViolations,
    repair_mode: repairMode,
  };
  return decision;
}

export { languageIssue as vietnameseLanguageIssue, priceRangeForGroup };
export const commerceIntegrityVersion = "v10_commerce_integrity_v1_grounded_facts";
