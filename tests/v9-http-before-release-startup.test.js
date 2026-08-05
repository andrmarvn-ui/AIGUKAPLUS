import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
const serverRelease = fs.readFileSync(new URL("../v10-server-release.js", import.meta.url), "utf8");

function position(token) {
  const value = source.indexOf(token);
  assert.ok(value >= 0, `missing startup token: ${token}`);
  return value;
}

test("checksummed Railway HTTP server binds before V10 AI verification", () => {
  const server = position('await safeImport("./v10-server-release.js", true)');
  const release = position('await safeImport("./v10-live-release.js", true)');
  const janitor = position('await safeImport("./v10-decision-queue-janitor.js", true)');
  const directWorker = position('startDetached("./v10-direct-core-worker.js")');
  const aiWorker = position('startDetached("./v10-ai-worker.js")');
  const outboundWorker = position('startDetached("./v10-outbound-worker.js")');

  assert.ok(server < release, "HTTP server must bind before V10 AI verification runs");
  assert.ok(release < janitor, "V10 AI release must verify before queue cleanup starts");
  assert.ok(janitor < directWorker, "queue cleanup must finish before Direct Core starts");
  assert.ok(janitor < aiWorker, "queue cleanup must finish before AI starts");
  assert.ok(janitor < outboundWorker, "queue cleanup must finish before Outbound starts");
});

test("server source patches are outside production startup", () => {
  const patchLoopEnd = position("]) await safeImport(patch);");
  const server = position('await safeImport("./v10-server-release.js", true)');
  assert.ok(server > patchLoopEnd);
  assert.match(source, /final V10 HTTP server initialized; verifying V10 AI release contract/);
  assert.doesNotMatch(source, /safeImport\("\.\/patch-server\.js"/);
  assert.doesNotMatch(source, /safeImport\("\.\/patch-direct-meta-dashboard\.js"/);
  assert.doesNotMatch(source, /safeImport\("\.\/server-fixed\.js"/);
  assert.doesNotMatch(source, /await safeImport\("\.\/v9-live-release-patch\.js", true\)/);
});

test("server release verifies checksum and required route modules", () => {
  assert.match(serverRelease, /createHash\("sha256"\)/);
  assert.match(serverRelease, /V10_SERVER_CHECKSUM_MISMATCH/);
  assert.match(serverRelease, /server-v10-final\.js/);
  assert.match(serverRelease, /installReportRoutes/);
  assert.match(serverRelease, /installV10AdminDashboard/);
  assert.match(serverRelease, /installAiProviderManager/);
  assert.match(serverRelease, /installMappingCenter/);
  assert.match(serverRelease, /no runtime server source patching/);
});
