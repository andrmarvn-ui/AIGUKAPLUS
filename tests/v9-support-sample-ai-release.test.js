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

test("SUPPORT sample requests use current Mapping as context and AI as final catalog authority", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-support-sample-ai-"));
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
    await import(`${pathToFileURL(path.join(root, "v9-support-sample-ai-release-patch.js")).href}?test=${Date.now()}`);
    await import(`${pathToFileURL(path.join(root, "v9-media-authority-release-patch.js")).href}?test=${Date.now()}`);
  } finally {
    process.chdir(previous);
  }

  const ai = fs.readFileSync(path.join(temp, "v9-ai-shadow-worker.js"), "utf8");
  const direct = fs.readFileSync(path.join(temp, "v9-direct-core-worker.js"), "utf8");

  assert.match(ai, /AIGUKA_V9_SUPPORT_SAMPLE_AI_V1/);
  assert.match(ai, /supportTextWantsSamples/);
  assert.match(ai, /supportLiveAdMapping/);
  assert.match(ai, /ad_mappings\?select=ad_id,ad_name,recognition_name/);
  assert.match(ai, /Mapping chỉ là ngữ cảnh tham khảo/);
  assert.match(ai, /supportTextDecision/);
  assert.match(ai, /products, media_catalog_keys: products/);
  assert.match(ai, /support_sample_catalog_unresolved/);
  assert.match(ai, /support_mapping_fallback/);
  assert.match(ai, /support_sample_catalog_v1/);

  assert.match(direct, /AIGUKA_V9_SUPPORT_SAMPLE_AI_V1/);
  assert.match(direct, /latestReferralEvent/);
  assert.match(direct, /hasReferralEvidence/);

  for (const file of ["v9-direct-core-worker.js", "v9-ai-shadow-worker.js", "v9-live-outbound-worker.js"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(temp, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});
