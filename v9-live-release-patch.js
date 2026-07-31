import fs from "node:fs";

const directFile = "v9-direct-core-worker.js";
let directSource = fs.readFileSync(directFile, "utf8");

const oldGate = 'if (mode !== "SHADOW") throw new Error(`V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE:${mode}`);';
const newGate = 'if (!["SHADOW", "ACTIVE"].includes(mode)) throw new Error(`V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE:${mode}`);';

if (!directSource.includes(newGate)) {
  if (!directSource.includes(oldGate)) throw new Error("V9_DIRECT_CORE_MODE_GATE_ANCHOR_NOT_FOUND");
  directSource = directSource.replace(oldGate, newGate);
}

directSource = directSource.replace('outbound_enabled: false,', 'outbound_enabled: mode === "ACTIVE",');
directSource = directSource.replace('[AIGUKA V9 direct Core] started; legacy reads=0; outbound locked', '[AIGUKA V9 direct Core] started; legacy reads=0; ACTIVE handoff supported');
fs.writeFileSync(directFile, directSource);

const aiLiveFile = "v9-ai-live-worker.js";
const aiTargetFile = "v9-ai-shadow-worker.js";
if (!fs.existsSync(aiLiveFile)) throw new Error("V9_AI_LIVE_WORKER_NOT_FOUND");
fs.writeFileSync(aiTargetFile, fs.readFileSync(aiLiveFile, "utf8"));

const outboundFile = "v9-live-outbound-worker.js";
let outboundSource = fs.readFileSync(outboundFile, "utf8");
outboundSource = outboundSource.replace('body: { status: assets.length ? "text_sent" : "sent", updated_at: new Date().toISOString() }', 'body: { status: "sent", updated_at: new Date().toISOString() }');
fs.writeFileSync(outboundFile, outboundSource);

console.log("[AIGUKA V9] ACTIVE Core, Gemini-first AI fallback and valid delivery states installed");
