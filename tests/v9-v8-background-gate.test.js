import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

test("historical V8 background flag is ignored instead of opening a rollback gate", () => {
  assert.match(start, /AIGUKA_V8_BACKGROUND_WORKERS\s*\|\|\s*"false"/);
  assert.match(start, /AIGUKA_V8_BACKGROUND_WORKERS is ignored/);
  assert.doesNotMatch(start, /const v8BackgroundEnabled/);
  assert.doesNotMatch(start, /if \(v8BackgroundEnabled\) \{/);
});

test("legacy customer workers have no startup path", () => {
  for (const worker of [
    'startDetached("./webhook-inbox-worker.js")',
    'startDetached("./meta-recovery-loader.js")',
    'startDetached("./ai-dispatch-worker.js")',
    'startDetached("./outbound-worker.js")',
    'startDetached("./meta-profile-sync-worker.js")',
  ]) assert.equal(start.includes(worker), false, worker);
});

test("current V10 workers remain behind the isolated Core gate", () => {
  const gateStart = start.indexOf("if (v9CoreReady) {");
  assert.ok(gateStart >= 0);
  for (const worker of [
    'startDetached("./v9-legacy-inbox-bridge.js")',
    'startDetached("./v10-mode-compat-worker.js")',
    'await safeImport("./v10-decision-queue-janitor.js", true)',
    'startDetached("./v10-direct-core-worker.js")',
    'startDetached("./v10-ai-worker.js")',
    'startDetached("./v10-outbound-worker.js")',
  ]) assert.ok(start.indexOf(worker) > gateStart, worker);
  assert.doesNotMatch(start, /startDetached\("\.\/v9-shadow-worker\.js"\)/);
  assert.doesNotMatch(start, /startDetached\("\.\/v9-ai-shadow-worker\.js"\)/);
});
