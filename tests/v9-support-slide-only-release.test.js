import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "v9/core/turn-builder.js",
  "v9-direct-core-worker.js",
  "v9/core/knowledge-selector.js",
  "v9-ai-live-worker.js",
  "v9-live-outbound-worker.js",
  "v9-support-release-patch.js",
];

function installFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-v9-support-"));
  for (const relative of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), target);
  }
  fs.copyFileSync(path.join(root, "v9-ai-live-worker.js"), path.join(root, "v9-ai-shadow-worker.js"));
  execFileSync(process.execPath, ["v9-support-release-patch.js"], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, ["v9-support-release-patch.js"], { cwd: root, stdio: "pipe" });
  return root;
}

test("SUPPORT release patch installs idempotently and keeps all workers syntactically valid", () => {
  const root = installFixture();
  const turn = fs.readFileSync(path.join(root, "v9/core/turn-builder.js"), "utf8");
  const direct = fs.readFileSync(path.join(root, "v9-direct-core-worker.js"), "utf8");
  const selector = fs.readFileSync(path.join(root, "v9/core/knowledge-selector.js"), "utf8");
  const ai = fs.readFileSync(path.join(root, "v9-ai-shadow-worker.js"), "utf8");
  const outbound = fs.readFileSync(path.join(root, "v9-live-outbound-worker.js"), "utf8");

  assert.match(turn, /supportSlideOnly/);
  assert.match(turn, /!supportSlideOnly && automation/);
  assert.match(turn, /!supportSlideOnly && ambiguous/);

  assert.match(direct, /AICAKE_PRIMARY_SUPPORT/);
  assert.match(direct, /turn\.referral = latestCustomerEvent\.referral/);

  assert.ok(selector.indexOf("const adMappings") < selector.indexOf("const requestedKeys"));
  assert.match(selector, /adMappings\.flatMap/);

  assert.match(ai, /support_slide_only_v1/);
  assert.match(ai, /usedProvider = "support_rule"/);
  assert.match(ai, /support_fixed_salutation: "em-anh_chi"/);
  assert.match(ai, /Em gửi anh\/chị vài mẫu tham khảo ạ/);
  assert.ok(ai.indexOf("rawDecision = supportSlideDecision") < ai.indexOf("if (!rawDecision)"));
  assert.doesNotMatch(ai, /V9_AI_PROVIDER_NOT_READY/);

  assert.match(outbound, /AICAKE_PRIMARY_SUPPORT/);
  assert.match(outbound, /SUPPORT_SLIDE_ONLY/);
  assert.match(outbound, /SUPPORT_CATALOG_ALREADY_SENT_24H/);
  assert.match(outbound, /SUPPORT_NO_PUBLISHED_ASSET/);
  const supportBlockStart = outbound.indexOf("if (gate.supportMode)");
  const carouselAt = outbound.indexOf("sendCarousel", supportBlockStart);
  const textAt = outbound.indexOf("sendText", supportBlockStart);
  assert.ok(carouselAt > supportBlockStart && textAt > carouselAt, "SUPPORT must send carousel before fixed text");
  assert.doesNotMatch(outbound, /status: partial \? "partial"/);
});

test("SUPPORT fixed message never depends on inferred gender", () => {
  const root = installFixture();
  const ai = fs.readFileSync(path.join(root, "v9-ai-shadow-worker.js"), "utf8");
  const start = ai.indexOf("function supportSlideDecision");
  const end = ai.indexOf("async function providerCall", start);
  const support = ai.slice(start, end);
  assert.match(support, /anh\/chị/);
  assert.doesNotMatch(support, /gender|preferred_salutation|anh ấy|chị ấy/i);
});
