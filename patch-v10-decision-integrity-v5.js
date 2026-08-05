import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V5";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V5_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");
if (!source.includes(MARK)) {
  if (!source.includes("AIGUKA_V10_DECISION_INTEGRITY_V3")) throw new Error("V10_DECISION_INTEGRITY_V5_BASE_MISSING");
  const applyMarker = "function applySalutation(value, style) {";
  if (!source.includes(applyMarker)) throw new Error("V10_DECISION_INTEGRITY_V5_APPLY_TARGET_MISSING");
  const cleaner = `function cleanProviderMarkup(value) {\n  return String(value || \"\")\n    .replace(/<co>/gi, \"\")\n    .replace(/<\\/co(?:\\s*:\\s*[^>]*)?>/gi, \"\")\n    .replace(/<[^>]{1,120}>/g, \"\")\n    .replace(/\\s+/g, \" \")\n    .trim();\n}\n// ${MARK}\n\n`;
  source = source.replace(applyMarker, cleaner + applyMarker);
  const textLine = '  let text = String(value || "").replace(/\\s+/g, " ").trim();';
  if (!source.includes(textLine)) throw new Error("V10_DECISION_INTEGRITY_V5_TEXT_TARGET_MISSING");
  source = source.replace(textLine, '  let text = cleanProviderMarkup(value);');
  const defaultTail = `  } else if (style.customer === "anh") {\n    text = text.replace(/\\banh\\s*\\/\\s*chị\\b/gi, "anh").replace(/\\banh chị\\b/gi, "anh");\n  }\n  return text;`;
  const normalizedTail = `  } else if (style.customer === "anh") {\n    text = text.replace(/\\banh\\s*\\/\\s*chị\\b/gi, "anh").replace(/\\banh chị\\b/gi, "anh");\n  } else {\n    text = text\n      .replace(/\\bAnh đang\\b/g, "Anh/chị đang")\n      .replace(/\\bChị đang\\b/g, "Anh/chị đang")\n      .replace(/\\bem gửi anh\\b/gi, "em gửi anh/chị")\n      .replace(/\\bem gửi chị\\b/gi, "em gửi anh/chị");\n  }\n  return text;`;
  if (!source.includes(defaultTail)) throw new Error("V10_DECISION_INTEGRITY_V5_DEFAULT_STYLE_TARGET_MISSING");
  source = source.replace(defaultTail, normalizedTail);
  source = source.replace("v10_ai_quality_guard_v7", "v10_ai_quality_guard_v8");
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v5 enabled: provider markup removed and wording normalized");
}
