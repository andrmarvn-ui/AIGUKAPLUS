import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeAdvisors } from "../v10/core/knowledge-advisor.js";

test("parent catalog inherits child assets without selecting only one child", () => {
  const snapshot = {
    content: {
      documents: [],
      ad_mappings: [],
      catalog: [
        {
          catalog_key: "phong_bep",
          display_name: "Phòng bếp",
          aliases: ["nhà bếp"],
          assets: [],
        },
        {
          catalog_key: "bep_tu_hut_mui",
          display_name: "Bếp từ hút mùi",
          parent_key: "phong_bep",
          root_key: "phong_bep",
          assets: [{ asset_id: "a", source_url: "https://example.test/a.jpg", sort_order: 1 }],
        },
        {
          catalog_key: "chau_voi_rua_bat",
          display_name: "Chậu vòi rửa bát",
          parent_key: "phong_bep",
          root_key: "phong_bep",
          assets: [{ asset_id: "b", source_url: "https://example.test/b.jpg", sort_order: 1 }],
        },
      ],
    },
  };
  const conversation = {
    messages: [{ role: "customer", text: "Cho xem mẫu phòng bếp nhà bếp" }],
    advisors: { product_candidates: [{ key: "phong_bep" }] },
  };
  const result = buildKnowledgeAdvisors(snapshot, conversation, { maxCatalog: 10, maxAssetsPerCatalog: 10 });
  const parent = result.catalog.find((item) => item.catalog_key === "phong_bep");
  assert.ok(parent);
  assert.equal(parent.recursive_assets, true);
  assert.equal(parent.own_asset_count, 0);
  assert.equal(parent.asset_count, 2);
  assert.deepEqual(new Set(parent.assets.map((asset) => asset.source_catalog_key)), new Set(["bep_tu_hut_mui", "chau_voi_rua_bat"]));
  assert.ok(result.slide_catalog.some((item) => item.catalog_key === "phong_bep"));
});
