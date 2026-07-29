import test from "node:test";
import assert from "node:assert/strict";
import { filterScopedDimAds } from "../v9-postgrest-uniform-batch.js";

test("legacy ad rows without verified Page are excluded from Reporting dimension", () => {
  const rows = [
    { ad_id: "legacy-unscoped", page_id: null, attributes: { source: "legacy_v8_refresh" } },
    { ad_id: "legacy-scoped", page_id: "104810069068200", attributes: { source: "legacy_v8_refresh" } },
    { ad_id: "meta-scoped", page_id: "985632314640803", attributes: { source: "meta_creative_page_resolver" } },
  ];
  assert.deepEqual(filterScopedDimAds(rows).map((row) => row.ad_id), ["legacy-scoped", "meta-scoped"]);
});

test("Meta-resolved ad rows are never filtered", () => {
  const rows = [{ ad_id: "1", page_id: "985632314640803", attributes: {} }];
  assert.equal(filterScopedDimAds(rows).length, 1);
});
