import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE = "AIGUKA_V10_HARD_COMMERCE_COMMENT_PRIVATE_V27";

process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS ||= "60000";
process.env.AIGUKA_GEMINI_FREE_MIN_COOLDOWN_MS ||= "120000";
process.env.AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS ||= "300000";
process.env.AIGUKA_OPENAI_CREDIT_COOLDOWN_MS ||= "21600000";

const ACTIVE_FILES = [
  "start.js",
  "v10-ai-worker.js",
  "v10-ai-worker-final.js",
  "v10-direct-core-worker.js",
  "v10-comment-private-reply-recovery-worker.js",
  "v10-outbound-worker.js",
  "v10-followup-worker.js",
  "v10-support-operational-fallback-worker.js",
  "v10-decision-queue-janitor.js",
  "v10-pancake-contact-guard-worker.js",
  "v10/core/constitution.js",
  "v10/core/message-gateway.js",
  "v10/core/conversation-assembler.js",
  "v10/core/decision-contract.js",
  "v10/core/commerce-integrity.js",
  "v10/core/knowledge-advisor.js",
  "v10/core/media-obligation.js",
  "v10/core/product-threads.js",
  "v10/core/outbound-priority.js",
  "v10/core/pancake-conversation-snapshot.js",
  "v10/core/page-reply-evidence.js",
  "v10/core/carousel-media.js",
  "v10/core/media-dedupe.js",
  "v10/core/support-operational-fallback.js",
  "v9-legacy-inbox-bridge.js",
  "v9/core/legacy-inbox-normalizer.js",
  "v9/core/comment-private-reply.js",
  "v9/core/actor-resolver.js",
  "v9-core-fetch-router.js",
];

function sourceOf(file) {
  if (!fs.existsSync(file)) throw new Error(`V10_RELEASE_FILE_MISSING:${file}`);
  return fs.readFileSync(file, "utf8");
}

function requireToken(file, token) {
  if (!sourceOf(file).includes(token)) throw new Error(`V10_RELEASE_TOKEN_MISSING:${file}:${token}`);
}

for (const file of ACTIVE_FILES) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`V10_RELEASE_SYNTAX:${file}:${result.stderr || result.stdout}`);
}

const aiBytes = fs.readFileSync("v10-ai-worker-final.js");
const expectedAiChecksum = sourceOf("v10-ai-worker-final.sha256").trim();
const actualAiChecksum = crypto.createHash("sha256").update(aiBytes).digest("hex");
if (!/^[a-f0-9]{64}$/.test(expectedAiChecksum) || expectedAiChecksum !== actualAiChecksum) {
  throw new Error(`V10_FINAL_AI_WORKER_CHECKSUM_MISMATCH:${expectedAiChecksum}:${actualAiChecksum}`);
}

for (const entrypoint of ["start.js", "v10-ai-worker.js", "v10-server-release.js"]) {
  const source = sourceOf(entrypoint);
  if (/import\([^\n]*patch-v10-|safeImport\([^\n]*patch-v10-/u.test(source)) {
    throw new Error(`V10_RUNTIME_SOURCE_PATCH_IMPORT:${entrypoint}`);
  }
}

for (const worker of ["v10-outbound-worker.js", "v10-followup-worker.js"]) {
  const source = sourceOf(worker);
  if (/graph\.facebook\.com|["'`]me\/messages/u.test(source)) {
    throw new Error(`V10_DIRECT_META_TRANSPORT_OUTSIDE_GATEWAY:${worker}`);
  }
}

requireToken("v10/core/constitution.js", "v10_constitution_v1_single_authority");
requireToken("v10/core/constitution.js", "AICAKE_PRIMARY_AIGUKA_ASSIST");
requireToken("v10/core/message-gateway.js", "v10_claim_message_dispatch");
requireToken("v10/core/message-gateway.js", "v10_release_message_dispatch");
requireToken("v10/core/message-gateway.js", "recipient: { comment_id: normalizedCommentId }");
requireToken("v10-outbound-worker.js", 'const VERSION = "v10_outbound_single_gateway_v18_comment_idempotency";');
requireToken("v10-outbound-worker.js", '"meta_comment_private_reply"');
requireToken("v10-outbound-worker.js", "public_comment_reply_forbidden");
requireToken("v10-outbound-worker.js", "COMMENT_PRIVATE_REPLY_ALREADY_EXISTS");
requireToken("v10/core/page-reply-evidence.js", "v10_page_reply_evidence_v1_persist_and_resolve_sla");
requireToken("v10-support-operational-fallback-worker.js", 'const VERSION = "v10_support_failover_v4_recover_customer_media_reask";');
requireToken("v10-followup-worker.js", 'const VERSION = "v10_followup_single_gateway_v5";');
requireToken("v10-followup-worker.js", "recoverStaleProcessing");
requireToken("v10-ai-worker-final.js", 'const VERSION = "v10_ai_commerce_integrity_v22";');
requireToken("v10-ai-worker-final.js", "recoverStaleProcessing");
requireToken("v10-ai-worker-final.js", "operational_fallback_enabled: false");
requireToken("v10-ai-worker-final.js", "mandatory_deterministic_enforcement");
requireToken("v10-ai-worker-final.js", "PROVIDER_BYPASSED_FOR_DETERMINISTIC_COMMERCE");
requireToken("v10/core/commerce-integrity.js", "SPECIFIC_PRODUCT_INFORMATION_REQUIRES_CONTACT_HANDOFF");
requireToken("v10/core/commerce-integrity.js", "deterministic_group_price_range");
requireToken("v10/core/commerce-integrity.js", "KNOWN_PROVIDER_LANGUAGE_CORRUPTION");
requireToken("v10-direct-core-worker.js", "superseded_before_decision_save");
requireToken("v10-direct-core-worker.js", 'architecture: "v10_ai_hard_commerce_integrity"');
requireToken("v10-direct-core-worker.js", 'const VERSION = "v10_direct_hard_commerce_v5_terminal_job_settlement";');
requireToken("v10-direct-core-worker.js", "terminal_decision_already_final");
requireToken("v10-decision-queue-janitor.js", 'const VERSION = "v10_queue_hygiene_v4_hard_commerce_aware";');
requireToken("v10-decision-queue-janitor.js", '"v10_ai_hard_commerce_integrity"');
requireToken("v9-core-fetch-router.js", 'responsibility: "routing_only"');
requireToken("v10/core/conversation-assembler.js", "structured_choice_same_menu_latest_replaces_previous");
requireToken("v10/core/media-obligation.js", 'mediaObligationVersion = "v10_media_obligation_v6_continuation_fallback"');
requireToken("v10/core/media-dedupe.js", "v10_media_scope_dedupe_v2_customer_reask");
requireToken("v9/core/legacy-inbox-normalizer.js", "v9_legacy_inbox_normalizer_v3_comment_private_reply");
requireToken("v9/core/comment-private-reply.js", "v10_comment_private_reply_v1_actionable_only");
requireToken("v10-comment-private-reply-recovery-worker.js", "v10_comment_private_reply_recovery_v1_frontier_safe");
requireToken("v10/core/decision-contract.js", "V10_CONTACT_ONLY_REPLY_INVALID");

globalThis.__AIGUKA_V10_LIVE_RELEASE__ = RELEASE;
console.log(`[AIGUKA V10] ${RELEASE} verified: hard grounded commerce rules, comment-to-private-Messenger delivery, one Message Gateway and no runtime business source patching`);
