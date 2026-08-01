import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function copy(relative, root, targetRelative = relative) {
  const target = path.join(root, targetRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), target);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-support-large-slide-"));
  for (const file of [
    "v9/core/turn-builder.js",
    "v9/core/knowledge-selector.js",
    "v9/core/media-authority.js",
    "v9-direct-core-worker.js",
    "v9-ai-live-worker.js",
    "v9-live-outbound-worker.js",
    "v9-support-release-patch.js",
    "v9-support-fast-vision-release-patch.js",
    "v9-support-sample-ai-release-patch.js",
    "v9-media-authority-release-patch.js",
    "v9-support-large-slide-release-patch.js",
  ]) copy(file, root);
  copy("v9-ai-live-worker.js", root, "v9-ai-shadow-worker.js");

  for (const patch of [
    "v9-support-release-patch.js",
    "v9-support-fast-vision-release-patch.js",
    "v9-support-sample-ai-release-patch.js",
    "v9-media-authority-release-patch.js",
    "v9-support-large-slide-release-patch.js",
  ]) {
    execFileSync(process.execPath, [patch], { cwd: root, stdio: "pipe" });
  }
  return root;
}

test("SUPPORT selects up to 30 exact assets and sends them in ten-image carousel batches", async () => {
  const root = fixture();
  const authoritySource = fs.readFileSync(path.join(root, "v9/core/media-authority.js"), "utf8");
  const outbound = fs.readFileSync(path.join(root, "v9-live-outbound-worker.js"), "utf8");
  const ai = fs.readFileSync(path.join(root, "v9-ai-shadow-worker.js"), "utf8");

  assert.match(authoritySource, /const MAX_MEDIA_ASSETS = 30/);
  assert.match(authoritySource, /AIGUKA_V9_SUPPORT_SLIDE_20_30_V1/);
  assert.match(outbound, /maxAssets: 30/);
  assert.match(outbound, /slice\(0, 30\)/);
  assert.match(outbound, /offset \+= 10/);
  assert.match(outbound, /batch_count: results\.length/);
  assert.match(outbound, /policy: "support_20_30_images"/);
  assert.match(outbound, /v9_live_outbound_support_large_slide_v4/);
  assert.match(ai, /v9_ai_support_large_slide_v7/);
  assert.match(ai, /một vài mẫu bán chạy/);
  assert.match(ai, /Bên em còn nhiều mẫu khác/);
  assert.match(ai, /để lại SĐT hoặc Zalo/);

  const module = await import(`${pathToFileURL(path.join(root, "v9/core/media-authority.js")).href}?t=${Date.now()}`);
  const assets = Array.from({ length: 35 }, (_, index) => ({
    asset_id: `fan-${index + 1}`,
    source_url: `https://example.com/fan-${index + 1}.jpg`,
    sort_order: index + 1,
  }));
  const result = module.selectAuthoritativeMedia({
    decision: {
      action: "reply_with_slides",
      output: {
        needs_slides: true,
        media_catalog_keys: ["quat_10_canh_gold"],
      },
    },
    catalog: [{
      catalog_key: "quat_10_canh_gold",
      display_name: "Quạt 10 cánh Gold",
      assets,
    }],
    maxAssets: 30,
  });
  assert.equal(result.assets.length, 30);
  assert.ok(result.assets.every((item) => item.catalog_key === "quat_10_canh_gold"));
});

test("large-slide release remains syntactically valid and idempotent", () => {
  const root = fixture();
  execFileSync(process.execPath, ["v9-support-large-slide-release-patch.js"], { cwd: root, stdio: "pipe" });
  for (const file of ["v9/core/media-authority.js", "v9-ai-shadow-worker.js", "v9-live-outbound-worker.js"]) {
    execFileSync(process.execPath, ["--check", file], { cwd: root, stdio: "pipe" });
  }
});
