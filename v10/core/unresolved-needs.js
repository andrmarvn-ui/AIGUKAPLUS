import { deriveMediaScope, explicitMediaRequestFromMessages, mediaExpectedFromMessages } from "./media-obligation.js";
import { normalizeVietnamese } from "./advisory-engine.js";

function messagesOf(conversation = {}) {
  return Array.isArray(conversation?.messages) ? conversation.messages : [];
}

function activeCustomer(message) {
  if (!message || message.role !== "customer") return false;
  return !["superseded", "cancelled"].includes(String(message.semantic_status || "active").toLowerCase());
}

function currentCustomerCluster(messages = []) {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1).filter(activeCustomer);
}

function hasContact(text = "") {
  return /(?:^|\D)(?:\+?84|0)(?:[\s.()-]*\d){8,10}(?:\D|$)|\bzalo\b.{0,20}(?:\d[\s.-]*){8,10}/i.test(String(text));
}

function topicFor(key, catalogByKey) {
  return String(catalogByKey.get(key)?.display_name || key || "").trim();
}

export function deriveUnresolvedNeeds(conversation = {}, knowledgeAdvisors = {}) {
  const messages = messagesOf(conversation);
  const catalog = Array.isArray(knowledgeAdvisors?.catalog) ? knowledgeAdvisors.catalog : [];
  const slideCatalog = Array.isArray(knowledgeAdvisors?.slide_catalog)
    ? knowledgeAdvisors.slide_catalog
    : catalog.filter((item) => Number(item?.asset_count || 0) > 0);
  const slideKeys = new Set(slideCatalog.map((item) => String(item?.catalog_key || "").trim()).filter(Boolean));
  const catalogByKey = new Map(catalog.map((item) => [String(item?.catalog_key || "").trim(), item]).filter(([key]) => Boolean(key)));
  const scope = deriveMediaScope(messages, slideKeys, {
    productCandidates: Array.isArray(knowledgeAdvisors?.product_candidates)
      ? knowledgeAdvisors.product_candidates
      : [],
  });
  const mediaExplicit = explicitMediaRequestFromMessages(messages);
  const mediaExpected = mediaExpectedFromMessages(messages, scope);
  const cluster = currentCustomerCluster(messages);
  const clusterTextRaw = cluster.map((message) => String(message?.text || "")).join(" ");
  const clusterText = normalizeVietnamese(clusterTextRaw);
  const unresolved = [];

  for (const key of scope) {
    unresolved.push({
      topic: topicFor(key, catalogByKey),
      catalog_keys: [key],
      status: mediaExpected ? "pending_media" : "pending_answer",
      evidence: mediaExpected ? "unresolved_media_window" : "current_customer_cluster",
    });
  }

  const asksPrice = /\b(gia|bao gia|bao nhieu|xin gia|gia sao|cost)\b/.test(clusterText);
  const asksAddress = /\b(dia chi|o dau|showroom|cua hang|kho o dau|cong ty o dau)\b/.test(clusterText);
  const asksDelivery = /\b(giao hang|van chuyen|ship|mien phi van chuyen|phi ship)\b/.test(clusterText);
  if (asksPrice) unresolved.push({ topic: "báo giá", catalog_keys: scope, status: "pending_answer", evidence: "current_customer_cluster" });
  if (asksAddress) unresolved.push({ topic: "địa chỉ/showroom", catalog_keys: [], status: "pending_answer", evidence: "current_customer_cluster" });
  if (asksDelivery) unresolved.push({ topic: "vận chuyển", catalog_keys: scope, status: "pending_answer", evidence: "current_customer_cluster" });
  if (hasContact(clusterTextRaw)) unresolved.push({ topic: "ghi nhận liên hệ khách hàng", catalog_keys: [], status: "pending_answer", evidence: "current_customer_cluster" });

  const seen = new Set();
  return unresolved.filter((need) => {
    const signature = `${need.topic}|${need.status}|${(need.catalog_keys || []).join(",")}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  }).slice(0, 12).map((need) => ({ ...need, media_explicit: mediaExplicit }));
}

export const unresolvedNeedsVersion = "v10_unresolved_needs_v3_candidate_media_scope";
