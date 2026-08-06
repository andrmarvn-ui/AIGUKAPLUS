import fs from "node:fs";

const file = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_GENERAL_PRODUCT_SALES_FINALIZED_V2_SMART_REPAIR";
const TARGET_VERSION = "v10_ai_quality_guard_v17_smart_sales_advisory";

if (!fs.existsSync(file)) throw new Error("V10_GENERAL_SALES_FINALIZE_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");

for (const token of [
  "AIGUKA_PROVIDER_RESILIENCE_V1",
  "AIGUKA_V10_GENERAL_PRODUCT_SALES_HANDOFF_V2_SMART_REPAIR",
  "enforceGeneralProductSalesHandoff",
  "smart_reply_repair",
  "hard_output_blocking = false",
]) {
  if (!source.includes(token)) throw new Error(`V10_GENERAL_SALES_FINALIZE_TOKEN_MISSING:${token}`);
}

if (!source.includes(MARK)) {
  if (!source.includes(`const VERSION = "${TARGET_VERSION}";`)) {
    source = source.replace(
      /const VERSION = "v10_ai_quality_guard_v(?:14|15|16_general_sales)";/,
      `const VERSION = "${TARGET_VERSION}";`,
    );
  }
  if (!source.includes(`const VERSION = "${TARGET_VERSION}";`)) {
    throw new Error("V10_GENERAL_SALES_FINALIZE_VERSION_TARGET_MISSING");
  }
  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
}

console.log("[AIGUKA V10] adaptive product assistance finalized: useful answers are preserved, unsafe parts are repaired and difficult cases are escalated to product specialists");
