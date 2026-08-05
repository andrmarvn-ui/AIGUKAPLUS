import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
if (!fs.existsSync(file)) {
  console.error("[AIGUKA V10] load balancer v5 patch skipped: worker file missing");
} else {
  let source = fs.readFileSync(file, "utf8");
  if (source.includes("v10_ai_quota_aware_balancer_v4") && !source.includes("v10_ai_quota_aware_balancer_v5")) {
    source = source
      .replace("v10_ai_quota_aware_balancer_v4", "v10_ai_quota_aware_balancer_v5")
      .replace(
        "const BATCH_SIZE = Math.max(1, Math.min(4, Number(process.env.AIGUKA_V10_AI_BATCH_SIZE || 2)));",
        "const BATCH_SIZE = Math.max(1, Math.min(4, Number(process.env.AIGUKA_V10_AI_BATCH_SIZE || 3)));",
      )
      .replace(
        "const PROVIDER_CACHE_MS = Math.max(5000, Number(process.env.AIGUKA_V10_PROVIDER_CACHE_MS || 15000));",
        "const PROVIDER_CACHE_MS = Math.max(3000, Number(process.env.AIGUKA_V10_PROVIDER_CACHE_MS || 5000));",
      );
    fs.writeFileSync(file, source, "utf8");
    console.log("[AIGUKA V10] load balancer v5 enabled: batch=3, provider cache=5s");
  }
}
