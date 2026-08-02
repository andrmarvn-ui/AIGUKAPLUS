import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_SEMANTIC_PRODUCT_LOCK_V1";

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
    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_direct_semantic_lock_v4";');
    source += `\n// ${MARKER}: ordered customer needs and hard semantic product lock installed.\n`;
    fs.writeFileSync(file, source);
    syntaxCheck(file);
  }
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

    // Pace and cool down Gemini around the single provider call. The existing outer
    // catch remains untouched, so this survives earlier release patches that alter
    // provider error recording.
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

    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_ai_semantic_lock_v12";');
    source += `\n// ${MARKER}: deterministic routine decisions, Gemini Free pacing and cross-catalog rejection installed.\n`;
    fs.writeFileSync(file, source);
    syntaxCheck(file);
  }
}

console.log(`[AIGUKA V9] ${MARKER} installed: ordered needs, exact catalog lock and Gemini Free circuit breaker`);
