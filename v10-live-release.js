import fs from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE = "AIGUKA_V10_AI_SOVEREIGN_ADVISORY_V2";

// Conservative defaults for Gemini Free. The AI scheduler does not claim customer work
// while every provider is unavailable, so cooldown never consumes a decision attempt.
process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS ||= "60000";
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
  "v10-ai-worker-v2.js",
  "v10-outbound-worker.js",
];

function requireToken(file, token) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(token)) throw new Error(`V10_RELEASE_TOKEN_MISSING:${file}:${token}`);
}

for (const file of FILES) {
  if (!fs.existsSync(file)) throw new Error(`V10_RELEASE_FILE_MISSING:${file}`);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`V10_RELEASE_SYNTAX:${file}:${result.stderr || result.stdout}`);
}

requireToken("v10-decision-queue-janitor.js", 'const VERSION = "v10_queue_hygiene_v2";');
requireToken("v10-decision-queue-janitor.js", "V10_REHYDRATE_LEGACY_PENDING");
requireToken("v10-direct-core-worker.js", 'const VERSION = "v10_direct_ai_sovereign_v1";');
requireToken("v10-ai-worker.js", 'await import("./v10-ai-worker-v2.js")');
requireToken("v10-ai-worker-v2.js", 'const VERSION = "v10_ai_sovereign_scheduler_v2";');
requireToken("v10-ai-worker-v2.js", "providerAvailability");
requireToken("v10-ai-worker-v2.js", "recoverStaleProcessing");
requireToken("v10-ai-worker-v2.js", "operational_fallback_enabled: false");
requireToken("v10-outbound-worker.js", 'const VERSION = "v10_outbound_safety_only_v1";');
requireToken("v10/core/advisory-engine.js", "advisory_only: true");
requireToken("v10/core/conversation-assembler.js", "latest_message_is_not_authoritative");
requireToken("v10/core/decision-contract.js", "sole business decision maker");
requireToken("v10/core/decision-contract.js", '"follow_up_plan",');

globalThis.__AIGUKA_V10_LIVE_RELEASE__ = RELEASE;
console.log(`[AIGUKA V10] ${RELEASE} verified: AI-only customer decisions, provider-aware scheduling, no quota attempt burn, no operational customer fallback`);
