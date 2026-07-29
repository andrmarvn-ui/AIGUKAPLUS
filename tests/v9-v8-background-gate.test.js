import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

test("legacy V8 background workers default to disabled", () => {
  assert.match(start, /AIGUKA_V8_BACKGROUND_WORKERS\s*\|\|\s*"false"/);
  assert.match(start, /if \(v8BackgroundEnabled\) \{/);
});

test("all five legacy workers are inside the rollback gate", () => {
  const gateStart = start.indexOf("if (v8BackgroundEnabled) {");
  const gateEnd = start.indexOf("} else {", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gated = start.slice(gateStart, gateEnd);
  for (const worker of [
    "webhook-inbox-worker.js",
    "meta-recovery-loader.js",
    "ai-dispatch-worker.js",
    "outbound-worker.js",
    "meta-profile-sync-worker.js",
  ]) assert.match(gated, new RegExp(worker.replaceAll(".", "\\.")));
});

test("direct V9 workers remain outside the V8 rollback gate", () => {
  const gateEnd = start.indexOf("} else {", start.indexOf("if (v8BackgroundEnabled) {"));
  for (const worker of [
    'startDetached("./v9-legacy-inbox-bridge.js")',
    'startDetached("./v9-direct-core-worker.js")',
    'startDetached("./v9-ai-shadow-worker.js")',
  ]) assert.ok(start.indexOf(worker) > gateEnd);
  assert.doesNotMatch(start, /startDetached\("\.\/v9-shadow-worker\.js"\)/);
});
