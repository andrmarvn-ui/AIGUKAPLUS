import test from "node:test";
import assert from "node:assert/strict";
import { selectKnowledgeContext } from "../v9/core/knowledge-selector.js";

const snapshot = {
  id: "snapshot-1",
  version_no: 7,
  checksum: "abc123",
  content: {
    documents: [
      { document_key: "global_policy", version_no: 2, document_type: "business_policy", page_id: null, title: "Quy tắc chung", content: "Trả lời đúng nhu cầu rồi xin SĐT/Zalo.", status: "published", priority: 10 },
      { document_key: "page_address", version_no: 3, document_type: "location", page_id: "page-1", title: "Địa chỉ showroom", content: "Showroom tại 254 Phố Keo, Gia Lâm.", status: "published", priority: 5 },
      { document_key: "other_page", version_no: 1, document_type: "context", page_id: "page-2", title: "Trang khác", content: "Không được chọn", status: "published", priority: 1 },
      { document_key: "draft_prompt", version_no: 9, document_type: "system_prompt", page_id: null, title: "Bản thử", content: "Không được đưa vào model", status: "draft", priority: 1 },
      { document_key: "archived", version_no: 1, document_type: "promotion", page_id: null, title: "Cũ", content: "Không dùng", status: "archived", priority: 1 },
    ],
    catalog: [
      { catalog_key: "bon_cau", root_key: "bon_cau", display_name: "Bồn cầu", node_type: "product_group", aliases: ["toilet"], assets: Array.from({ length: 10 }, (_, i) => ({ asset_id: `b-${i}`, source_url: `https://x/${i}.jpg`, sort_order: i })) },
      { catalog_key: "bep_tu_hut_mui", root_key: "bep_tu_hut_mui", display_name: "Bếp từ hút mùi", node_type: "product_group", aliases: ["bếp"], assets: [{ asset_id: "k-1", source_url: "https://x/k.jpg", sort_order: 0 }] },
      { catalog_key: "quat_tran", root_key: "quat_tran", display_name: "Quạt trần", node_type: "product_group", aliases: [], assets: [] },
    ],
    ad_mappings: [
      { page_id: "*", ad_id: "ad-1", catalog_keys: ["bon_cau"], confidence: 1, is_active: true, metadata: { source: "legacy" } },
      { page_id: "*", ad_id: "ad-2", catalog_keys: ["quat_tran"], confidence: 1, is_active: true },
    ],
  },
};

function decisionInput(overrides = {}) {
  const { turn: turnOverrides = {}, ...rest } = overrides;
  return {
    page_id: "page-1",
    turn: {
      combinedText: "Cho xin địa chỉ và mẫu bồn cầu, bếp từ",
      salesSignals: { intents: ["address", "samples"], products: ["bon_cau", "bep_tu_hut_mui"] },
      ...turnOverrides,
    },
    ...rest,
  };
}

test("selects page and global published documents only", () => {
  const selected = selectKnowledgeContext(snapshot, decisionInput());
  assert.deepEqual(selected.documents.map((item) => item.document_key), ["page_address", "global_policy"]);
  assert.ok(!selected.documents.some((item) => item.document_key === "other_page"));
  assert.ok(!selected.documents.some((item) => item.document_key === "draft_prompt"));
  assert.ok(!selected.documents.some((item) => item.document_key === "archived"));
});

test("preserves multiple requested product groups and excludes unrelated products", () => {
  const selected = selectKnowledgeContext(snapshot, decisionInput());
  assert.deepEqual(selected.catalog.map((item) => item.catalog_key), ["bon_cau", "bep_tu_hut_mui"]);
  assert.ok(!selected.catalog.some((item) => item.catalog_key === "quat_tran"));
});

test("caps assets per catalog node", () => {
  const selected = selectKnowledgeContext(snapshot, decisionInput(), { maxAssetsPerNode: 3 });
  assert.equal(selected.catalog.find((item) => item.catalog_key === "bon_cau").assets.length, 3);
});

test("selects only the exact referral ad mapping", () => {
  const selected = selectKnowledgeContext(snapshot, decisionInput({ referral: { ad_id: "ad-1" } }));
  assert.equal(selected.ad_mappings.length, 1);
  assert.equal(selected.ad_mappings[0].ad_id, "ad-1");
});

test("does not copy contact fields into knowledge context", () => {
  const selected = selectKnowledgeContext(snapshot, decisionInput({ customer: { phone: "0965499803", zalo: "0965499803" } }));
  const serialized = JSON.stringify(selected);
  assert.doesNotMatch(serialized, /0965499803/);
});

test("selection is deterministic", () => {
  const a = selectKnowledgeContext(snapshot, decisionInput());
  const b = selectKnowledgeContext(snapshot, decisionInput());
  assert.deepEqual(a, b);
});
