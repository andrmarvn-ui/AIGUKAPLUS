import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { __private__ } from "../v10-mode-compat-worker.js";

const worker = fs.readFileSync("v10-mode-compat-worker.js", "utf8");
const start = fs.readFileSync("start.js", "utf8");

test("legacy SUPPORT maps to AICAKE-primary V10 support", () => {
  const target = __private__.targetForPage({
    page_id: "p1",
    page_name: "Page 1",
    bot_mode: "SUPPORT",
    is_active: true,
    updated_at: "2026-08-06T00:00:00Z",
  }, { page_id: "p1", settings: {} });
  assert.equal(target.operating_mode, "SUPPORT");
  assert.equal(target.coexistence_mode, "AICAKE_ACTIVE");
  assert.equal(target.settings.primary_bot, "AICAKE");
  assert.equal(target.settings.assistant_bot, "AIGUKA");
  assert.equal(target.settings.support_scope, "SLIDE_ONLY");
});

test("unchanged mode does not create a database write every poll", () => {
  const legacy = {
    page_id: "p1",
    page_name: "Page 1",
    bot_mode: "PRODUCTION",
    is_active: true,
    updated_at: "2026-08-06T00:00:00Z",
  };
  const initial = __private__.targetForPage(legacy, { page_id: "p1", settings: {} });
  const current = {
    page_id: "p1",
    ...initial,
    settings: { ...initial.settings, mode_compat_synced_at: "2026-08-06T00:01:00Z" },
  };
  const next = __private__.targetForPage(legacy, current);
  assert.equal(__private__.pageNeedsUpdate(current, next), false);
});

test("startup uses V10 compatibility worker and permanently retires V8 customer workers", () => {
  assert.match(start, /startDetached\("\.\/v10-mode-compat-worker\.js"\)/);
  assert.doesNotMatch(start, /startDetached\("\.\/v8-v9-mode-sync-worker\.js"\)/);
  assert.doesNotMatch(start, /startDetached\("\.\/ai-dispatch-worker\.js"\)/);
  assert.doesNotMatch(start, /startDetached\("\.\/outbound-worker\.js"\)/);
  assert.match(start, /legacy customer workers are permanently retired/);
});

test("V10 compatibility worker has valid JavaScript syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "v10-mode-compat-worker.js"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(worker, /writes_suppressed_when_unchanged/);
  assert.match(worker, /outbound_enabled: false/);
});
