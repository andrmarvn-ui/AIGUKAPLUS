import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildKnowledgeAdvisors } from "../v10/core/knowledge-advisor.js";

test("broad ad mapping publishes curated fallback catalogs into the AI advisor", () => {
  const snapshot = {
    content: {
      catalog: [
        { catalog_key: "combo_phong_tam", display_name: "Combo phòng tắm", aliases: ["nhà tắm"], assets: [{ source_url: "https://example.test/bath.jpg" }] },
        { catalog_key: "bep_tu_hut_mui", display_name: "Bếp từ hút mùi", aliases: ["nhà bếp"], assets: [{ source_url: "https://example.test/kitchen.jpg" }] },
      ],
      ad_mappings: [{
        ad_id: "120245615010400424",
        catalog_keys: ["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat", "bon_cau"],
        confidence: 0.95,
        is_active: true,
        metadata: { fallback_catalog_keys: ["combo_phong_tam", "bep_tu_hut_mui"] },
      }],
    },
  };
  const conversation = {
    messages: [{ role: "customer", text: "Inbox mẫu cho tôi" }],
    referral: { ad_id: "120245615010400424", source: "ADS" },
    advisors: { product_candidates: [] },
  };

  const advisors = buildKnowledgeAdvisors(snapshot, conversation, { maxCatalog: 12 });
  assert.deepEqual(advisors.ad_mappings[0].fallback_catalog_keys, ["combo_phong_tam", "bep_tu_hut_mui"]);
  assert.deepEqual(advisors.slide_catalog.map((item) => item.catalog_key), ["combo_phong_tam", "bep_tu_hut_mui"]);
});

test("media obligation runtime contains a high-confidence mapping fallback", () => {
  const patch = fs.readFileSync(new URL("../patch-v10-media-obligation-integrity.js", import.meta.url), "utf8");
  assert.match(patch, /fallback_catalog_keys/);
  assert.match(patch, /mappings\.length !== 1/);
  assert.match(patch, /explicitMediaRequestFromMessages/);
  assert.equal(patch.includes("catalog_keys.length <= 3"), false);
});
