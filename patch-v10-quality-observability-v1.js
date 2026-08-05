import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_QUALITY_OBSERVABILITY_V1";
if (!fs.existsSync(file)) throw new Error("V10_QUALITY_OBSERVABILITY_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");
if (!source.includes(MARK)) {
  if (!source.includes("AIGUKA_V10_DECISION_INTEGRITY_V2")) throw new Error("V10_QUALITY_OBSERVABILITY_INTEGRITY_NOT_INSTALLED");
  source = source.replace(/v10_ai_quota_aware_balancer_v\d+/, "v10_ai_quality_guard_v7");
  const target = "        provider_failover_enabled: true,";
  if (!source.includes(target)) throw new Error("V10_QUALITY_OBSERVABILITY_HEARTBEAT_TARGET_MISSING");
  source = source.replace(target, `${target}\n        decision_integrity_guard: true,\n        exact_catalog_guard: true,\n        salutation_guard: true,\n        context_documents_deduplicated: true, // ${MARK}`);
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] quality observability v1 enabled");
}
