import fs from "node:fs";

const file = "v9-direct-core-worker.js";
let source = fs.readFileSync(file, "utf8");

const oldGate = 'if (mode !== "SHADOW") throw new Error(`V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE:${mode}`);';
const newGate = 'if (!["SHADOW", "ACTIVE"].includes(mode)) throw new Error(`V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE:${mode}`);';

if (!source.includes(newGate)) {
  if (!source.includes(oldGate)) throw new Error("V9_DIRECT_CORE_MODE_GATE_ANCHOR_NOT_FOUND");
  source = source.replace(oldGate, newGate);
}

source = source.replace('outbound_enabled: false,', 'outbound_enabled: mode === "ACTIVE",');
source = source.replace('[AIGUKA V9 direct Core] started; legacy reads=0; outbound locked', '[AIGUKA V9 direct Core] started; legacy reads=0; ACTIVE handoff supported');

fs.writeFileSync(file, source);
console.log("[AIGUKA V9] Direct Core supports SHADOW and ACTIVE; transport remains controlled by final-gate worker");
