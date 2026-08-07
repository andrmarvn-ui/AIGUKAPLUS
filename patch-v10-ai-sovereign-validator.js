import fs from "node:fs";

const AI_FILE = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_AI_SOVEREIGN_VALIDATOR_V1";

if (!fs.existsSync(AI_FILE)) throw new Error("V10_SOVEREIGN_VALIDATOR_WORKER_MISSING");
let source = fs.readFileSync(AI_FILE, "utf8");

if (!source.includes(MARK)) {
  const importAnchor = 'import { buildKnowledgeAdvisors } from "./v10/core/knowledge-advisor.js";';
  const needImport = 'import { deriveUnresolvedNeeds } from "./v10/core/unresolved-needs.js";';
  if (!source.includes(importAnchor)) throw new Error("V10_SOVEREIGN_VALIDATOR_IMPORT_ANCHOR_MISSING");
  if (!source.includes(needImport)) source = source.replace(importAnchor, `${importAnchor}\n${needImport}`);

  for (const token of [
    "enrichConversationWithDeliveredReplies",
    "persistProviderRuntimeState",
    "continuityContactCooldown",
    "hardContactRefusalInTurn",
    "exactCatalogContext",
    "unsupportedPriceReply",
    "unsupportedStockClaim",
    "unsupportedTechnicalFacts",
  ]) {
    if (!source.includes(token)) throw new Error(`V10_SOVEREIGN_VALIDATOR_DEPENDENCY_MISSING:${token}`);
  }

  const start = source.indexOf("async function processOne(row, availableProviders, knowledgeSnapshot) {");
  const end = source.indexOf("function providerHealthSnapshot()", start);
  if (start < 0 || end < 0) throw new Error("V10_SOVEREIGN_VALIDATOR_PROCESS_TARGET_MISSING");

  const replacement = String.raw`
function sovereignRecentPageReply(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role !== "customer" && String(message.text || "").trim()) return message;
  }
  return null;
}

function sovereignCustomerAskedRepeat(modelInput) {
  const text = qualityNormalize(typeof continuityCurrentCustomerCluster === "function"
    ? continuityCurrentCustomerCluster(modelInput)
    : currentCustomerClusterText(modelInput));
  return /\b(gui lai|nhac lai|noi lai|lap lai|gui them|mau khac|xem lai)\b/.test(text);
}

function sovereignReplyPromisesMedia(value) {
  const text = qualityNormalize(value);
  return /\b(gui|dua|cho xem).{0,32}\b(mau|anh|hinh|catalog)\b/.test(text);
}

function sovereignCatalogIsAncestor(ancestorKey, descendantKey, allowed) {
  if (!ancestorKey || !descendantKey) return false;
  let cursor = String(descendantKey);
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    if (cursor === String(ancestorKey)) return true;
    visited.add(cursor);
    cursor = String(allowed.get(cursor)?.parent_key || "").trim();
  }
  return false;
}

function sovereignCatalogCovers(selectedKey, requiredKey, allowed) {
  if (!selectedKey || !requiredKey) return false;
  if (selectedKey === requiredKey) return true;
  return sovereignCatalogIsAncestor(selectedKey, requiredKey, allowed)
    || sovereignCatalogIsAncestor(requiredKey, selectedKey, allowed);
}

function sovereignDecisionViolations(decision, modelInput) {
  const violations = [];
  const reply = String(decision?.final_reply || "").trim();
  const replyNorm = qualityNormalize(reply);
  const catalogContext = exactCatalogContext(modelInput);
  const allowed = catalogContext.allowed;
  const slide = catalogContext.slide;
  const selected = Array.isArray(decision?.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  const known = contactIsKnown(modelInput) || (typeof currentTurnContainsPhone === "function" && currentTurnContainsPhone(modelInput));
  const asksContact = Boolean(decision?.should_request_contact) || contactRequestDetected(reply);
  const cooldown = typeof continuityContactCooldown === "function"
    ? continuityContactCooldown(modelInput)
    : { active: false, customerMessagesSince: 999 };

  if (DECISION_LEAK_PATTERN.test([reply, decision?.decision_reason, decision?.contact_benefit].join(" "))) {
    violations.push("INTERNAL_TEXT_LEAK");
  }
  if (DECISION_GIBBERISH_PATTERN.test(reply) || languageLooksCorrupted(reply)) {
    violations.push("CORRUPTED_LANGUAGE");
  }
  if (unsupportedPriceReply(reply, modelInput)) violations.push("UNVERIFIED_PRICE_CLAIM");
  if (unsupportedStockClaim(reply, modelInput)) violations.push("UNVERIFIED_STOCK_CLAIM");
  if (unsupportedTechnicalFacts(reply, modelInput)) violations.push("UNVERIFIED_TECHNICAL_CLAIM");

  if (known && decision?.contact_state !== "known") violations.push("CONTACT_ALREADY_KNOWN_STATE_REQUIRED");
  if (known && asksContact) violations.push("CONTACT_ALREADY_KNOWN_DO_NOT_REQUEST_AGAIN");
  if (!known && cooldown.active && asksContact) violations.push("CONTACT_COOLDOWN_" + cooldown.customerMessagesSince + "_CUSTOMER_MESSAGES");
  if (!known && hardContactRefusalInTurn(modelInput) && asksContact) violations.push("CUSTOMER_REFUSED_CONTACT");
  if (decision?.should_request_contact && !contactRequestDetected(reply)) violations.push("CONTACT_FLAG_WITHOUT_CONTACT_SENTENCE");
  if (!decision?.should_request_contact && contactRequestDetected(reply)) violations.push("CONTACT_SENTENCE_WITHOUT_CONTACT_FLAG");

  const invalidKeys = selected.filter((key) => !allowed.has(String(key)));
  if (invalidKeys.length) violations.push("UNKNOWN_CATALOG_KEYS:" + invalidKeys.join(","));
  if (decision?.needs_slides || decision?.action === "reply_with_slides") {
    if (!selected.length) violations.push("MEDIA_REQUEST_WITHOUT_CATALOG");
    const noMediaKeys = selected.filter((key) => !slide.has(String(key)));
    if (noMediaKeys.length) violations.push("CATALOG_WITHOUT_PUBLISHED_MEDIA:" + noMediaKeys.join(","));
  }
  if (sovereignReplyPromisesMedia(reply) && !decision?.needs_slides) violations.push("REPLY_PROMISES_MEDIA_BUT_MEDIA_DISABLED");

  const unresolved = Array.isArray(modelInput?.unresolved_needs) ? modelInput.unresolved_needs : [];
  const pendingMedia = unresolved.filter((need) => need?.status === "pending_media" && Array.isArray(need.catalog_keys) && need.catalog_keys.length);
  if (pendingMedia.length && !(decision?.needs_slides && decision?.action === "reply_with_slides")) {
    violations.push("UNRESOLVED_MEDIA_NEEDS_NOT_SCHEDULED");
  }
  for (const need of pendingMedia) {
    const covered = need.catalog_keys.some((requiredKey) => selected.some((selectedKey) => sovereignCatalogCovers(String(selectedKey), String(requiredKey), allowed)));
    if (!covered) violations.push("UNRESOLVED_PRODUCT_DROPPED:" + (need.topic || need.catalog_keys.join(",")));
  }

  const prior = sovereignRecentPageReply(modelInput);
  if (prior && !sovereignCustomerAskedRepeat(modelInput)) {
    const previous = qualityNormalize(prior.text || "");
    if (previous && replyNorm && previous === replyNorm) violations.push("EXACT_DUPLICATE_RECENT_PAGE_REPLY");
  }

  return [...new Set(violations)];
}

function sovereignValidationError(error) {
  const message = String(error?.message || error || "V10_DECISION_INVALID").replace(/\s+/g, " ").trim();
  return message.slice(0, 300);
}

async function sovereignProviderDecision(provider, modelInput) {
  let feedback = [];
  let firstRawDecision = null;
  let finalRawDecision = null;
  let lastAttempt = null;

  for (let round = 0; round < 2; round += 1) {
    const attemptInput = round === 0
      ? modelInput
      : {
          ...modelInput,
          validation_feedback: {
            validator: "v10_sovereign_feedback_v1",
            instruction: "Correct these validation failures yourself. Preserve all unresolved customer needs and do not repeat the rejected reply.",
            violations: feedback,
          },
        };

    const attempt = await providerCall(provider, attemptInput);
    lastAttempt = attempt;
    if (!firstRawDecision) firstRawDecision = structuredClone(attempt.decision);
    finalRawDecision = structuredClone(attempt.decision);

    let decision = null;
    let violations = [];
    try {
      decision = validateDecision(attempt.decision);
      violations = sovereignDecisionViolations(decision, attemptInput);
    } catch (error) {
      violations = [sovereignValidationError(error)];
    }

    if (!violations.length) {
      return {
        ...attempt,
        decision,
        rawDecision: firstRawDecision,
        finalRawDecision,
        validationFeedbackRounds: round,
        validationFeedback: feedback,
      };
    }

    feedback = violations;
    if (round === 0) {
      const interval = Math.max(250, Math.min(5000, providerMinIntervalMs(provider)));
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  const error = new Error("V10_DECISION_INVALID:" + feedback.join("|"));
  error.code = "decision_invalid";
  error.provider = providerKey(provider);
  error.responseId = lastAttempt?.responseId || null;
  throw error;
}

async function processOne(row, availableProviders, knowledgeSnapshot) {
  const claimed = await claim(row);
  if (!claimed) return { processed: 0, retried: 0, reviewRequired: 0, providerErrors: [] };
  const baseConversation = claimed.input_snapshot?.conversation || {};
  const conversation = await enrichConversationWithDeliveredReplies(claimed, baseConversation);
  const knowledgeAdvisors = buildKnowledgeAdvisors(knowledgeSnapshot, conversation, { maxDocuments: 8, maxCatalog: 20, maxAssetsPerCatalog: 5 });
  const unresolvedNeeds = deriveUnresolvedNeeds(conversation, knowledgeAdvisors);
  const modelInput = {
    architecture: ARCHITECTURE,
    authority: {
      ai_is_sole_business_decision_maker: true,
      rules_mapping_catalog_locks_are_advisory_only: true,
      validators_may_reject_but_never_rewrite_business_output: true,
      validation_feedback_returns_to_ai: true,
      hard_safety_already_applied: true,
    },
    conversation,
    customer: claimed.input_snapshot?.customer || {},
    state: claimed.input_snapshot?.state || {},
    unresolved_needs: unresolvedNeeds,
    knowledge_advisors: knowledgeAdvisors,
  };
  const modelInputChars = JSON.stringify(modelInput).length;
  const providerErrors = [];
  const classifications = [];
  const startedAt = Date.now();

  try {
    let result = null;
    const orderedProviders = providerOrder(availableProviders, Date.now(), modelInputChars);
    for (const provider of orderedProviders) {
      const callStartedAt = Date.now();
      try {
        result = await sovereignProviderDecision(provider, modelInput);
        recordProviderSuccess(provider, Date.now() - callStartedAt, modelInputChars);
        await persistProviderRuntimeState(provider, "ready");
        providerCache.lastProviderKey = result.provider;
        break;
      } catch (error) {
        const classification = classifyProviderError(provider, error);
        recordProviderFailure(provider, classification, error, modelInputChars);
        await persistProviderRuntimeState(provider, "cooldown", classification, error);
        classifications.push(classification);
        providerErrors.push(providerKey(provider) + ":" + classification + ":" + String(error?.message || error).slice(0, 260));
      }
    }
    if (!result) throw new Error(providerErrors.join(" | ") || "V10_ALL_AVAILABLE_PROVIDERS_FAILED");

    const decision = result.decision;
    await core("v9_decisions?id=eq." + claimed.id + "&status=eq.shadow_ai_processing", {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "shadow_ai_completed",
        action: decision.action,
        confidence: decision.confidence,
        knowledge_version: String(knowledgeSnapshot.version_no) + ":" + String(knowledgeSnapshot.checksum),
        latency_ms: Date.now() - startedAt,
        output: {
          ...decision,
          should_send: decision.action !== "suppress",
          transport_locked: true,
          provider_key: result.provider,
          model_input_chars: modelInputChars,
          model: result.model,
          response_id: result.responseId,
          provider_errors: providerErrors,
          processing_attempts: processingAttempts(claimed),
          decision_errors: decisionErrors(claimed),
          architecture: ARCHITECTURE,
          advisors_were_non_binding: true,
          validator_version: "v10_sovereign_feedback_v1",
          validator_rewrites_business_output: false,
          validator_feedback_rounds: result.validationFeedbackRounds || 0,
          validator_feedback: result.validationFeedback || [],
          raw_ai_decision: result.rawDecision || null,
          final_raw_ai_decision: result.finalRawDecision || null,
          unresolved_needs: unresolvedNeeds,
          legacy_smart_reply_repair_applied: false,
          knowledge_snapshot: { id: knowledgeSnapshot.id, version_no: knowledgeSnapshot.version_no, checksum: knowledgeSnapshot.checksum },
        },
        updated_at: new Date().toISOString(),
      },
    });
    return { processed: 1, retried: 0, reviewRequired: 0, providerErrors };
  } catch (error) {
    const transientOnly = classifications.length > 0 && classifications.every((value) => ["rate_limit", "no_credit", "transient", "provider_error"].includes(value));
    const classification = classifications.includes("decision_error") ? "decision_error" : (classifications[0] || "provider_error");
    const next = providerAvailability(providerCache.rows, Date.now()).nextAvailableAt;
    const outcome = await retryDecision(claimed, error, {
      classification,
      consumeAttempt: !transientOnly,
      retryAt: next,
    });
    return {
      processed: 0,
      retried: outcome === "retry" ? 1 : 0,
      reviewRequired: outcome === "review_required" ? 1 : 0,
      providerErrors,
    };
  }
}

// ${MARK}

`;

  source = source.slice(0, start) + replacement + source.slice(end);
  source = source.replace(
    'const VERSION = "v10_ai_quality_guard_v17_smart_sales_advisory";',
    'const VERSION = "v10_ai_sovereign_validator_v18";',
  );
  if (!source.includes(MARK) || !source.includes("validators_may_reject_but_never_rewrite_business_output") || !source.includes("raw_ai_decision")) {
    throw new Error("V10_SOVEREIGN_VALIDATOR_INSTALL_FAILED");
  }
  fs.writeFileSync(AI_FILE, source, "utf8");
}

console.log("[AIGUKA V10] sovereign validator enabled: AI owns business output; validators reject and return feedback instead of rewriting replies/catalog/actions");
