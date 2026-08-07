import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveMediaScope,
  explicitMediaRequestFromMessages,
  mediaExpectedFromMessages,
} from "../v10/core/media-obligation.js";

const slideKeys = new Set([
  "combo_phong_tam",
  "bon_cau",
  "bon_cau_lien_khoi",
  "bon_cau_thong_minh",
  "lavabo",
  "bep_tu_hut_mui",
  "chau_voi_rua_bat",
  "gach_ngoi",
  "gach_80x80",
  "gach_an_do",
  "gach_tay_ban_nha",
  "gach_stone",
  "quat_tran",
  "quat_8_canh_gold",
  "quat_8_canh_black",
  "quat_8_canh_brown",
  "quat_8_canh_wood",
]);

function customers(...texts) {
  return texts.map((text) => ({ role: "customer", event_type: "customer_message", text }));
}

test("bathroom chậu rửa is lavabo, not kitchen sink", () => {
  const messages = customers("Mình muốn thay 02 phòng tắm gồm 02 bệt và 02 chậu rửa. Cho xem mẫu giúp.");
  const scope = deriveMediaScope(messages, slideKeys);
  assert.deepEqual(scope, ["bon_cau", "lavabo"]);
  assert.equal(explicitMediaRequestFromMessages(messages), true);
  assert.equal(mediaExpectedFromMessages(messages, scope), true);
});

test("kitchen sink remains kitchen catalog", () => {
  const scope = deriveMediaScope(customers("Cho xem mẫu chậu vòi rửa bát cho nhà bếp"), slideKeys);
  assert.ok(scope.includes("chau_voi_rua_bat"));
  assert.equal(scope.includes("lavabo"), false);
});

test("rapid multi-product postbacks preserve tile plus bath and kitchen", () => {
  const messages = [
    { role: "customer", event_type: "customer_postback", text: "Tư vấn nội thất nhà mới" },
    { role: "customer", event_type: "customer_postback", text: "Tư vấn gạch ốp lát" },
    { role: "customer", event_type: "customer_postback", text: "Tư vấn nhà tắm/nhà bếp..." },
  ];
  const scope = deriveMediaScope(messages, slideKeys);
  assert.ok(scope.includes("combo_phong_tam"));
  assert.ok(scope.includes("bep_tu_hut_mui"));
  assert.ok(scope.includes("chau_voi_rua_bat"));
  assert.ok(scope.includes("gach_ngoi"));
  assert.equal(mediaExpectedFromMessages(messages, scope), true);
});

test("explicit typo image request is still a media obligation", () => {
  const messages = customers(
    "Tôi muốn trọn bộ nhà vs hàng chính hãng giá rẻ + gạch lát nền giá rẻ",
    "Sốp cho xin giá nhà vs + các mẫu gạch lát nền",
    "gửi ảh qua đây cũng duọc mà",
  );
  const scope = deriveMediaScope(messages, slideKeys);
  assert.deepEqual(scope, ["combo_phong_tam", "gach_ngoi"]);
  assert.equal(explicitMediaRequestFromMessages(messages), true);
  assert.equal(mediaExpectedFromMessages(messages, scope), true);
});

test("contact and location do not erase unresolved multi-product scope", () => {
  const messages = customers(
    "Tư vấn nhà tắm/nhà bếp...",
    "Com bo nhà bếp",
    "Làm mới bếp a",
    "E đang xây nhà",
    "Em gửi số liên hệ rồi nhé",
    "Ở Quảng Bình",
  );
  const scope = deriveMediaScope(messages, slideKeys);
  assert.ok(scope.includes("combo_phong_tam"));
  assert.ok(scope.includes("bep_tu_hut_mui"));
  assert.ok(scope.includes("chau_voi_rua_bat"));
  assert.equal(mediaExpectedFromMessages(messages, scope), true);
});

test("common Quant tran typo still resolves exact 8-canh gold slide", () => {
  const messages = customers("Xin mẫu? Giá?", "Quant trần?", "8 cánh, vàng");
  const scope = deriveMediaScope(messages, slideKeys);
  assert.deepEqual(scope, ["quat_8_canh_gold"]);
  assert.equal(explicitMediaRequestFromMessages(messages), true);
  assert.equal(mediaExpectedFromMessages(messages, scope), true);
});

test("unrelated address-only turn does not force media", () => {
  const messages = customers("Showroom ở đâu vậy?");
  const scope = deriveMediaScope(messages, slideKeys);
  assert.deepEqual(scope, []);
  assert.equal(mediaExpectedFromMessages(messages, scope), false);
});
