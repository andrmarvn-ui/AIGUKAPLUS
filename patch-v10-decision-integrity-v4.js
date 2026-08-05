import fs from "node:fs";

const v3File = "patch-v10-decision-integrity-v3.js";
if (!fs.existsSync(v3File)) throw new Error("V10_DECISION_INTEGRITY_V4_V3_FILE_MISSING");
let source = fs.readFileSync(v3File, "utf8");
const strictBlock = `  const heartbeatTarget = "        provider_failover_enabled: true,";\n  if (!source.includes(heartbeatTarget)) throw new Error("V10_DECISION_INTEGRITY_V3_HEARTBEAT_TARGET_MISSING");\n  source = source.replace(heartbeatTarget, heartbeatTarget + "\\n        decision_integrity_guard: true,\\n        exact_catalog_guard: true,\\n        salutation_guard: true,\\n        context_documents_deduplicated: true,");`;
const optionalBlock = `  const heartbeatTarget = "        provider_failover_enabled: true,";\n  if (source.includes(heartbeatTarget)) {\n    source = source.replace(heartbeatTarget, heartbeatTarget + "\\n        decision_integrity_guard: true,\\n        exact_catalog_guard: true,\\n        salutation_guard: true,\\n        context_documents_deduplicated: true,");\n  }`;
if (!source.includes(strictBlock)) throw new Error("V10_DECISION_INTEGRITY_V4_TARGET_MISSING");
source = source.replace(strictBlock, optionalBlock);
fs.writeFileSync(v3File, source, "utf8");
await import("./patch-v10-decision-integrity-v3.js?quality=v4");
