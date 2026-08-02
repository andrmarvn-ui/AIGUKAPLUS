function text(value) { return String(value ?? "").trim(); }
function array(value) { return Array.isArray(value) ? value : []; }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function lower(value) {
  return text(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/đ/g, "d").toLowerCase();
}
function capString(value, max) {
  const source = text(value);
  return source.length <= max ? source : `${source.slice(0, Math.max(0, max - 1))}…`;
}
function numericTime(value) { const n = Date.parse(String(value || "")); return Number.isFinite(n) ? n : 0; }

function referralIds(input) {
  const candidates = [input?.turn?.referral, input?.referral, input?.customer?.referral, input?.latest_event?.referral].filter(Boolean);
  const values = { ad_id: null, adset_id: null, campaign_id: null };
  for (const candidate of candidates) {
    values.ad_id ||= text(candidate.ad_id || candidate.adId) || null;
    values.adset_id ||= text(candidate.adset_id || candidate.adsetId) || null;
    values.campaign_id ||= text(candidate.campaign_id || candidate.campaignId) || null;
  }
  return values;
}

function latestDocuments(documents, pageId) {
  const eligible = array(documents).filter((document) => document?.status === "published"
    && (!document.page_id || String(document.page_id) === String(pageId || "")));
  const byKey = new Map();
  for (const document of eligible) {
    const key = text(document.document_key) || text(document.title) || String(document.id || "");
    const previous = byKey.get(key);
    const rank = [Number(document.version_no || 0), numericTime(document.created_at), document.page_id ? 1 : 0];
    const previousRank = previous
      ? [Number(previous.version_no || 0), numericTime(previous.created_at), previous.page_id ? 1 : 0]
      : [-1, -1, -1];
    if (!previous || rank[0] > previousRank[0]
      || (rank[0] === previousRank[0] && rank[1] > previousRank[1])
      || (rank[0] === previousRank[0] && rank[1] === previousRank[1] && rank[2] > previousRank[2])) {
      byKey.set(key, document);
    }
  }
  return [...byKey.values()];
}

function scoreDocument(document, pageId, query, intents) {
  let score = 0;
  if (document.page_id && String(document.page_id) === String(pageId || "")) score += 25;
  const type = text(document.document_type);
  if (type === "system_prompt") score += 100;
  if (type === "business_policy") score += 90;
  if (type === "location" && intents.includes("address")) score += 120;
  if (type === "promotion" && /uu dai|khuyen mai|giam gia|sale/.test(query)) score += 80;
  if (type === "approved_example") score += 25;
  if (type === "context") score += 40;
  const haystack = lower(`${document.title || ""} ${document.content || ""}`);
  for (const token of query.split(/\s+/).filter((item) => item.length >= 3)) if (haystack.includes(token)) score += 2;
  score += Math.max(0, 20 - Number(document.priority || 100) / 10);
  score += Number(document.version_no || 0) / 1000;
  return score;
}

function catalogKeysFromTurn(turn) {
  return unique([
    ...array(turn?.salesSignals?.products),
    ...array(turn?.sales_signals?.products),
  ].map(text));
}

function concreteCatalogKeys(mapping, catalogKeySet) {
  return unique(array(mapping?.catalog_keys)
    .map(text)
    .filter((key) => key && !["general", "unknown", "multi"].includes(lower(key)) && catalogKeySet.has(key)));
}

function scoreCatalog(node, requestedKeys, query) {
  if (!node || node.is_active === false) return -Infinity;
  let score = 0;
  const key = text(node.catalog_key);
  const root = text(node.root_key);
  if (requestedKeys.includes(key)) score += 250;
  if (requestedKeys.includes(root)) score += 140;
  const aliases = array(node.aliases).map(lower);
  const names = [lower(node.display_name), lower(key.replaceAll("_", " ")), ...aliases]
    .filter((name) => name.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (query.includes(name)) score += Math.min(150, 60 + name.length * 4);
  }
  if (requestedKeys.length && score <= 0) return -Infinity;
  return score;
}

function compactDocument(document, maxChars) {
  return {
    document_key: document.document_key,
    version_no: document.version_no,
    document_type: document.document_type,
    page_id: document.page_id || null,
    title: document.title,
    content: capString(document.content, maxChars),
    priority: document.priority,
  };
}
function compactAsset(asset) {
  return {
    asset_id: asset.asset_id,
    provider: asset.provider,
    external_id: asset.external_id,
    folder_id: asset.folder_id || asset?.metadata?.folder_id || null,
    source_url: asset.source_url,
    mime_type: asset.mime_type,
    sort_order: asset.sort_order,
    role: asset.role,
  };
}
function compactCatalog(node, maxAssets) {
  return {
    catalog_key: node.catalog_key,
    parent_key: node.parent_key || null,
    root_key: node.root_key || null,
    display_name: node.display_name,
    node_type: node.node_type,
    aliases: array(node.aliases).slice(0, 30),
    intents: array(node.intents).slice(0, 12),
    rules: array(node.rules).slice(0, 20),
    asset_policy: node.asset_policy || {},
    assets: array(node.assets).filter((asset) => text(asset?.source_url)).slice(0, maxAssets).map(compactAsset),
  };
}

export function selectKnowledgeContext(snapshot, decisionInput = {}, options = {}) {
  const content = snapshot?.content && typeof snapshot.content === "object" ? snapshot.content : {};
  const turn = decisionInput?.turn || {};
  const combinedText = text(turn.combinedText || turn.combined_text || decisionInput?.combinedText);
  const contextText = text(turn.contextText || turn.context_text || decisionInput?.contextText);
  const pageId = text(decisionInput?.page_id || decisionInput?.pageId || decisionInput?.customer?.page_id || decisionInput?.customer?.pageId);
  const intents = unique([
    ...array(turn?.salesSignals?.intents),
    ...array(turn?.sales_signals?.intents),
  ].map(text));
  const referral = referralIds(decisionInput);
  const catalogNodes = array(content.catalog);
  const catalogKeySet = new Set(catalogNodes.map((node) => text(node?.catalog_key)).filter(Boolean));

  const adMappings = array(content.ad_mappings)
    .filter((mapping) => {
      if (mapping?.is_active === false) return false;
      if (referral.ad_id) return text(mapping.ad_id) === referral.ad_id;
      if (referral.adset_id) return text(mapping.adset_id) === referral.adset_id;
      if (referral.campaign_id) return text(mapping.campaign_id) === referral.campaign_id;
      return false;
    })
    .slice(0, 4)
    .map((mapping) => {
      const candidateKeys = concreteCatalogKeys(mapping, catalogKeySet);
      return {
        page_id: mapping.page_id,
        ad_account_id: mapping.ad_account_id,
        campaign_id: mapping.campaign_id,
        adset_id: mapping.adset_id,
        ad_id: mapping.ad_id,
        catalog_keys: candidateKeys,
        candidate_catalog_keys: candidateKeys,
        mapping_target_type: mapping?.metadata?.mapping_target_type || null,
        confidence: mapping.confidence,
        metadata: mapping.metadata || {},
      };
    });

  const explicitKeys = catalogKeysFromTurn(turn).filter((key) => catalogKeySet.has(key));
  const forcedMappingKeys = unique(adMappings.flatMap((mapping) => {
    const keys = array(mapping.candidate_catalog_keys);
    const target = lower(mapping.mapping_target_type);
    return target === "product" || keys.length === 1 ? keys : [];
  }));
  const requestedKeys = explicitKeys.length ? explicitKeys : forcedMappingKeys;
  const mappingText = adMappings.map((mapping) => [
    mapping?.metadata?.ad_name,
    mapping?.metadata?.recognition_name,
    mapping?.metadata?.product_name,
    mapping?.metadata?.slide_key,
  ].filter(Boolean).join(" ")).join(" ");
  const query = lower(`${contextText}\n${combinedText}\n${mappingText}`);

  const maxDocuments = Math.max(1, Math.min(12, Number(options.maxDocuments || 6)));
  const maxDocumentChars = Math.max(200, Math.min(6000, Number(options.maxDocumentChars || 1800)));
  const maxCatalogNodes = Math.max(1, Math.min(12, Number(options.maxCatalogNodes || 6)));
  const maxAssetsPerNode = Math.max(0, Math.min(30, Number(options.maxAssetsPerNode || 6)));

  const documents = latestDocuments(content.documents, pageId)
    .map((document, index) => ({ document, index, score: scoreDocument(document, pageId, query, intents) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxDocuments)
    .map((item) => compactDocument(item.document, maxDocumentChars));

  let catalog = catalogNodes
    .map((node, index) => ({ node, index, score: scoreCatalog(node, requestedKeys, query) }))
    .filter((item) => Number.isFinite(item.score) && item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxCatalogNodes)
    .map((item) => compactCatalog(item.node, maxAssetsPerNode));

  if (!catalog.length && !requestedKeys.length) {
    catalog = catalogNodes
      .filter((node) => node?.is_active !== false && ["root", "scope"].includes(text(node?.node_type)))
      .slice(0, Math.min(3, maxCatalogNodes))
      .map((node) => compactCatalog(node, maxAssetsPerNode));
  }

  return {
    snapshot: { id: snapshot?.id || null, version_no: snapshot?.version_no ?? null, checksum: snapshot?.checksum || null },
    query: {
      page_id: pageId || null,
      combined_text: capString(combinedText, 3000),
      context_text: capString(contextText, 5000),
      intents,
      requested_catalog_keys: requestedKeys,
      explicit_catalog_keys: explicitKeys,
      referral,
    },
    documents,
    catalog,
    ad_mappings: adMappings,
    limits: {
      max_documents: maxDocuments,
      max_document_chars: maxDocumentChars,
      max_catalog_nodes: maxCatalogNodes,
      max_assets_per_node: maxAssetsPerNode,
    },
  };
}
