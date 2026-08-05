import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

function position(token) {
  const value = source.indexOf(token);
  assert.ok(value >= 0, `missing startup token: ${token}`);
  return value;
}

test("Railway HTTP server binds before V10 release verification", () => {
  const server = position('await safeImport("./server-fixed.js", true)');
  const release = position('await safeImport("./v10-live-release.js", true)');
  const janitor = position('await safeImport("./v10-decision-queue-janitor.js", true)');
  const directWorker = position('startDetached("./v10-direct-core-worker.js")');
  const aiWorker = position('startDetached("./v10-ai-worker.js")');
  const outboundWorker = position('startDetached("./v10-outbound-worker.js")');

  assert.ok(server < release, "HTTP server must bind before V10 verification runs");
  assert.ok(release < janitor, "V10 release must verify before queue cleanup starts");
  assert.ok(janitor < directWorker, "queue cleanup must finish before Direct Core starts");
  assert.ok(janitor < aiWorker, "queue cleanup must finish before AI starts");
  assert.ok(janitor < outboundWorker, "queue cleanup must finish before Outbound starts");
});

test("V10 release is outside the pre-server patch array and V9 generated release is not started", () => {
  const patchLoopEnd = position("]) await safeImport(patch);");
  const release = position('await safeImport("./v10-live-release.js", true)');
  assert.ok(release > patchLoopEnd);
  assert.match(source, /HTTP server initialized; verifying V10 release contract/);
  assert.doesNotMatch(source, /verifying clean V10 customer-worker release/);
  assert.doesNotMatch(source, /await safeImport\("\.\/v9-live-release-patch\.js", true\)/);
});
