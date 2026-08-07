import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE = "AIGUKA_V10_AI_SOVEREIGN_VALIDATOR_V5";

process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS ||= "5000";
process.env.AIGUKA_GEMINI_FREE_MIN_COOLDOWN_MS ||= "120000";
process.env.AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS ||= "300000";
process.env.AIGUKA_OPENAI_CREDIT_COOLDOWN_MS ||= "21600000";

const FILES = [
  "v10/core/advisory-engine.js",
  "v10/core/conversation-assembler.js",
  "v10/core/decision-contract.js",
  "v10/core/knowledge-advisor.js",
  "v10/core/media-obligation.js",
  "v10/core/unresolved-needs.js",
  "v9-core-fetch-router.js",
  "v10-decision-queue-janitor.js",
  "v10-direct-core-worker.js",
  "v10-ai-worker.js",
  "v10-ai-worker-final.js",
  "v10-outbound-worker.js",
  "v10-followup-worker.js",
  "v10-pancake-contact-guard-worker.js",
  "patch-v10-specific-price-contact.js",
  "patch-v10-general-product-sales-handoff.js",
  "patch-v10-general-product-sales-finalize.js",
  "patch-v10-ai-sovereign-validator.js",
  "patch-v10-outbound-sovereign-integrity.js",
  "followup-admin-v8.js",
  "followup-admin-v8-client.js",
];

function sourceOf(file) {
  if (!fs.existsSync(file)) throw new Error(`V10_RELEASE_FILE_MISSING:${file}`);
  return fs.readFileSync(file, "utf8");
}

function requireToken(file, token) {
  const source = sourceOf(file);
  if (!source.includes(token)) throw new Error(`V10_RELEASE_TOKEN_MISSING:${file}:${token}`);
}

function forbidToken(file, token) {
  const source = sourceOf(file);
  if (source.includes(token)) throw new Error(`V10_RELEASE_RETIRED_TOKEN_PRESENT:${file}:${token}`);
}

for (const file of FILES) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`V10_RELEASE_SYNTAX:${file}:${result.stderr || result.stdout}`);
}

const expectedChecksum = sourceOf("v10-ai-worker-final.sha256").trim();
const actualChecksum = crypto.createHash("sha256").update(fs.readFileSync("v10-ai-worker-final.js")).digest("hex");
if (!/^[a-f0-9]{64}$/.test(expectedChecksum) || expectedChecksum !== actualChecksum) {
  throw new Error(`V10_FINAL_AI_WORKER_CHECKSUM_MISMATCH:${expectedChecksum}:${actualChecksum}`);
}

requireToken("v10-decision-queue-janitor.js", 'const VERSION = "v10_queue_hygiene_v2";');
requireToken("v10-decision-queue-janitor.js", "V10_REHYDRATE_LEGACY_PENDING");
requireToken("v10-direct-core-worker.js", 'const VERSION = "v10_direct_ai_sovereign_v2_frontier_guard";');
requireToken("v10-direct-core-worker.js", "customer_frontier_guard: true");
requireToken("v10-direct-core-worker.js", "superseded_before_decision_save");
requireToken("v9-core-fetch-router.js", 'responsibility: "routing_only"');
requireToken("v9-core-fetch-router.js", "retired_runtime_business_patches: true");
forbidToken("v9-core-fetch-router.js", 'await import("./patch-v10-conversation-quality-v1.js")');
forbidToken("v9-core-fetch-router.js", 'await import("./patch-v10-hierarchical-knowledge-v1.js")');
forbidToken("v9-core-fetch-router.js", 'await import("./patch-v10-hierarchical-catalog-resolver-v1.js")');

requireToken("v10-ai-worker.js", 'await import("./v10-ai-worker-final.js")');
requireToken("v10-ai-worker.js", 'await import("./patch-v10-ai-sovereign-validator.js")');
requireToken("v10-ai-worker.js", "validator_authority: \"reject_and_feedback_only\"");
requireToken("v10-ai-worker.js", "validator_rewrites_business_output: false");
requireToken("v10-ai-worker.js", "unresolved_needs_enabled: true");
requireToken("v10-ai-worker.js", "recursive_catalog_advisory: true");
forbidToken("v10-ai-worker.js", "patch-v10-provider-load-balancer");
forbidToken("v10-ai-worker.js", "patch-v10-decision-integrity");

requireToken("v10-ai-worker-final.js", 'const VERSION = "v10_ai_quality_guard_v13";');
requireToken("v10-ai-worker-final.js", "providerSettings(provider).max_input_chars");
requireToken("v10-ai-worker-final.js", "AIGUKA_V10_DECISION_INTEGRITY_V10");
requireToken("v10-ai-worker-final.js", "recoverStaleProcessing");
requireToken("v10-ai-worker-final.js", "operational_fallback_enabled: false");
requireToken("v10-outbound-worker.js", 'const VERSION = "v10_outbound_safety_only_v1";');
requireToken("v10-outbound-worker.js", "AIGUKA_V10_OUTBOUND_REPLY_ORDER_V1");
requireToken("v10-outbound-worker.js", "AIGUKA_V10_MAX_MEDIA_ASSETS || 20");

// Compatibility patch files remain temporarily because the checksummed base worker still
// exposes the old source layout. The final sovereign patch replaces processOne, so these
// compatibility functions cannot rewrite delivered business output.
requireToken("patch-v10-specific-price-contact.js", "AIGUKA_V10_SPECIFIC_PRICE_CONTACT_V1");
requireToken("patch-v10-general-product-sales-handoff.js", "AIGUKA_V10_GENERAL_PRODUCT_SALES_HANDOFF_V2_SMART_REPAIR");
requireToken("patch-v10-general-product-sales-finalize.js", "AIGUKA_V10_GENERAL_PRODUCT_SALES_FINALIZED_V2_SMART_REPAIR");
requireToken("patch-v10-ai-sovereign-validator.js", "AIGUKA_V10_AI_SOVEREIGN_VALIDATOR_V1");
requireToken("patch-v10-ai-sovereign-validator.js", "validators_may_reject_but_never_rewrite_business_output");
requireToken("patch-v10-ai-sovereign-validator.js", "raw_ai_decision");
requireToken("patch-v10-outbound-sovereign-integrity.js", "AIGUKA_V10_OUTBOUND_SOVEREIGN_INTEGRITY_V1");
requireToken("patch-v10-outbound-sovereign-integrity.js", "EXACT_DUPLICATE_RECENT_REPLY");

requireToken("v10/core/advisory-engine.js", "advisory_only: true");
requireToken("v10/core/conversation-assembler.js", "latest_message_is_not_authoritative");
requireToken("v10/core/conversation-assembler.js", "ai_is_sole_business_decision_maker");
requireToken("v10/core/decision-contract.js", "validation_feedback");
requireToken("v10/core/decision-contract.js", "V10_DECISION_SLIDE_FLAG_MISMATCH");
requireToken("v10/core/decision-contract.js", "V10_DECISION_CONTACT_STATE_MISMATCH");
forbidToken("v10/core/decision-contract.js", "contactRequestSentence");
requireToken("v10/core/knowledge-advisor.js", "recursive_assets: true");
requireToken("v10/core/knowledge-advisor.js", "slide_catalog");
requireToken("v10/core/unresolved-needs.js", 'export const unresolvedNeedsVersion = "v10_unresolved_needs_v1";');
requireToken("v10/core/media-obligation.js", 'export const mediaObligationVersion = "v10_media_obligation_v3_unresolved_until_media";');

requireToken("v10-followup-worker.js", 'const VERSION = "v10_followup_v8_event_v3";');
requireToken("v10-followup-worker.js", "preserveMessageLayout");
requireToken("v10-followup-worker.js", "PANCAKE_CONTACT_TAG_FOUND");
requireToken("v10-pancake-contact-guard-worker.js", "pages.fm/api/public_api/v2/pages");
requireToken("followup-admin-v8.js", "installFollowupAdminV8");
requireToken("followup-admin-v8-client.js", "Lưu Event này");

globalThis.__AIGUKA_V10_LIVE_RELEASE__ = RELEASE;
console.log(`[AIGUKA V10] ${RELEASE} verified: AI owns business decisions; validators reject and return feedback, unresolved needs persist, Core saves only the latest customer frontier, catalog parents aggregate children, and outbound duplicate/media-scope integrity is active`);
