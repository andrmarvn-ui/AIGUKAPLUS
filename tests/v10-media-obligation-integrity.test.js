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

test("text-only bot reply does not erase unresolved media request", () => {
  const messages = [
    { role: "customer", event_type: "customer_message", text: "Cho xem mẫu trọn bộ nhà vệ sinh" },
    { role: "bot", event_type: "bot_message", text: "Dạ em gửi mẫu cho anh/chị tham khảo ạ.", attachments: [] },
    { role: "customer", event_type: "customer_message", text: "Em gửi qua đây nhé" },
  ];
  const scope = deriveMediaScope(messages, slideKeys);
  assert.deepEqual(scope, ["combo_phong_tam"]);
  assert.equal(explicitMediaRequestFromMessages(messages), true);
  assert.equal(mediaExpectedFromMessages(messages, scope), true);
});

test("delivered image clears the previous media obligation window", () => {
  const messages = [
    { role: "customer", event_type: "customer_message", text: "Cho xem mẫu trọn bộ nhà vệ sinh" },
    { role: "bot", event_type: "bot_message", text: "Dạ em gửi mẫu ạ.", attachments: [{ type: "image", source_url: "https://example.test/a.jpg" }] },
    { role: "customer", event_type: "customer_message", text: "Cảm ơn em" },
  ];
  const scope = deriveMediaScope(messages, slideKeys);
  assert.deepEqual(scope, []);
  assert.equal(explicitMediaRequestFromMessages(messages), false);
  assert.equal(mediaExpectedFromMessages(messages, scope), false);
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

test("Thanh Vương fan postback resolves the fan root even when the button title is generic", () => {
  const messages = [{
    role: "customer",
    event_type: "customer_postback",
    text: "Xem thêm các mẫu khác",
    postback: {
      title: "Xem thêm các mẫu khác",
      payload: "XEM_MAU_QUAT",
      effective_payload: "XEM_MAU_QUAT",
    },
  }];
  assert.deepEqual(deriveMediaScope(messages, slideKeys), ["quat_tran"]);
  assert.equal(explicitMediaRequestFromMessages(messages), true);
});

test("a generic inbox-sample ad reply is still an explicit media request", () => {
  const messages = customers("Inbox mẫu cho tôi");
  assert.equal(explicitMediaRequestFromMessages(messages), true);
  assert.deepEqual(deriveMediaScope(messages, slideKeys), []);
});

test("more-sample continuation inherits the last delivered catalog scope", () => {
  const messages = [
    { role: "customer", event_type: "customer_message", text: "Cho xem mẫu quạt trần" },
    {
      role: "bot",
      event_type: "bot_message",
      text: "Em gửi mẫu quạt ạ.",
      attachments: [{ type: "carousel", catalog_keys: ["quat_tran"] }],
      media_catalog_keys: ["quat_tran"],
    },
    { role: "customer", event_type: "customer_message", text: "Xem tiếp các mẫu khác" },
  ];
  assert.deepEqual(deriveMediaScope(messages, slideKeys), ["quat_tran"]);
  assert.equal(explicitMediaRequestFromMessages(messages), true);
});

test("natural continuation variants remain deterministic media requests", () => {
  for (const text of ["Gửi tiếp cho mình", "Xem nữa", "Còn loại khác không?", "Thêm ảnh nhé", "Muốn thêm mẫu"]) {
    assert.equal(explicitMediaRequestFromMessages(customers(text)), true, text);
  }
});
