import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

function position(token) {
  const value = source.indexOf(token);
  assert.ok(value >= 0, `missing startup token: ${token}`);
  return value;
}

test("Railway HTTP server binds before V9 release installation", () => {
  const server = position('await safeImport("./server-fixed.js", true)');
  const release = position('await safeImport("./v9-live-release-patch.js", true)');
  const directWorker = position('startDetached("./v9-direct-core-worker.js")');
  const aiWorker = position('startDetached("./v9-ai-shadow-worker.js")');
  const outboundWorker = position('startDetached("./v9-live-outbound-worker.js")');

  assert.ok(server < release, "HTTP server must bind before the generated V9 release runs");
  assert.ok(release < directWorker, "V9 release must finish before Direct Core starts");
  assert.ok(release < aiWorker, "V9 release must finish before AI starts");
  assert.ok(release < outboundWorker, "V9 release must finish before Outbound starts");
});

test("V9 release is no longer part of the pre-server patch array", () => {
  const patchLoopEnd = position("]) await safeImport(patch);");
  const release = position('await safeImport("./v9-live-release-patch.js", true)');
  assert.ok(release > patchLoopEnd);
  assert.match(source, /HTTP server initialized; installing V9 customer-worker release/);
});
