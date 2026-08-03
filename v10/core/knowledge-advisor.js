import { normalizeVietnamese } from "./advisory-engine.js";

const unique = (values) => [...new Set((values || []).filter(Boolean))];

function words(value) {
  return unique(normalizeVietnamese(value).split(/\s+/).filter((word) => word.length >= 3));
}

function scoreText(text, tokens) {
  const normalized = normalizeVietnamese(text);
  if (!normalized || !tokens.length) return 0;
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
}

function documentText(document = {}) {
  return [document.document_key, document.title, document.content, document.text, document.body].filter(Boolean).join(" ");
}

function catalogText(node = {}) {
  return [node.catalog_key, node.display_name, ...(Array.isArray(node.aliases) ? node.aliases : [])].filter(Boolean).join(" ");
}

function referralIds(referral = {}) {
  const ads = referral.ads_context_data || referral.adsContextData || {};
  return {
    ad_id: String(referral.ad_id || ads.ad_id || ""),
    adset_id: String(referral.adset_id || ads.adset_id || ""),
    campaign_id: String(referral.campaign_id || ads.campaign_id || ""),
  };
}

export function buildKnowledgeAdvisors(snapshot = {}, conversation = {}, limits = {}) {
  const content = snapshot?.content || snapshot || {};
  const documents = Array.isArray(content.documents) ? content.documents : [];
  const catalog = Array.isArray(content.catalog) ? content.catalog : [];
  const mappings = Array.isArray(content.ad_mappings) ? content.ad_mappings : [];
  const maxDocuments = Math.max(1, Number(limits.maxDocuments || 8));
  const maxCatalog = Math.max(1, Number(limits.maxCatalog || 12));
  const maxAssets = Math.max(1, Number(limits.maxAssetsPerCatalog || 8));

  const conversationText = (conversation.messages || []).filter((message) => message.role === "customer").map((message) => message.text).join(" ");
  const candidateKeys = (conversation.advisors?.product_candidates || []).map((item) => item.key);
  const tokens = words(`${conversationText} ${candidateKeys.join(" ")}`);

  const selectedDocuments = documents
    .map((document) => ({ document, score: scoreText(documentText(document), tokens) }))
    .sort((a, b) => b.score - a.score)
    .filter((item, index) => item.score > 0 || index < 2)
    .slice(0, maxDocuments)
    .map(({ document, score }) => ({
      document_key: document.document_key,
      version_no: document.version_no,
      title: document.title || null,
      content: String(document.content || document.text || document.body || "").slice(0, 3000),
      relevance_score: score,
      advisory_only: true,
    }));

  const selectedCatalog = catalog
    .map((node) => {
      const exact = candidateKeys.includes(node.catalog_key) ? 10 : 0;
      const score = exact + scoreText(catalogText(node), tokens);
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter((item, index) => item.score > 0 || index < 4)
    .slice(0, maxCatalog)
    .map(({ node, score }) => ({
      catalog_key: node.catalog_key,
      display_name: node.display_name,
      aliases: Array.isArray(node.aliases) ? node.aliases.slice(0, 20) : [],
      asset_count: Array.isArray(node.assets) ? node.assets.filter((asset) => asset?.source_url).length : 0,
      assets: (Array.isArray(node.assets) ? node.assets : []).filter((asset) => asset?.source_url).slice(0, maxAssets).map((asset) => ({
        asset_id: asset.asset_id || null,
        source_url: asset.source_url,
        title: asset.title || node.display_name || "Mẫu sản phẩm",
        sort_order: Number(asset.sort_order || 0),
      })),
      relevance_score: score,
      advisory_only: true,
    }));

  const ids = referralIds(conversation.referral || {});
  const selectedMappings = mappings.filter((mapping) => {
    if (mapping?.is_active === false) return false;
    if (ids.ad_id) return String(mapping.ad_id || "") === ids.ad_id;
    if (ids.adset_id) return String(mapping.adset_id || "") === ids.adset_id;
    if (ids.campaign_id) return String(mapping.campaign_id || "") === ids.campaign_id;
    return false;
  }).slice(0, 6).map((mapping) => ({
    ad_id: mapping.ad_id || null,
    adset_id: mapping.adset_id || null,
    campaign_id: mapping.campaign_id || null,
    catalog_keys: Array.isArray(mapping.catalog_keys) ? mapping.catalog_keys : [],
    confidence: Number(mapping.confidence || 0),
    advisory_only: true,
  }));

  return {
    policy: "Knowledge, catalog and mapping are evidence for AI, never authoritative decisions.",
    documents: selectedDocuments,
    catalog: selectedCatalog,
    ad_mappings: selectedMappings,
  };
}
