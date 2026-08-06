import fs from "node:fs";

const file = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_GENERAL_PRODUCT_SALES_FINALIZED_V1";

if (!fs.existsSync(file)) throw new Error("V10_GENERAL_SALES_FINALIZE_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");

for (const token of [
  "AIGUKA_PROVIDER_RESILIENCE_V1",
  "AIGUKA_V10_GENERAL_PRODUCT_SALES_HANDOFF_V1",
  "enforceGeneralProductSalesHandoff",
  "sales_handoff_required",
]) {
  if (!source.includes(token)) throw new Error(`V10_GENERAL_SALES_FINALIZE_TOKEN_MISSING:${token}`);
}

if (!source.includes(MARK)) {
  source = source.replace(
    'const VERSION = "v10_ai_quality_guard_v14";',
    'const VERSION = "v10_ai_quality_guard_v16_general_sales";',
  );
  if (!source.includes('const VERSION = "v10_ai_quality_guard_v16_general_sales";')) {
    throw new Error("V10_GENERAL_SALES_FINALIZE_VERSION_TARGET_MISSING");
  }
  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
}

console.log("[AIGUKA V10] general product sales runtime finalized after provider resilience");
