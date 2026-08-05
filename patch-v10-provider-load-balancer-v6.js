import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
if (!fs.existsSync(file)) {
  console.error("[AIGUKA V10] load balancer v6 patch skipped: worker file missing");
} else {
  let source = fs.readFileSync(file, "utf8");
  if (source.includes("v10_ai_quota_aware_balancer_v5") && !source.includes("v10_ai_quota_aware_balancer_v6")) {
    source = source.replace("v10_ai_quota_aware_balancer_v5", "v10_ai_quota_aware_balancer_v6");
    const before = `  const eligible = (rows || []).filter((provider) => {\n    const limit = Number(healthFor(provider).contextLimitChars || 0);\n    return !limit || !inputChars || inputChars < limit;\n  });`;
    const after = `  const eligible = (rows || []).filter((provider) => {\n    const learned = Number(healthFor(provider).contextLimitChars || 0);\n    const configured = Number(providerSettings(provider).max_input_chars || 0);\n    const limits = [learned, configured].filter((value) => Number.isFinite(value) && value > 0);\n    const limit = limits.length ? Math.min(...limits) : 0;\n    return !limit || !inputChars || inputChars < limit;\n  });`;
    if (!source.includes(before)) throw new Error("V10_LOAD_BALANCER_V6_ROUTE_TARGET_MISSING");
    source = source.replace(before, after);
    fs.writeFileSync(file, source, "utf8");
    console.log("[AIGUKA V10] load balancer v6 enabled: configured prompt-size routing");
  }
}
