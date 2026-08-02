import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_SEMANTIC_PRODUCT_LOCK_V1";
const MULTI_MARKER = "AIGUKA_V9_MULTI_PRODUCT_REQUEST_PLAN_V1";

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`SEMANTIC_LOCK_SYNTAX_${file}:${result.stderr || result.stdout}`);
}

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(oldValue, newValue);
}

{
  const file = "v9-direct-core-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = replaceOnce(
      source,
      'import { buildConversationTurn } from "./v9/core/conversation-intelligence.js";',
      'import { buildConversationTurn } from "./v9/core/semantic-conversation-intelligence-v2.js";',
      "SEMANTIC_DIRECT_IMPORT",
    );
  }
  source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_direct_multi_product_plan_v5";');
  if (!source.includes(MARKER)) source += `\n// ${MARKER}: semantic product lock installed.\n`;
  if (!source.includes(MULTI_MARKER)) source += `// ${MULTI_MARKER}: all active customer product groups are preserved in requestPlan.\n`;
  fs.writeFileSync(file, source);
  syntaxCheck(file);
}

{
  const file = "v9-ai-shadow-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    const semanticImport = 'import { semanticDeterministicDecision, enforceSemanticProductLock, semanticBeforeGeminiCall, semanticAfterGeminiCall } from "./v9/core/semantic-decision-policy-v2.js";';
    const importAnchor = 'import { selectKnowledgeContext } from "./v9/core/knowledge-selector-v2.js";';
    source = replaceOnce(
      source,
      importAnchor,
      `${importAnchor}\n${semanticImport}`,
      "SEMANTIC_AI_IMPORT",
    );

    source = replaceOnce(
      source,
      '      const result = await providerCall(ai, modelInput);',
      `      const semanticProviderKey = String(ai.provider_key || ai.provider_type || "").toLowerCase();
      if (semanticProviderKey.includes("gemini")) await semanticBeforeGeminiCall();
      let result;
      try {
        result = await providerCall(ai, modelInput);
        if (semanticProviderKey.includes("gemini")) semanticAfterGeminiCall(200);
      } catch (semanticProviderError) {
        const semanticErrorText = String(semanticProviderError?.message || semanticProviderError);
        if (semanticProviderKey.includes("gemini") && /(?:^|\\D)429(?:\\D|$)|resource exhausted|quota/i.test(semanticErrorText)) {
          semanticAfterGeminiCall(429);
        }
        throw semanticProviderError;
      }`,
      "SEMANTIC_PROVIDER_PACING",
    );

    source = replaceOnce(
      source,
      '  let rawDecision = null;\n  let usedProvider = null;',
      '  let rawDecision = semanticDeterministicDecision(snapshot, selectedKnowledge);\n  let usedProvider = rawDecision ? "semantic_rule" : null;',
      "SEMANTIC_DETERMINISTIC_FIRST",
    );

    source = replaceOnce(
      source,
      '  for (const ai of providerRows) {',
      '  for (const ai of rawDecision ? [] : providerRows) {',
      "SEMANTIC_PROVIDER_BYPASS",
    );

    const noDropValidation = `    if (rawDecision?.action === "contact_captured" && !contactNewlyCaptured) {
      rawDecision = fallbackDecision(snapshot, selectedKnowledge);
    }
    let decision = validateDecision(rawDecision, { contactCaptured: contactKnown });`;
    const semanticValidation = `    if (rawDecision?.action === "contact_captured" && !contactNewlyCaptured) {
      rawDecision = fallbackDecision(snapshot, selectedKnowledge);
    }
    rawDecision = enforceSemanticProductLock(rawDecision, snapshot);
    let decision = validateDecision(rawDecision, { contactCaptured: contactKnown });`;
    source = replaceOnce(
      source,
      noDropValidation,
      semanticValidation,
      "SEMANTIC_VALIDATE_LOCK",
    );
  }

  source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_ai_multi_product_plan_v13";');
  if (!source.includes(MARKER)) source += `\n// ${MARKER}: deterministic semantic lock and Gemini pacing installed.\n`;
  if (!source.includes(MULTI_MARKER)) source += `// ${MULTI_MARKER}: AI may write wording but cannot collapse or replace active product groups.\n`;
  fs.writeFileSync(file, source);
  syntaxCheck(file);
}

console.log(`[AIGUKA V9] ${MULTI_MARKER} installed: complete multi-product requestPlan, balanced catalogs and Gemini Free circuit breaker`);
