import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE = "AIGUKA_V10_AI_SOVEREIGN_FINAL_WORKER_V1";

process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS ||= "5000";
process.env.AIGUKA_GEMINI_FREE_MIN_COOLDOWN_MS ||= "120000";
process.env.AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS ||= "300000";
process.env.AIGUKA_OPENAI_CREDIT_COOLDOWN_MS ||= "21600000";

const FILES = [
  "v10/core/advisory-engine.js",
  "v10/core/conversation-assembler.js",
  "v10/core/decision-contract.js",
  "v10/core/knowledge-advisor.js",
  "v10-decision-queue-janitor.js",
  "v10-direct-core-worker.js",
  "v10-ai-worker.js",
  "v10-ai-worker-final.js",
  "v10-outbound-worker.js",
  "v10-followup-worker.js",
  "v10-pancake-contact-guard-worker.js",
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
requireToken("v10-direct-core-worker.js", 'const VERSION = "v10_direct_ai_sovereign_v1";');
requireToken("v10-ai-worker.js", 'await import("./v10-ai-worker-final.js")');
requireToken("v10-ai-worker.js", 'await import("./v10-pancake-contact-guard-worker.js")');
requireToken("v10-ai-worker.js", 'await import("./v10-followup-worker.js")');
requireToken("v10-ai-worker.js", "runtime_source_patching: false");
forbidToken("v10-ai-worker.js", "patch-v10-provider-load-balancer");
forbidToken("v10-ai-worker.js", "patch-v10-decision-integrity");
requireToken("v10-ai-worker-final.js", 'const VERSION = "v10_ai_quality_guard_v13";');
requireToken("v10-ai-worker-final.js", "providerSettings(provider).max_input_chars");
requireToken("v10-ai-worker-final.js", "AIGUKA_V10_DECISION_INTEGRITY_V10");
requireToken("v10-ai-worker-final.js", "recoverStaleProcessing");
requireToken("v10-ai-worker-final.js", "operational_fallback_enabled: false");
requireToken("v10-outbound-worker.js", 'const VERSION = "v10_outbound_safety_only_v1";');
requireToken("v10-outbound-worker.js", "AIGUKA_V10_OUTBOUND_REPLY_ORDER_V1");
requireToken("v10-followup-worker.js", 'const VERSION = "v10_followup_v8_event_v2";');
requireToken("v10-followup-worker.js", "PANCAKE_CONTACT_TAG_FOUND");
requireToken("v10-followup-worker.js", "event_image_count");
requireToken("v10-pancake-contact-guard-worker.js", 'const VERSION = "v10_pancake_contact_guard_v2";');
requireToken("v10-pancake-contact-guard-worker.js", "pages.fm/api/public_api/v2/pages");
requireToken("followup-admin-v8.js", "installFollowupAdminV8");
requireToken("followup-admin-v8.js", "v10_upsert_followup_event");
requireToken("followup-admin-v8.js", "v10_save_followup_config_only");
requireToken("followup-admin-v8.js", "/follow-up-admin/client.js");
forbidToken("followup-admin-v8.js", "v10_replace_followup_events");
requireToken("followup-admin-v8-client.js", "byId('add-event')");
requireToken("followup-admin-v8-client.js", "Lưu Event này");
requireToken("followup-admin-v8-client.js", "/follow-up-admin/api/event/save");
requireToken("followup-admin-v8-client.js", "wait_minutes");
requireToken("v10/core/advisory-engine.js", "advisory_only: true");
requireToken("v10/core/conversation-assembler.js", "latest_message_is_not_authoritative");
requireToken("v10/core/decision-contract.js", "HIẾN PHÁP MỤC TIÊU");
requireToken("v10/core/decision-contract.js", "contact_state");
requireToken("v10/core/decision-contract.js", '"follow_up_plan",');

globalThis.__AIGUKA_V10_LIVE_RELEASE__ = RELEASE;
console.log(`[AIGUKA V10] ${RELEASE} verified: safe per-event Follow-up saves, non-destructive global saves, sequential Event timing, live Pancake contact guard and AI-only customer decisions`);
