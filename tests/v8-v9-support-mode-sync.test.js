import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const worker = fs.readFileSync("v8-v9-mode-sync-worker.js", "utf8");
const release = fs.readFileSync("v9-live-release-patch.js", "utf8");

test("V8 SUPPORT continuously maps to AICAKE-primary V9 support", () => {
  assert.match(worker, /operating_mode/);
  assert.match(worker, /AICAKE_ACTIVE/);
  assert.match(worker, /AICAKE_PRIMARY_SUPPORT/);
  assert.match(worker, /support_scope:\s*support \? "SLIDE_ONLY"/);
  assert.match(worker, /SUPPORT wins globally to prevent AIGUKA text interference/);
});

test("mode sync worker is loaded by the V9 release patch", () => {
  assert.match(release, /await import\("\.\/v8-v9-mode-sync-worker\.js"\)/);
});

test("mode sync worker has valid JavaScript syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "v8-v9-mode-sync-worker.js"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
