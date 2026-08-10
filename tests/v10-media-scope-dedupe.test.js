import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MEDIA_DEDUPE_WINDOW_MS,
  mediaClaimDisposition,
  mediaScopeIdempotencyKey,
  mediaScopeMatchesAssetRefs,
} from "../v10/core/media-dedupe.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fanGroup = {
  bundle_key: "media:quat_tran",
  group_key: "quat_tran",
  catalog_keys: ["quat_10_canh"],
  assets: [
    { asset_id: "fan-gold-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_gold" },
    { asset_id: "fan-wood-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_wood" },
  ],
};

test("Nguyễn Quốc Lý contact-only follow-up matches the already delivered fan scope", () => {
  const priorBundleAssets = [
    { asset_id: "fan-gold-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_gold" },
    { asset_id: "fan-wood-1", catalog_key: "quat_10_canh", source_catalog_key: "quat_10_canh_wood" },
  ];
  assert.equal(mediaScopeMatchesAssetRefs(fanGroup, priorBundleAssets), true);

  const nowMs = Date.parse("2026-08-08T22:51:19Z");
  const disposition = mediaClaimDisposition({
    decision_id: "c4df4330-6096-42e7-8390-dc7aaf48bfe1",
    status: "sent",
    updated_at: "2026-08-08T22:49:26Z",
  }, {
    decisionId: "95de57a9-70fa-422c-964d-71d969869805",
    nowMs,
  });
  assert.equal(disposition.allowed, false);
  assert.equal(disposition.reason, "DUPLICATE_MEDIA_SCOPE_24H");
});

test("a combined earlier delivery suppresses the same catalog without blocking a different catalog", () => {
  const combined = [
    { asset_id: "fan-1", catalog_key: "quat_10_canh" },
    { asset_id: "lamp-1", catalog_key: "den_trum" },
  ];
  assert.equal(mediaScopeMatchesAssetRefs(fanGroup, combined), true);
  assert.equal(mediaScopeMatchesAssetRefs({ ...fanGroup, catalog_keys: ["quat_8_canh"] }, combined), false);
});

test("the 24h claim is recoverable after expiry and same-decision retries remain allowed", () => {
  const existing = {
    decision_id: "decision-1",
    status: "sent",
    updated_at: "2026-08-08T00:00:00Z",
  };
  assert.equal(mediaClaimDisposition(existing, {
    decisionId: "decision-1",
    nowMs: Date.parse("2026-08-08T00:01:00Z"),
  }).reason, "SAME_DECISION_RETRY");

  const expired = mediaClaimDisposition(existing, {
    decisionId: "decision-2",
    nowMs: Date.parse("2026-08-08T00:00:00Z") + MEDIA_DEDUPE_WINDOW_MS + 1,
  });
  assert.equal(expired.allowed, true);
  assert.equal(expired.takeover, true);
});

test("explicit resend requests get a decision-scoped key while automatic sends share one scope key", () => {
  const base = { pageId: "104810069068200", senderId: "27657326283949828", group: fanGroup };
  const automaticA = mediaScopeIdempotencyKey({ ...base, decisionId: "decision-a" });
  const automaticB = mediaScopeIdempotencyKey({ ...base, decisionId: "decision-b" });
  const repeat = mediaScopeIdempotencyKey({ ...base, decisionId: "decision-b", repeatRequested: true });
  assert.equal(automaticA, automaticB);
  assert.notEqual(repeat, automaticA);
  assert.match(repeat, /decision-b$/);
});

test("release loads the transport-level media claim after grouped media is installed", () => {
  const sovereign = fs.readFileSync(new URL("../patch-v10-outbound-sovereign-integrity.js", import.meta.url), "utf8");
  const patch = fs.readFileSync(new URL("../patch-v10-media-scope-dedupe.js", import.meta.url), "utf8");
  assert.ok(sovereign.indexOf("patch-v10-grouped-media-bundles.js") < sovereign.indexOf("patch-v10-media-scope-dedupe.js"));
  assert.match(patch, /resolution=ignore-duplicates,return=representation/);
  assert.match(patch, /DUPLICATE_MEDIA_SCOPE_24H/);
  assert.match(patch, /media_dedupe_fail_closed/);
  assert.match(patch, /sovereignOutboundRepeatRequested/);
  assert.match(patch, /meta_messenger_carousel/);
});

test("the complete Railway patch chain produces a syntactically valid deduping worker", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-v10-media-dedupe-"));
  const files = [
    "v10-outbound-worker.js",
    "v10-ai-worker-final.js",
    "v10-decision-queue-janitor.js",
    "v10-direct-core-worker.js",
    "v10-followup-worker.js",
    "patch-v10-general-product-sales-handoff.js",
    "patch-v10-specific-price-contact.js",
    "patch-v10-media-obligation-integrity.js",
    "patch-v10-active-intent-focus.js",
    "patch-v10-turn-merge-authority.js",
    "patch-v10-outbound-sovereign-integrity.js",
    "patch-v10-live-page-reply-guard.js",
    "patch-v10-support-salutation.js",
    "patch-v10-grouped-media-bundles.js",
    "patch-v10-direct-core-structured-input.js",
    "patch-v10-media-delivery-proxy.js",
    "patch-v10-media-scope-dedupe.js",
    "v10/core/media-dedupe.js",
    "v10/core/media-obligation.js",
    "v10/core/decision-contract.js",
  ];
  for (const relative of files) {
    const target = path.join(temp, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), target);
  }

  const patchRun = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    'await import("./patch-v10-general-product-sales-handoff.js"); await import("./patch-v10-media-obligation-integrity.js"); await import("./patch-v10-active-intent-focus.js"); await import("./patch-v10-turn-merge-authority.js"); await import("./patch-v10-outbound-sovereign-integrity.js");',
  ], { cwd: temp, encoding: "utf8", timeout: 30_000 });
  assert.equal(patchRun.status, 0, `${patchRun.stdout}\n${patchRun.stderr}`);

  const generated = path.join(temp, "v10-outbound-worker.js");
  const syntax = spawnSync(process.execPath, ["--check", generated], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
  const worker = fs.readFileSync(generated, "utf8");
  assert.match(worker, /v10_outbound_media_scope_dedupe_v13/);
  assert.match(worker, /DUPLICATE_MEDIA_SCOPE_24H/);
  assert.match(worker, /mediaDedupe\.by_bundle_key/);
  const aiWorker = fs.readFileSync(path.join(temp, "v10-ai-worker-final.js"), "utf8");
  assert.match(aiWorker, /AIGUKA_V10_MEDIA_OBLIGATION_INTEGRITY_V1/);
  assert.match(aiWorker, /AIGUKA_V10_ACTIVE_INTENT_FOCUS_V1/);
  assert.match(aiWorker, /explicit_media_backlog_first/);
});

test("all natural more-sample phrases bypass the 24h scope lock", () => {
  const sovereign = fs.readFileSync(new URL("../patch-v10-outbound-sovereign-integrity.js", import.meta.url), "utf8");
  for (const phrase of ["xem them", "xem tiep", "xem nua", "gui tiep", "mau khac", "anh khac", "them mau", "can them mau", "mau nua", "con loai"]) {
    assert.match(sovereign, new RegExp(phrase));
  }
});
