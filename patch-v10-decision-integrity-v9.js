import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V9";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V9_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");
if (!source.includes(MARK)) {
  if (!source.includes("AIGUKA_V10_DECISION_INTEGRITY_V8")) throw new Error("V10_DECISION_INTEGRITY_V9_BASE_MISSING");

  const applyStart = source.indexOf("function applySalutation(value, style) {");
  const applyEnd = source.indexOf("function contactIsKnown", applyStart);
  if (applyStart < 0 || applyEnd < 0) throw new Error("V10_DECISION_INTEGRITY_V9_APPLY_TARGET_MISSING");
  let block = source.slice(applyStart, applyEnd);
  const returnIndex = block.lastIndexOf("  return text;");
  if (returnIndex < 0) throw new Error("V10_DECISION_INTEGRITY_V9_RETURN_TARGET_MISSING");
  const surface = String.raw`  text = text
    .replace(/anh\s*\/\s*chị(?:\s*\/\s*(?:anh|chị))+/gi, "anh/chị")
    .replace(/\b(cô|chú|bác|chị|anh)(?:\s*\/\s*\1)+\b/gi, "$1")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([.!?])\s+([a-zà-ỹđ])/g, function (_match, punctuation, letter) { return punctuation + " " + letter.toLocaleUpperCase("vi-VN"); });
  if (text) text = text.charAt(0).toLocaleUpperCase("vi-VN") + text.slice(1);
`;
  block = block.slice(0, returnIndex) + surface + block.slice(returnIndex);
  source = source.slice(0, applyStart) + block + source.slice(applyEnd);

  source = source
    .replace('/\\b(quat tran|quat 10 canh|quat 8 canh|quat 5 canh|quat 6 canh)\\b/.test(latest || active)', '/\\b(quat tran|quat 10(?: canh)?|quat 8(?: canh)?|quat 5(?: canh)?|quat 6(?: canh)?)\\b/.test(latest || active)')
    .replace('/\\bquat.{0,20}10 canh\\b/.test(latest + " " + active)', '/\\bquat.{0,20}10(?: canh)?\\b/.test(latest + " " + active)')
    .replace('/\\bquat.{0,20}10 canh\\b/.test(active)', '/\\bquat.{0,20}10(?: canh)?\\b/.test(active)');

  source = source.replace("v10_ai_quality_guard_v11", "v10_ai_quality_guard_v12");
  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v9 enabled: idempotent salutation and quạt-10 scope");
}
