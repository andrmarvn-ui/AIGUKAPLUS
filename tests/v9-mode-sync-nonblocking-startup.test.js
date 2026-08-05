import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../v10-mode-compat-worker.js", import.meta.url), "utf8");
const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

test("V10 mode compatibility never blocks Railway HTTP startup", () => {
  assert.match(source, /v10_mode_compat_v1/);
  assert.match(source, /void tick\(\);/);
  assert.doesNotMatch(source, /await tick\(\);/);
  assert.match(source, /non-blocking bridge scheduled/);
});

test("mode compatibility starts only after isolated Core is ready", () => {
  const coreGate = start.indexOf("if (v9CoreReady)");
  const bridge = start.indexOf('startDetached("./v10-mode-compat-worker.js")');
  assert.ok(coreGate >= 0 && bridge > coreGate);
  assert.match(source, /Math\.max\(30_000/);
});
