import test from "node:test";
import assert from "node:assert/strict";
import { deriveUnresolvedNeeds } from "../v10/core/unresolved-needs.js";

const advisors = {
  catalog: [
    { catalog_key: "combo_phong_tam", display_name: "Combo phòng tắm", asset_count: 12 },
    { catalog_key: "bep_tu_hut_mui", display_name: "Bếp từ / máy hút mùi", asset_count: 8 },
    { catalog_key: "chau_voi_rua_bat", display_name: "Chậu vòi rửa bát", asset_count: 9 },
  ],
  slide_catalog: [
    { catalog_key: "combo_phong_tam", display_name: "Combo phòng tắm", asset_count: 12 },
    { catalog_key: "bep_tu_hut_mui", display_name: "Bếp từ / máy hút mùi", asset_count: 8 },
    { catalog_key: "chau_voi_rua_bat", display_name: "Chậu vòi rửa bát", asset_count: 9 },
  ],
};

test("phone and location do not erase pending bathroom and kitchen media needs", () => {
  const conversation = {
    messages: [
      { role: "customer", event_type: "customer_message", text: "Cho xem mẫu trọn bộ phòng tắm và nhà bếp" },
      { role: "customer", event_type: "customer_message", text: "Gửi mẫu qua đây nhé" },
      { role: "customer", event_type: "customer_message", text: "0988123456" },
      { role: "customer", event_type: "customer_message", text: "Anh ở Bắc Giang" },
    ],
  };
  const needs = deriveUnresolvedNeeds(conversation, advisors);
  const mediaKeys = new Set(needs.filter((need) => need.status === "pending_media").flatMap((need) => need.catalog_keys));
  assert.ok(mediaKeys.has("combo_phong_tam"));
  assert.ok(mediaKeys.has("bep_tu_hut_mui"));
  assert.ok(mediaKeys.has("chau_voi_rua_bat"));
});

test("delivered media clears old product media obligation", () => {
  const conversation = {
    messages: [
      { role: "customer", event_type: "customer_message", text: "Cho xem mẫu phòng tắm" },
      { role: "bot", event_type: "bot_message", text: "Dạ em gửi mẫu ạ", attachments: [{ type: "image", source_url: "https://example.test/a.jpg" }] },
      { role: "customer", event_type: "customer_message", text: "Cảm ơn em" },
    ],
  };
  const needs = deriveUnresolvedNeeds(conversation, advisors);
  assert.equal(needs.some((need) => need.status === "pending_media"), false);
});
