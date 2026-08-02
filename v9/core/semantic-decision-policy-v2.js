import {
  semanticDeterministicDecision as baseSemanticDecision,
  enforceSemanticProductLock as baseEnforceLock,
  semanticBeforeGeminiCall,
  semanticAfterGeminiCall,
  semanticGeminiState,
} from "./semantic-decision-policy.js";
import { normalizeVietnamese } from "./semantic-conversation-intelligence.js";

function tileProjectSignals(snapshot = {}) {
  const turn = snapshot.turn || {};
  const signals = turn.salesSignals || {};
  const allowed = Array.isArray(signals.allowedProducts) ? signals.allowedProducts : [];
  const normalized = normalizeVietnamese(turn.combinedText || "");
  const isTileProject = allowed.length === 1
    && allowed[0] === "gach_da_op_lat"
    && /\b(op|lat|gach)\b/.test(normalized)
    && /\b([0-9]+ ?m2|[0-9]+ ?m|[0-9]+ v s|wc|nha ve sinh|phong ve sinh|phong bep|nha bep|pong bep)\b/.test(normalized);

  // Tile project enrichment is only valid when tile is the sole active request.
  // A customer asking for tiles together with bathroom/kitchen products must keep
  // every group in the request plan.
  if (!isTileProject) return snapshot;
  return {
    ...snapshot,
    turn: {
      ...turn,
      salesSignals: {
        ...signals,
        products: ["gach_da_op_lat"],
        activeProducts: ["gach_da_op_lat"],
        allowedProducts: ["gach_da_op_lat"],
        primaryProduct: "gach_da_op_lat",
        productLock: "hard",
      },
    },
  };
}

export function semanticDeterministicDecision(snapshot = {}, selectedKnowledge = {}) {
  return baseSemanticDecision(tileProjectSignals(snapshot), selectedKnowledge);
}

export function enforceSemanticProductLock(rawDecision, snapshot = {}) {
  return baseEnforceLock(rawDecision, tileProjectSignals(snapshot));
}

export { semanticBeforeGeminiCall, semanticAfterGeminiCall, semanticGeminiState };
