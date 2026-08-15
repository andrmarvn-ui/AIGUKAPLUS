const DEFAULT_BUDGET_CHARS = 9_000;

const PROFILES = [
  {
    name: "standard",
    messageLimit: 10,
    messageTextChars: 3_200,
    perMessageChars: 650,
    documentLimit: 2,
    documentTextChars: 2_400,
    perDocumentChars: 1_600,
    catalogLimit: 10,
    aliasLimit: 3,
    threadLimit: 8,
  },
  {
    name: "compact",
    messageLimit: 8,
    messageTextChars: 2_400,
    perMessageChars: 520,
    documentLimit: 1,
    documentTextChars: 1_400,
    perDocumentChars: 1_400,
    catalogLimit: 8,
    aliasLimit: 2,
    threadLimit: 6,
  },
  {
    name: "minimal",
    messageLimit: 6,
    messageTextChars: 1_600,
    perMessageChars: 420,
    documentLimit: 1,
    documentTextChars: 700,
    perDocumentChars: 700,
    catalogLimit: 6,
    aliasLimit: 0,
    threadLimit: 5,
  },
  {
    name: "hard_minimum",
    messageLimit: 4,
    messageTextChars: 900,
    perMessageChars: 320,
    documentLimit: 0,
    documentTextChars: 0,
    perDocumentChars: 0,
    catalogLimit: 4,
    aliasLimit: 0,
    threadLimit: 4,
  },
];

const FORBIDDEN_PROVIDER_KEYS = new Set([
  "payload",
  "raw_payload",
  "referral",
  "attachments",
  "assets",
  "source_url",
  "attachment_url",
  "attachmenturl",
  "url",
  "phone",
  "zalo",
]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(array(values).map(clean).filter(Boolean))];
}

function scrubText(value, maxChars) {
  const source = clean(value)
    .replace(/https?:\/\/\S+/giu, "[đã loại URL]")
    .replace(/(?:^|\D)(?:\+?84|0)(?:[\s.()-]*\d){8,10}(?=\D|$)/gu, (match) => {
      const prefix = /^\D/u.test(match) ? match[0] : "";
      return `${prefix}[đã có liên hệ]`;
    });
  if (!Number.isFinite(maxChars) || maxChars <= 0 || source.length <= maxChars) return source;
  return `${source.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function messageMediaSummary(message = {}) {
  const types = unique(array(message.attachments).map((item) => item?.type || item?.media_type));
  const catalogKeys = unique([
    ...array(message.media_catalog_keys),
    ...array(message.attachments).flatMap((item) => array(item?.catalog_keys)),
  ]).slice(0, 6);
  if (!types.length && !catalogKeys.length) return null;
  return {
    present: true,
    types: types.slice(0, 4),
    catalog_keys: catalogKeys,
  };
}

function compactMessage(message = {}, textLimit = 500) {
  const postback = message?.postback && typeof message.postback === "object"
    ? {
        title: scrubText(message.postback.title, 160) || null,
        effective_payload: scrubText(message.postback.effective_payload || message.postback.payload, 120) || null,
      }
    : null;
  const media = messageMediaSummary(message);
  const text = scrubText(message.text, textLimit);
  return {
    id: clean(message.id) || null,
    role: clean(message.role) || "unknown",
    event_type: clean(message.event_type) || null,
    text: text || null,
    occurred_at: message.occurred_at || null,
    semantic_status: clean(message.semantic_status) || null,
    semantic_relation: clean(message.semantic_relation) || null,
    postback: postback && (postback.title || postback.effective_payload) ? postback : null,
    media,
    contact_provided: /\[đã có liên hệ\]/u.test(text),
  };
}

function compactMessages(messages = [], profile = PROFILES[0]) {
  const selected = array(messages)
    .filter((message) => message && ["customer", "human", "bot", "automation", "page"].includes(clean(message.role)))
    .slice(-profile.messageLimit);
  let remaining = profile.messageTextChars;
  const compacted = [];
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const sourceText = clean(selected[index]?.text);
    const allowed = Math.max(0, Math.min(profile.perMessageChars, remaining));
    const item = compactMessage(selected[index], allowed);
    remaining -= Math.min(allowed, sourceText.length);
    compacted.push(item);
  }
  return compacted.reverse();
}

function compactCustomer(customer = {}, state = {}) {
  return {
    display_name: scrubText(customer.display_name, 100) || null,
    gender: clean(customer.gender) || null,
    preferred_salutation: scrubText(customer.preferred_salutation, 50) || null,
    contact_known: Boolean(
      customer.phone
      || customer.zalo
      || state.phone
      || state.zalo
      || ["captured", "verified"].includes(clean(state.contact_status).toLowerCase())
    ),
  };
}

function compactState(state = {}, customer = {}) {
  return {
    contact_status: clean(state.contact_status) || (customer.phone || customer.zalo ? "captured" : "missing"),
    has_phone: Boolean(state.phone || customer.phone),
    has_zalo: Boolean(state.zalo || customer.zalo),
    human_takeover: Boolean(state.human_takeover),
    last_customer_event_at: state.last_customer_event_at || null,
    last_page_event_at: state.last_page_event_at || null,
  };
}

function compactProductCandidates(knowledgeAdvisors = {}, conversation = {}) {
  const source = array(knowledgeAdvisors.product_candidates).length
    ? knowledgeAdvisors.product_candidates
    : array(conversation?.advisors?.product_candidates);
  const byKey = new Map();
  for (const item of array(source)) {
    const key = clean(item?.key);
    if (!key) continue;
    const current = byKey.get(key) || { product_key: key, label: clean(item?.label) || key, confidence: 0 };
    current.confidence = Math.max(current.confidence, Number(item?.confidence || 0));
    byKey.set(key, current);
  }
  return [...byKey.values()].slice(0, 10);
}

function compactIntentKeys(conversation = {}) {
  return unique(array(conversation?.advisors?.intent_candidates).map((item) => item?.key)).slice(0, 12);
}

function needSignature(need = {}) {
  return `${clean(need.topic)}|${clean(need.status)}|${unique(need.catalog_keys).join(",")}`;
}

function compactNeed(need = {}) {
  return {
    topic: scrubText(need.topic, 100),
    status: clean(need.status) || "pending_answer",
    catalog_keys: unique(need.catalog_keys).slice(0, 6),
    media_explicit: Boolean(need.media_explicit),
  };
}

function compactRequestPlan({ conversation = {}, knowledgeAdvisors = {}, unresolvedNeeds = [], productThreads = [] } = {}, profile = PROFILES[0]) {
  const needs = [];
  const seenNeeds = new Set();
  for (const source of array(unresolvedNeeds)) {
    const compacted = compactNeed(source);
    const signature = needSignature(compacted);
    if (!compacted.topic || seenNeeds.has(signature)) continue;
    seenNeeds.add(signature);
    needs.push(compacted);
  }

  const products = compactProductCandidates(knowledgeAdvisors, conversation);
  const byThread = new Map();
  for (const source of array(productThreads)) {
    const groupKey = clean(source?.group_key) || clean(source?.thread_id).replace(/^product:/u, "");
    if (!groupKey) continue;
    const catalogKeys = unique(source?.catalog_keys).slice(0, 8);
    const relatedNeeds = needs.filter((need) => need.catalog_keys.some((key) => catalogKeys.includes(key)));
    byThread.set(groupKey, {
      group_key: groupKey,
      label: scrubText(source?.label, 100) || groupKey,
      state: clean(source?.state) || (relatedNeeds.some((need) => need.status === "pending_media") ? "pending_media" : "pending_answer"),
      catalog_keys: catalogKeys,
      topics: unique([
        ...array(source?.source_topics),
        ...relatedNeeds.map((need) => need.topic),
      ]).slice(0, 8),
      media_explicit: Boolean(source?.media_explicit || relatedNeeds.some((need) => need.media_explicit)),
    });
  }

  for (const product of products) {
    const alreadyRepresented = [...byThread.values()].some((thread) =>
      thread.group_key === product.product_key || thread.catalog_keys.includes(product.product_key)
    );
    if (alreadyRepresented) continue;
    byThread.set(`candidate:${product.product_key}`, {
      group_key: product.product_key,
      label: product.label,
      state: "pending_answer",
      catalog_keys: [product.product_key],
      topics: [],
      media_explicit: false,
      confidence: product.confidence,
    });
  }

  const representedKeys = new Set([...byThread.values()].flatMap((thread) => thread.catalog_keys));
  const globalNeeds = needs.filter((need) => !need.catalog_keys.length || !need.catalog_keys.some((key) => representedKeys.has(key)));
  return {
    intent_keys: compactIntentKeys(conversation),
    threads: [...byThread.values()].slice(0, profile.threadLimit),
    global_needs: globalNeeds.slice(0, 6),
  };
}

function compactDocuments(documents = [], profile = PROFILES[0]) {
  let remaining = profile.documentTextChars;
  const selected = [];
  for (const source of array(documents).slice(0, profile.documentLimit)) {
    const allowed = Math.max(0, Math.min(profile.perDocumentChars, remaining));
    if (!allowed) break;
    const excerpt = scrubText(source?.content, allowed);
    remaining -= excerpt.length;
    if (!excerpt) continue;
    selected.push({
      document_key: clean(source?.document_key) || null,
      title: scrubText(source?.title, 140) || null,
      excerpt,
      relevance_score: Number(source?.relevance_score || 0),
    });
  }
  return selected;
}

function compactCatalog(catalog = [], profile = PROFILES[0]) {
  const seen = new Set();
  const selected = [];
  for (const source of array(catalog)) {
    const key = clean(source?.catalog_key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push({
      catalog_key: key,
      display_name: scrubText(source?.display_name, 120) || key,
      parent_key: clean(source?.parent_key) || null,
      root_key: clean(source?.root_key) || key,
      aliases: unique(source?.aliases).slice(0, profile.aliasLimit),
      has_media: Number(source?.asset_count || 0) > 0,
      asset_count: Math.max(0, Number(source?.asset_count || 0)),
    });
    if (selected.length >= profile.catalogLimit) break;
  }
  return selected;
}

function compactMappings(mappings = []) {
  const seen = new Set();
  const selected = [];
  for (const source of array(mappings)) {
    const catalogKeys = unique(source?.catalog_keys).slice(0, 8);
    const fallbackKeys = unique(source?.fallback_catalog_keys).slice(0, 8);
    const signature = `${catalogKeys.join(",")}|${fallbackKeys.join(",")}`;
    if ((!catalogKeys.length && !fallbackKeys.length) || seen.has(signature)) continue;
    seen.add(signature);
    selected.push({
      catalog_keys: catalogKeys,
      fallback_catalog_keys: fallbackKeys,
      confidence: Math.max(0, Math.min(1, Number(source?.confidence || 0))),
    });
    if (selected.length >= 3) break;
  }
  return selected;
}

function compactGrounding(knowledgeAdvisors = {}, profile = PROFILES[0]) {
  return {
    documents: compactDocuments(knowledgeAdvisors.documents, profile),
    catalog: compactCatalog(knowledgeAdvisors.catalog, profile),
    mappings: compactMappings(knowledgeAdvisors.ad_mappings),
  };
}

function buildCandidate(validationInput = {}, profile = PROFILES[0]) {
  const conversation = validationInput?.conversation || {};
  const customer = validationInput?.customer || {};
  const state = validationInput?.state || {};
  const knowledgeAdvisors = validationInput?.knowledge_advisors || {};
  return {
    architecture: validationInput?.architecture || "v10_ai_hard_commerce_integrity",
    authority: {
      ai_proposes_business_decision: true,
      hard_commerce_policies_are_mandatory: true,
      product_scopes_must_not_be_mixed: true,
      validators_may_replace_unsafe_output: true,
    },
    conversation: {
      messages: compactMessages(conversation.messages, profile),
      safety: {
        opt_out: Boolean(conversation?.safety?.opt_out),
        human_takeover: Boolean(conversation?.safety?.human_takeover),
        verified_page_reply_after_latest_customer: Boolean(conversation?.safety?.verified_page_reply_after_latest_customer),
      },
    },
    customer: compactCustomer(customer, state),
    state: compactState(state, customer),
    request_plan: compactRequestPlan({
      conversation,
      knowledgeAdvisors,
      unresolvedNeeds: validationInput?.unresolved_needs,
      productThreads: validationInput?.product_threads,
    }, profile),
    grounding: compactGrounding(knowledgeAdvisors, profile),
  };
}

function forbiddenPath(value, path = "root") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = forbiddenPath(value[index], `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_PROVIDER_KEYS.has(String(key).toLowerCase())) return `${path}.${key}`;
    const nested = forbiddenPath(nestedValue, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

export function assertProviderModelInputSafe(input = {}) {
  const path = forbiddenPath(input);
  if (path) throw new Error(`V10_PROVIDER_INPUT_FORBIDDEN_FIELD:${path}`);
  const serialized = JSON.stringify(input);
  if (/https?:\/\//iu.test(serialized)) throw new Error("V10_PROVIDER_INPUT_EXTERNAL_URL_FORBIDDEN");
  return true;
}

export function compileProviderModelInput(validationInput = {}, options = {}) {
  const budgetChars = Math.max(4_000, Math.min(20_000, Number(options.budgetChars || DEFAULT_BUDGET_CHARS)));
  const sourceChars = JSON.stringify(validationInput).length;
  for (const profile of PROFILES) {
    const input = buildCandidate(validationInput, profile);
    assertProviderModelInputSafe(input);
    const compiledChars = JSON.stringify(input).length;
    if (compiledChars <= budgetChars) {
      return {
        input,
        profile: {
          compiler_version: "v10_model_input_compiler_v1_dedup_no_raw",
          profile: profile.name,
          budget_chars: budgetChars,
          source_chars: sourceChars,
          compiled_chars: compiledChars,
          reduction_chars: Math.max(0, sourceChars - compiledChars),
          reduction_ratio: sourceChars > 0 ? Number((1 - compiledChars / sourceChars).toFixed(4)) : 0,
          raw_payload_removed: true,
          referral_removed: true,
          media_urls_removed: true,
          duplicated_context_consolidated: true,
        },
      };
    }
  }
  throw new Error(`V10_MODEL_INPUT_BUDGET_EXCEEDED:${budgetChars}`);
}

export const modelInputCompilerVersion = "v10_model_input_compiler_v1_dedup_no_raw";
export const providerModelInputBudgetChars = DEFAULT_BUDGET_CHARS;
