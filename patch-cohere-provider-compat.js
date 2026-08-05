import fs from "node:fs";

const managerFile = "ai-provider-manager.js";
const marker = "AIGUKA_COHERE_COMPAT_TEST_V1";

if (!fs.existsSync(managerFile)) {
  console.error("[AIGUKA] Cohere provider compatibility patch skipped: manager missing");
} else {
  let source = fs.readFileSync(managerFile, "utf8");
  if (!source.includes(marker)) {
    const before = `          tools: [{ type: "function", function: tool }],
          tool_choice: "required",
          max_tokens: 180,
          stream: false,`;
    const after = `          // ${marker}: Cohere Compatibility supports tools but rejects tool_choice.
          tools: [{ type: "function", function: { ...tool, strict: true } }],
          ...((() => {
            try { return new URL(base).hostname.toLowerCase().endsWith("cohere.ai"); }
            catch { return false; }
          })() ? { reasoning_effort: "none", temperature: 0 } : { tool_choice: "required" }),
          max_tokens: 180,
          stream: false,`;

    if (!source.includes(before)) throw new Error("COHERE_PROVIDER_TEST_PATCH_TARGET_MISSING");
    source = source.replace(before, after);
    fs.writeFileSync(managerFile, source, "utf8");
    console.log("[AIGUKA] Cohere provider test compatibility installed");
  }
}
