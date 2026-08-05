import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V2";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V2_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");
if (!source.includes(MARK)) {
  const before = `  const decision = structuredClone(input);\n  const serialized = JSON.stringify(decision);\n  if (DECISION_LEAK_PATTERN.test(serialized)) throw new Error("V10_DECISION_INTERNAL_TEXT_REJECTED");`;
  const after = `  const decision = structuredClone(input);\n  const modelValueText = [\n    decision.final_reply,\n    decision.decision_reason,\n    decision.contact_benefit,\n    ...(Array.isArray(decision.intents) ? decision.intents : []),\n    ...(Array.isArray(decision.selected_products) ? decision.selected_products : []),\n    ...(Array.isArray(decision.selected_catalog_keys) ? decision.selected_catalog_keys : []),\n    ...(Array.isArray(decision.follow_up_plan) ? decision.follow_up_plan : []),\n  ].map((value) => String(value || "")).join(" ");\n  if (DECISION_LEAK_PATTERN.test(modelValueText)) throw new Error("V10_DECISION_INTERNAL_TEXT_REJECTED"); // ${MARK}`;
  if (!source.includes(before)) throw new Error("V10_DECISION_INTEGRITY_V2_TARGET_MISSING");
  source = source.replace(before, after);
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v2 enabled: scan values, not JSON field names");
}
