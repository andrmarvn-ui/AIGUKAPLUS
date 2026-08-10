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

function hierarchy(catalog = []) {
  const nodes = Array.isArray(catalog) ? catalog : [];
  const byKey = new Map(nodes
    .map((node) => [String(node?.catalog_key || "").trim(), node])
    .filter(([key]) => Boolean(key)));

  function isWithin(node, ancestorKey) {
    let key = String(node?.catalog_key || "").trim();
    const visited = new Set();
    while (key && !visited.has(key)) {
      if (key === ancestorKey) return true;
      visited.add(key);
      key = String(byKey.get(key)?.parent_key || "").trim();
    }
    return false;
  }

  function recursiveAssets(node) {
    const scopeKey = String(node?.catalog_key || "").trim();
    const seen = new Set();
    const assets = [];
    for (const candidate of nodes) {
      if (!scopeKey || !isWithin(candidate, scopeKey)) continue;
      for (const asset of Array.isArray(candidate?.assets) ? candidate.assets : []) {
        const url = String(asset?.source_url || "").trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        assets.push({
          asset_id: asset.asset_id || null,
          source_url: url,
          title: asset.title || candidate.display_name || node.display_name || "Mẫu sản phẩm",
          sort_order: Number(asset.sort_order || 0),
          source_catalog_key: candidate.catalog_key || null,
        });
      }
    }
    return assets.sort((a, b) => a.sort_order - b.sort_order);
  }

  return { byKey, recursiveAssets };
}

export function buildKnowledgeAdvisors(snapshot = {}, conversation = {}, limits = {}) {
  const content = snapshot?.content || snapshot || {};
  const documents = Array.isArray(content.documents) ? content.documents : [];
  const catalog = Array.isArray(content.catalog) ? content.catalog : [];
  const mappings = Array.isArray(content.ad_mappings) ? content.ad_mappings : [];
  const maxDocuments = Math.max(1, Number(limits.maxDocuments || 8));
  const maxDocumentChars = Math.max(3000, Math.min(20000, Number(limits.maxDocumentChars || 12000)));
  const maxTotalDocumentChars = Math.max(
    maxDocumentChars,
    Math.min(50000, Number(limits.maxTotalDocumentChars || 24000)),
  );
  const maxCatalog = Math.max(1, Number(limits.maxCatalog || 16));
  const maxAssets = Math.max(1, Number(limits.maxAssetsPerCatalog || 6));

  const ids = referralIds(conversation.referral || {});
  const matchedMappings = mappings.filter((mapping) => {
    if (mapping?.is_active === false) return false;
    if (ids.ad_id) return String(mapping.ad_id || "") === ids.ad_id;
    if (ids.adset_id) return String(mapping.adset_id || "") === ids.adset_id;
    if (ids.campaign_id) return String(mapping.campaign_id || "") === ids.campaign_id;
    return false;
  }).slice(0, 6);

  const conversationText = (conversation.messages || []).filter((message) => message.role === "customer").map((message) => message.text).join(" ");
  const candidateKeys = unique([
    ...(conversation.advisors?.product_candidates || []).map((item) => item.key),
    ...matchedMappings.flatMap((mapping) => Array.isArray(mapping.catalog_keys) ? mapping.catalog_keys : []),
  ]);
  const tokens = words(`${conversationText} ${candidateKeys.join(" ")}`);

  const rankedDocuments = documents
    .map((document) => ({ document, score: scoreText(documentText(document), tokens) }))
    .sort((a, b) => b.score - a.score)
    .filter((item, index) => item.score > 0 || index < 2)
    .slice(0, maxDocuments);

  const selectedDocuments = [];
  let usedDocumentChars = 0;
  for (const { document, score } of rankedDocuments) {
    const raw = String(document.content || document.text || document.body || "");
    const remaining = maxTotalDocumentChars - usedDocumentChars;
    if (remaining <= 0) break;
    const selectedContent = raw.slice(0, Math.min(maxDocumentChars, remaining));
    usedDocumentChars += selectedContent.length;
    selectedDocuments.push({
      document_key: document.document_key,
      version_no: document.version_no,
      title: document.title || null,
      content: selectedContent,
      content_chars: selectedContent.length,
      source_content_chars: raw.length,
      content_truncated: selectedContent.length < raw.length,
      relevance_score: score,
      advisory_only: true,
    });
  }

  const { recursiveAssets } = hierarchy(catalog);
  const selectedCatalog = catalog
    .map((node) => {
      const exact = candidateKeys.includes(node.catalog_key) ? 10 : 0;
      const score = exact + scoreText(catalogText(node), tokens);
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter((item, index) => item.score > 0 || index < 4)
    .slice(0, maxCatalog)
    .map(({ node, score }) => {
      const assets = recursiveAssets(node);
      return {
        catalog_key: node.catalog_key,
        display_name: node.display_name,
        parent_key: node.parent_key || null,
        root_key: node.root_key || node.catalog_key || null,
        aliases: Array.isArray(node.aliases) ? node.aliases.slice(0, 20) : [],
        asset_count: assets.length,
        own_asset_count: Array.isArray(node.assets) ? node.assets.filter((asset) => asset?.source_url).length : 0,
        recursive_assets: true,
        assets: assets.slice(0, maxAssets),
        relevance_score: score,
        advisory_only: true,
      };
    });

  const selectedMappings = matchedMappings.map((mapping) => ({
    ad_id: mapping.ad_id || null,
    adset_id: mapping.adset_id || null,
    campaign_id: mapping.campaign_id || null,
    catalog_keys: Array.isArray(mapping.catalog_keys) ? mapping.catalog_keys : [],
    fallback_catalog_keys: Array.isArray(mapping?.metadata?.fallback_catalog_keys)
      ? mapping.metadata.fallback_catalog_keys
      : [],
    confidence: Number(mapping.confidence || 0),
    advisory_only: true,
  }));

  return {
    policy: "Knowledge, catalog and mapping are evidence for AI, never authoritative decisions.",
    documents: selectedDocuments,
    catalog: selectedCatalog,
    slide_catalog: selectedCatalog.filter((item) => Number(item.asset_count || 0) > 0),
    ad_mappings: selectedMappings,
  };
}
