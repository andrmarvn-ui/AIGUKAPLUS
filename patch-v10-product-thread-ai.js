import fs from "node:fs";

const FILE = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_PRODUCT_THREAD_AI_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_PRODUCT_THREAD_AI_WORKER_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const importAnchor = 'import { deriveUnresolvedNeeds } from "./v10/core/unresolved-needs.js";';
  const threadImport = 'import { deriveProductThreads } from "./v10/core/product-threads.js";';
  if (!source.includes(importAnchor)) throw new Error("V10_PRODUCT_THREAD_AI_IMPORT_ANCHOR_MISSING");
  if (!source.includes(threadImport)) source = source.replace(importAnchor, `${importAnchor}\n${threadImport}`);

  const deriveAnchor = "  const unresolvedNeeds = deriveUnresolvedNeeds(conversation, knowledgeAdvisors);";
  if (!source.includes(deriveAnchor)) throw new Error("V10_PRODUCT_THREAD_AI_DERIVE_ANCHOR_MISSING");
  source = source.replace(
    deriveAnchor,
    `${deriveAnchor}\n  const productThreads = deriveProductThreads(unresolvedNeeds, knowledgeAdvisors);`,
  );

  const unresolvedAnchor = "    unresolved_needs: unresolvedNeeds,";
  const occurrences = source.split(unresolvedAnchor).length - 1;
  if (occurrences < 1) throw new Error("V10_PRODUCT_THREAD_AI_MODEL_INPUT_ANCHOR_MISSING");
  source = source.replaceAll(
    unresolvedAnchor,
    `${unresolvedAnchor}\n    product_threads: productThreads,`,
  );

  const authorityAnchor = "      validation_feedback_returns_to_ai: true,";
  if (source.includes(authorityAnchor)) {
    source = source.replace(
      authorityAnchor,
      `${authorityAnchor}\n      product_threads_preserve_independent_product_groups: true,`,
    );
  }

  source = source.replace(
    'const VERSION = "v10_ai_sovereign_validator_v18";',
    'const VERSION = "v10_ai_product_threads_v19";',
  );
  source += `\n// ${MARK}\n`;

  if (!source.includes(threadImport) || !source.includes("product_threads: productThreads")) {
    throw new Error("V10_PRODUCT_THREAD_AI_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] product-thread AI enabled: independent product groups remain visible to the model and are audited in the final decision");
