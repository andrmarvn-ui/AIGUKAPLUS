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
  assert.deepEqual(result.product_candidates.map((item) => item.key), ["phong_bep"]);
});

test("production advisor preserves high-confidence product evidence used by media obligations", () => {
  const snapshot = {
    content: {
      documents: [],
      ad_mappings: [],
      catalog: [{
        catalog_key: "quat_10_canh_gold",
        display_name: "Quạt 10 cánh màu vàng",
        aliases: ["quạt vàng 10 cánh"],
        assets: [{ asset_id: "fan-1", source_url: "https://example.test/fan-1.jpg", sort_order: 1 }],
      }],
    },
  };
  const conversation = {
    messages: [
      { id: "event:samples", role: "customer", text: "Gui mẩu a chọn voi" },
      { id: "event:refine", role: "customer", text: "10\nCanh mà vàng" },
    ],
    advisors: {
      product_candidates: [{
        key: "quat_10_canh",
        label: "quạt trần 10 cánh",
        confidence: 0.92,
        sources: ["customer_message", "ad_referral"],
        evidence: [{ message_id: "event:refine", text: "10\nCanh mà vàng" }],
      }],
    },
  };

  const result = buildKnowledgeAdvisors(snapshot, conversation, { maxCatalog: 10 });
  assert.equal(result.product_candidates[0].key, "quat_10_canh");
  assert.equal(result.product_candidates[0].confidence, 0.92);
  assert.deepEqual(result.product_candidates[0].evidence, [{
    message_id: "event:refine",
    text: "10\nCanh mà vàng",
    occurred_at: null,
  }]);
});

test("address intent prioritizes the verified location document", () => {
  const snapshot = {
    content: {
      documents: [
        { document_key: "generic", title: "Sản phẩm", content: "Nhiều mẫu sản phẩm khác nhau." },
        { document_key: "location", title: "Địa chỉ showroom", content: "Showroom tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội." },
      ],
      ad_mappings: [],
      catalog: [],
    },
  };
  const conversation = {
    messages: [{ role: "customer", text: "Cửa hàng ở đâu vậy?" }],
    advisors: { product_candidates: [], intent_candidates: [{ key: "address" }] },
  };
  const result = buildKnowledgeAdvisors(snapshot, conversation, { maxDocuments: 1 });
  assert.equal(result.documents[0].document_key, "location");
  assert.match(result.documents[0].content, /254 Phố Keo/);
});
