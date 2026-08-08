import fs from "node:fs";

const FILE = "v10-direct-core-worker.js";
const MARK = "AIGUKA_V10_DIRECT_CORE_STRUCTURED_INPUT_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_DIRECT_CORE_STRUCTURED_INPUT_WORKER_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const queryOld = "source_event_id,source_system,actor_type,actor_evidence,event_type,message_text,attachments,referral,occurred_at,received_at";
  const queryNew = "source_event_id,source_system,actor_type,actor_evidence,event_type,message_text,attachments,referral,payload,occurred_at,received_at";
  if (!source.includes(queryOld)) throw new Error("V10_DIRECT_CORE_STRUCTURED_INPUT_QUERY_ANCHOR_MISSING");
  source = source.replace(queryOld, queryNew);
  source = source.replace(
    'const VERSION = "v10_direct_ai_sovereign_v2_frontier_guard";',
    'const VERSION = "v10_direct_ai_sovereign_v3_structured_input";',
  );
  source = source.replace(
    'details: { ...details, rules_authority: "advisory_only", ai_decision_authority: "sole", customer_frontier_guard: true },',
    'details: { ...details, rules_authority: "advisory_only", ai_decision_authority: "sole", customer_frontier_guard: true, structured_input_semantics: true, postback_payload_preserved: true },',
  );
  source += `\n// ${MARK}\n`;
  if (!source.includes(queryNew) || !source.includes('v10_direct_ai_sovereign_v3_structured_input')) {
    throw new Error("V10_DIRECT_CORE_STRUCTURED_INPUT_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] direct Core structured input enabled: postback title/payload metadata reaches semantic conversation assembly");
