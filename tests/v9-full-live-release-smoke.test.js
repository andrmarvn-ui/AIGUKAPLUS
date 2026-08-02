import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const FILES = [
  "v9-live-release-patch.js",
  "v9-support-release-patch.js",
  "v9-support-fast-vision-release-patch.js",
  "v9-support-sample-ai-release-patch.js",
  "v9-media-authority-release-patch.js",
  "v9-support-large-slide-release-patch.js",
  "v9-root-conversation-architecture-release-patch.js",
  "v9-no-drop-release-patch.js",
  "v9-semantic-product-lock-release-patch.js",
  "v8-v9-mode-sync-worker.js",
  "v9-direct-core-worker.js",
  "v9-ai-live-worker.js",
  "v9-live-outbound-worker.js",
  "v9/core/contact-detector.js",
  "v9/core/turn-builder.js",
  "v9/core/conversation-intelligence.js",
  "v9/core/semantic-conversation-intelligence.js",
  "v9/core/semantic-conversation-intelligence-v2.js",
  "v9/core/semantic-decision-policy.js",
  "v9/core/semantic-decision-policy-v2.js",
  "v9/core/knowledge-selector.js",
  "v9/core/knowledge-selector-v2.js",
  "v9/core/decision-contract.js",
  "v9/core/decision-contract-v2.js",
  "v9/core/media-authority.js",
];

function copy(root, temp, relative) {
  const target = path.join(temp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}

test("full V9 live release exits cleanly and emits final worker versions", () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-full-release-"));
  for (const relative of FILES) copy(root, temp, relative);

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("./v9-live-release-patch.js")'],
    {
      cwd: temp,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        RAILWAY_GIT_COMMIT_SHA: "ci-full-release-smoke",
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        AIGUKA_V9_CORE_URL: "",
        AIGUKA_V9_CORE_SERVICE_ROLE_KEY: "",
      },
    },
  );

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.signal, null, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /AIGUKA_V9_LIVE_RELEASE_V8_VERIFIED_FEATURES installed/);

  const ai = fs.readFileSync(path.join(temp, "v9-ai-shadow-worker.js"), "utf8");
  const direct = fs.readFileSync(path.join(temp, "v9-direct-core-worker.js"), "utf8");
  const outbound = fs.readFileSync(path.join(temp, "v9-live-outbound-worker.js"), "utf8");

  assert.match(ai, /v9_ai_multi_product_plan_v13/);
  assert.match(direct, /v9_direct_multi_product_plan_v5/);
  assert.match(outbound, /v9_live_outbound_no_drop_v5/);
  assert.match(ai, /function supportImageUrls/);
  assert.match(ai, /function supportTextInstructions/);
  assert.match(ai, /enforceSemanticProductLock/);
  assert.match(direct, /semantic-conversation-intelligence-v2/);
  assert.match(outbound, /truthfulTextFallback/);
  assert.match(outbound, /policy: "support_20_30_images"/);
});
