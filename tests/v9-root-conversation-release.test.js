import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();

function copy(relative, targetRoot, targetRelative = relative) {
  const target = path.join(targetRoot, targetRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}

test("root architecture installs after all SUPPORT and media patches", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-root-arch-"));
  const files = [
    "v9/core/turn-builder.js",
    "v9/core/conversation-intelligence.js",
    "v9/core/knowledge-selector.js",
    "v9/core/knowledge-selector-v2.js",
    "v9/core/decision-contract.js",
    "v9/core/decision-contract-v2.js",
    "v9/core/media-authority.js",
    "v9-direct-core-worker.js",
    "v9-ai-live-worker.js",
    "v9-live-outbound-worker.js",
    "v9-support-release-patch.js",
    "v9-support-fast-vision-release-patch.js",
    "v9-support-sample-ai-release-patch.js",
    "v9-media-authority-release-patch.js",
    "v9-support-large-slide-release-patch.js",
    "v9-root-conversation-architecture-release-patch.js",
  ];
  for (const file of files) copy(file, temp);
  copy("v9-ai-live-worker.js", temp, "v9-ai-shadow-worker.js");

  const previous = process.cwd();
  process.chdir(temp);
  try {
    for (const patch of [
      "v9-support-release-patch.js",
      "v9-support-fast-vision-release-patch.js",
      "v9-support-sample-ai-release-patch.js",
      "v9-media-authority-release-patch.js",
      "v9-support-large-slide-release-patch.js",
      "v9-root-conversation-architecture-release-patch.js",
    ]) {
      await import(`${pathToFileURL(path.join(temp, patch)).href}?test=${Date.now()}-${patch}`);
    }
  } finally {
    process.chdir(previous);
  }

  const direct = fs.readFileSync(path.join(temp, "v9-direct-core-worker.js"), "utf8");
  const ai = fs.readFileSync(path.join(temp, "v9-ai-shadow-worker.js"), "utf8");

  assert.match(direct, /AIGUKA_V9_ROOT_CONVERSATION_ARCH_V1/);
  assert.match(direct, /conversation-intelligence\.js/);
  assert.match(direct, /contextCustomerMessages: 12/);
  assert.match(direct, /persistConversationMemory/);
  assert.match(ai, /AIGUKA_V9_ROOT_CONVERSATION_ARCH_V1/);
  assert.match(ai, /decision-contract-v2\.js/);
  assert.match(ai, /knowledge-selector-v2\.js/);
  assert.match(ai, /rpc\/v9_mapping_catalog_candidates/);
  assert.match(ai, /support_non_media_suppressed/);
  assert.match(ai, /mappingFallback\.length === 1/);

  for (const file of ["v9-direct-core-worker.js", "v9-ai-shadow-worker.js", "v9-live-outbound-worker.js"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(temp, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});
