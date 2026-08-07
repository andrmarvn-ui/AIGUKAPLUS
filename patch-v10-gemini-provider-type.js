import fs from "node:fs";

const AI_FILE = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_GEMINI_PROVIDER_TYPE_V1";

if (!fs.existsSync(AI_FILE)) throw new Error("V10_GEMINI_PROVIDER_TYPE_AI_WORKER_MISSING");

let source = fs.readFileSync(AI_FILE, "utf8");
if (!source.includes(MARK)) {
  const oldFn = `function isGemini(provider = {}) {\n  return providerName(provider).includes("gemini");\n}`;
  if (!source.includes(oldFn)) throw new Error("V10_GEMINI_PROVIDER_TYPE_TARGET_MISSING");

  const newFn = `function isGemini(provider = {}) {\n  const type = String(provider?.provider_type || "").trim().toLowerCase();\n  const key = providerName(provider);\n  return type === "gemini" || type.includes("gemini") || key.includes("gemini") || key === "google" || key === "gemma";\n}\n\n// ${MARK}`;

  source = source.replace(oldFn, newFn);
  fs.writeFileSync(AI_FILE, source, "utf8");
}

console.log("[AIGUKA V10] Gemini-family routing fixed: provider_type=gemini, Google and Gemma use Gemini OpenAI-compatible chat endpoint");
