import fs from "node:fs";

const managerFile = "ai-provider-manager.js";
const marker = "AIGUKA_COHERE_NATIVE_V2_TEST_V3";

if (!fs.existsSync(managerFile)) {
  console.error("[AIGUKA] Cohere provider compatibility patch skipped: manager missing");
} else {
  let source = fs.readFileSync(managerFile, "utf8");
  if (!source.includes(marker)) {
    const before = `    if (style === "gemini_openai_chat") {`;
    const after = `    const cohereHost = (() => {
      try { return new URL(base).hostname.toLowerCase().endsWith("cohere.ai"); }
      catch { return false; }
    })();

    if (cohereHost) {
      endpoint = "https://api.cohere.ai/v2/chat"; // ${marker}
      payload = await readPayload(await fetch(endpoint, {
        method: "POST",
        headers: { authorization: \`Bearer \${key}\`, "content-type": "application/json", "X-Client-Name": "AIGUKA" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are an API readiness probe. The only valid response is a call to aiguka_provider_probe." },
            { role: "user", content: "Call aiguka_provider_probe now with ok=true, provider='cohere', and reply='ready'." },
          ],
          tools: [{ type: "function", function: tool }],
          strict_tools: true,
          temperature: 0,
          max_tokens: 180,
          stream: false,
        }),
        signal: AbortSignal.timeout(55000),
      }));
      const calls = payload?.message?.tool_calls || [];
      if (!calls.some((x) => x?.function?.name === "aiguka_provider_probe")) throw new Error("TOOL_CALL_NOT_RETURNED");
    } else if (style === "gemini_openai_chat") {`;

    if (!source.includes(before)) throw new Error("COHERE_NATIVE_V2_TEST_PATCH_TARGET_MISSING");
    source = source.replace(before, after);
    fs.writeFileSync(managerFile, source, "utf8");
    console.log("[AIGUKA] Cohere native v2 strict-tools provider test installed");
  }
}
