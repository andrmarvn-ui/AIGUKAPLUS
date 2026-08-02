import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../v8-v9-mode-sync-worker.js", import.meta.url), "utf8");
const release = fs.readFileSync(new URL("../v9-live-release-patch.js", import.meta.url), "utf8");

test("mode sync never blocks Railway HTTP startup", () => {
  assert.match(source, /v8_v9_mode_sync_v2/);
  assert.match(source, /void tick\(\);/);
  assert.doesNotMatch(source, /await tick\(\);/);
  assert.match(source, /scheduled non-blocking/);
});

test("live release still installs mode sync after customer worker patches", () => {
  const noDrop = release.indexOf('["no-drop", "./v9-no-drop-release-patch.js"]');
  const multiProduct = release.indexOf('["multi-product-plan", "./v9-semantic-product-lock-release-patch.js"]');
  const modeSync = release.indexOf('applyStage("mode-sync", "./v8-v9-mode-sync-worker.js")');
  assert.ok(noDrop >= 0 && multiProduct > noDrop && modeSync > multiProduct);
});
