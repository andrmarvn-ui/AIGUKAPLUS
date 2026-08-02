import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("no-drop patch generates syntactically valid Railway workers", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-no-drop-generated-"));
  const ai = `
const VERSION = "base";
function fallbackDecision(turn, snapshot, selectedKnowledge, mappedSupportProducts, row) {
  const contactCaptured = Boolean(turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);
  const rawText = String(turn.combinedText || "").trim();
  return rawText;
}
async function process(snapshot, selectedKnowledge, mappedSupportProducts, row) {
  const contactCaptured = Boolean(snapshot?.turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);
  let rawDecision = {};
    const decision = validateDecision(rawDecision, { contactCaptured });
    const detectedMediaProducts = Array.isArray(decision.products) ? decision.products : [];
    await coreRest(\`v9_decisions?id=eq.\${row.id}\`, {});
}
function validateDecision(value) { return value; }
async function coreRest() {}
function resolveAuthoritativeCatalogKeys() { return []; }
`;
  const outbound = `
const VERSION = "base";
async function gate(decision, state) {
  if (state.phone || state.zalo || ["captured", "verified"].includes(String(state.contact_status || "").toLowerCase())) return { allowed: false, reason: "CONTACT_ALREADY_CAPTURED" };
  if (state.last_page_event_at) {
    return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };
  }
  return { allowed: true, text: "ok" };
}
async function processDecision(decision, config) {
  const claimed = decision;
  const gate = { text: "ok" };
  const needsSlides = Boolean(claimed?.output?.needs_slides || claimed.action === "reply_with_slides");
  const assets = [];
  const bundle = await bundleFor(claimed, gate.text, assets);
  return bundle;
}
async function bundleFor() { return {}; }
async function resolveAssets() { return { assets: [], catalog_keys: [], requested_keys: [] }; }
`;
  const direct = `const VERSION = "base";\n`;

  fs.writeFileSync(path.join(temp, "v9-ai-shadow-worker.js"), ai);
  fs.writeFileSync(path.join(temp, "v9-live-outbound-worker.js"), outbound);
  fs.writeFileSync(path.join(temp, "v9-direct-core-worker.js"), direct);

  const previous = process.cwd();
  process.chdir(temp);
  try {
    const patchUrl = pathToFileURL(path.join(previous, "v9-no-drop-release-patch.js")).href;
    await import(`${patchUrl}?generated-syntax=${Date.now()}`);
  } finally {
    process.chdir(previous);
  }

  const generatedOutbound = fs.readFileSync(path.join(temp, "v9-live-outbound-worker.js"), "utf8");
  assert.match(generatedOutbound, /claimsMediaSent/);
  assert.doesNotMatch(generatedOutbound, /gửi anh\/chị\.\*mẫu/);
  checkSyntax(path.join(temp, "v9-ai-shadow-worker.js"));
  checkSyntax(path.join(temp, "v9-live-outbound-worker.js"));
  checkSyntax(path.join(temp, "v9-direct-core-worker.js"));
});
