import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { splitUniformBatches } from "../v9-postgrest-uniform-batch.js";

const source = fs.readFileSync(new URL("../v9-postgrest-uniform-batch.js", import.meta.url), "utf8");
const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

test("mixed object keys are split into homogeneous PostgREST batches", () => {
  const rows = [
    { ad_id: "1", page_id: "p1", updated_at: "t" },
    { ad_id: "2", page_id: "p2", updated_at: "t", first_seen_at: "t", catalog_keys: [], attributes: {} },
    { ad_id: "3", page_id: "p1", updated_at: "t" },
  ];
  const batches = splitUniformBatches(rows);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.length).sort(), [1, 2]);
  for (const batch of batches) {
    const signature = Object.keys(batch[0]).sort().join(",");
    assert.ok(batch.every((row) => Object.keys(row).sort().join(",") === signature));
  }
});

test("adapter is narrowly scoped to dim_ads upsert", () => {
  assert.match(source, /\/rest\\\/v1\\\/dim_ads\$/);
  assert.match(source, /url\.searchParams\.has\("on_conflict"\)/);
  assert.doesNotMatch(source, /v8_ads_daily_insights|v9_events|messages/);
});

test("uniform adapter installs before resolver worker starts", () => {
  const adapter = start.indexOf('await safeImport("./v9-postgrest-uniform-batch.js")');
  const resolver = start.indexOf('startDetached("./v9-meta-ad-page-resolver-worker.js")');
  assert.ok(adapter >= 0);
  assert.ok(resolver > adapter);
});
