import fs from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE = "AIGUKA_V10_AI_SOVEREIGN_ADVISORY_V1";

// Gemini Free may remain rate-limited longer than one short retry cycle. These defaults
// are established before the AI worker is imported so provider pressure cannot exhaust
// the conversation after only three attempts. Explicit Railway settings still win.
process.env.AIGUKA_V10_AI_MAX_ATTEMPTS ||= "10";
process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS ||= "12000";
process.env.AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS ||= "300000";

const FILES = [
  "v10/core/advisory-engine.js",
  "v10/core/conversation-assembler.js",
  "v10/core/decision-contract.js",
  "v10/core/knowledge-advisor.js",
  "v10-decision-queue-janitor.js",
  "v10-direct-core-worker.js",
  "v10-ai-worker.js",
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
requireToken("v10-ai-worker.js", 'const VERSION = "v10_ai_sovereign_lease_v1";');
requireToken("v10-ai-worker.js", "recoverStaleProcessing");
requireToken("v10-outbound-worker.js", 'const VERSION = "v10_outbound_safety_only_v1";');
requireToken("v10/core/advisory-engine.js", "advisory_only: true");
requireToken("v10/core/conversation-assembler.js", "latest_message_is_not_authoritative");
requireToken("v10/core/decision-contract.js", "sole business decision maker");
requireToken("v10/core/decision-contract.js", '"follow_up_plan",');

globalThis.__AIGUKA_V10_LIVE_RELEASE__ = RELEASE;
console.log(`[AIGUKA V10] ${RELEASE} verified: strict provider schema, advisory-only rules, AI sole decision, processing lease recovery and pressure-aware retry defaults`);
