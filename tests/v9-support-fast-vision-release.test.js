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

test("SUPPORT fast vision keeps AIcake primary and grants AIGUKA one image sentence", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-support-vision-"));
  for (const file of [
    "v9/core/turn-builder.js",
    "v9/core/knowledge-selector.js",
    "v9/core/media-authority.js",
    "v9-direct-core-worker.js",
    "v9-live-outbound-worker.js",
  ]) copy(file, temp);
  copy("v9-ai-live-worker.js", temp, "v9-ai-shadow-worker.js");

  const previous = process.cwd();
  process.chdir(temp);
  try {
    await import(`${pathToFileURL(path.join(root, "v9-support-release-patch.js")).href}?test=${Date.now()}`);
    await import(`${pathToFileURL(path.join(root, "v9-support-fast-vision-release-patch.js")).href}?test=${Date.now()}`);
    await import(`${pathToFileURL(path.join(root, "v9-media-authority-release-patch.js")).href}?test=${Date.now()}`);
  } finally {
    process.chdir(previous);
  }

  const turn = fs.readFileSync(path.join(temp, "v9/core/turn-builder.js"), "utf8");
  const ai = fs.readFileSync(path.join(temp, "v9-ai-shadow-worker.js"), "utf8");
  const outbound = fs.readFileSync(path.join(temp, "v9-live-outbound-worker.js"), "utf8");

  assert.match(turn, /combinedAttachments/);
  assert.match(turn, /hasImage: realImageAttachments\.length > 0/);
  assert.match(turn, /sticker_id/);

  // Media Authority is deliberately applied after fast vision, so it owns the final worker version.
  assert.match(ai, /v9_ai_media_authority_v5/);
  assert.match(ai, /AIGUKA_V9_SUPPORT_FAST_VISION_V1/);
  assert.match(ai, /type: "image_url"/);
  assert.match(ai, /type: "input_image"/);
  assert.match(ai, /supportImageDecision/);
  assert.match(ai, /vision_catalog_index/);
  assert.match(ai, /wantsSamples/);
  assert.match(ai, /media_catalog_keys/);

  assert.match(outbound, /SUPPORT_SLIDE_OR_IMAGE_ONLY/);
  assert.match(outbound, /SUPPORT_IMAGE_ONE_SENTENCE_REQUIRED/);
  assert.match(outbound, /support_image_reply/);
  assert.match(outbound, /media_authority/);

  for (const file of [
    "v9/core/turn-builder.js",
    "v9-direct-core-worker.js",
    "v9-ai-shadow-worker.js",
    "v9-live-outbound-worker.js",
  ]) {
    const result = spawnSync(process.execPath, ["--check", path.join(temp, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});
