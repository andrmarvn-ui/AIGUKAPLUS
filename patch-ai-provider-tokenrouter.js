import fs from "node:fs";

const file = "ai-provider-manager.js";
const marker = "AIGUKA_TOKENROUTER_KIMI_K3_MANAGER_V1";

function replaceOrThrow(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`TOKENROUTER_MANAGER_TARGET_MISSING:${label}`);
  return source.replace(before, after);
}

if (!fs.existsSync(file)) throw new Error("AI_PROVIDER_MANAGER_MISSING");

let source = fs.readFileSync(file, "utf8");
if (!source.includes(marker)) {
  source = replaceOrThrow(
    source,
    '["api.deepseek.com", "api.moonshot.ai", "openrouter.ai", "integrate.api.nvidia.com", "api.x.ai"].includes(host)',
    '["api.deepseek.com", "api.moonshot.ai", "openrouter.ai", "integrate.api.nvidia.com", "api.x.ai", "api.tokenrouter.com"].includes(host)',
    "endpoint_style_host",
  );

  source = replaceOrThrow(
    source,
    '    const model = trim(row.model_name);\n    if (!base || !model) throw new Error("BASE_URL_OR_MODEL_MISSING");',
    '    const model = trim(row.model_name);\n    const host = (() => { try { return new URL(base).hostname.toLowerCase(); } catch { return ""; } })();\n    if (!base || !model) throw new Error("BASE_URL_OR_MODEL_MISSING");',
    "smoke_host",
  );

  source = replaceOrThrow(
    source,
    '          max_tokens: 180,\n          stream: false,',
    '          max_tokens: 180,\n          stream: false,\n          ...(host === "api.tokenrouter.com" ? { reasoning_effort: "low" } : {}),',
    "reasoning_effort",
  );

  source += `\n// ${marker}\n`;
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] TokenRouter Kimi K3 manager uses chat completions with low reasoning effort");
}
