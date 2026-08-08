import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationContext } from "../v10/core/conversation-assembler.js";
import { deriveMediaScope } from "../v10/core/media-obligation.js";
import { deriveProductThreads, planMediaBundles } from "../v10/core/product-threads.js";

function event(id, text, occurredAt, eventType = "customer_message", postback = null) {
  return {
    source_event_id: id,
    actor_type: "customer",
    event_type: eventType,
    message_text: text,
    attachments: [],
    referral: {},
    payload: postback ? { raw_payload: { postback } } : {},
    occurred_at: occurredAt,
    received_at: occurredAt,
  };
}

test("rapid same-menu postback keeps history but supersedes the earlier structured choice", () => {
  const context = buildConversationContext([
    event(
      "e1",
      "Tư vấn nhà tắm/nhà bếp...",
      "2026-08-08T08:44:06.654Z",
      "customer_postback",
      { title: "Tư vấn nhà tắm/nhà bếp...", payload: "XEM_NHA_TAM" },
    ),
    event(
      "e2",
      "Tư vấn gạch ốp lát",
      "2026-08-08T08:44:07.440Z",
      "customer_postback",
      { title: "Tư vấn gạch ốp lát", payload: "XEM_NHA_BEP" },
    ),
  ]);

  assert.equal(context.valid, true);
  assert.equal(context.messages[0].semantic_status, "superseded");
  assert.equal(context.messages[0].semantic_relation, "REPLACED_BY_STRUCTURED_CHOICE");
  assert.equal(context.messages[1].semantic_status, "active");
  assert.equal(context.messages[1].semantic_relation, "REPLACE");
  assert.equal(context.messages[1].postback.effective_payload, "XEM_GACH_OP_LAT");
  assert.equal(context.messages[1].postback.payload_title_mismatch, true);
  assert.equal(context.input_semantics.superseded_structured_choices, 1);
  assert.equal(context.input_semantics.payload_title_mismatches, 2);

  const scope = deriveMediaScope(
    context.messages,
    new Set(["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat", "gach_ngoi"]),
  );
  assert.deepEqual(scope, ["gach_ngoi"]);
});

test("ordinary free text remains additive instead of latest-message-wins", () => {
  const context = buildConversationContext([
    event("t1", "xem nhà tắm", "2026-08-08T10:00:00.000Z"),
    event("t2", "nhà bếp nữa", "2026-08-08T10:00:01.000Z"),
    event("t3", "gạch ốp lát nữa", "2026-08-08T10:00:02.000Z"),
  ]);
  assert.equal(context.messages[1].semantic_relation, "ADD");
  assert.equal(context.messages[2].semantic_relation, "ADD");

  const scope = deriveMediaScope(
    context.messages,
    new Set(["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat", "gach_ngoi"]),
  );
  assert.deepEqual(new Set(scope), new Set(["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat", "gach_ngoi"]));
});

test("explicit replace starts a new product scope", () => {
  const context = buildConversationContext([
    event("r1", "xem nhà tắm và nhà bếp", "2026-08-08T10:10:00.000Z"),
    event("r2", "chỉ xem gạch ốp lát thôi", "2026-08-08T10:10:03.000Z"),
  ]);
  assert.equal(context.messages[1].semantic_relation, "REPLACE");
  const scope = deriveMediaScope(
    context.messages,
    new Set(["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat", "gach_ngoi"]),
  );
  assert.deepEqual(scope, ["gach_ngoi"]);
});

test("explicit cancel removes only the cancelled product group", () => {
  const context = buildConversationContext([
    event("c1", "xem nhà tắm", "2026-08-08T10:20:00.000Z"),
    event("c2", "nhà bếp nữa", "2026-08-08T10:20:01.000Z"),
    event("c3", "không cần nhà bếp nữa", "2026-08-08T10:20:03.000Z"),
  ]);
  assert.equal(context.messages[2].semantic_relation, "CANCEL");
  const scope = deriveMediaScope(
    context.messages,
    new Set(["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat"]),
  );
  assert.deepEqual(scope, ["combo_phong_tam"]);
});

test("8-blade and 10-blade fan requests are both preserved", () => {
  const context = buildConversationContext([
    event("f1", "xem quạt 8 cánh và quạt 10 cánh", "2026-08-08T11:00:00.000Z"),
  ]);
  const scope = deriveMediaScope(
    context.messages,
    new Set(["quat_8_canh", "quat_10_canh", "quat_tran"]),
  );
  assert.ok(scope.includes("quat_8_canh"));
  assert.ok(scope.includes("quat_10_canh"));
});

test("product threads and media bundles stay separate by broad product group", () => {
  const knowledge = {
    catalog: [
      { catalog_key: "phong_tam", display_name: "Phòng tắm", parent_key: null },
      { catalog_key: "combo_phong_tam", display_name: "Combo phòng tắm", parent_key: "phong_tam" },
      { catalog_key: "phong_bep", display_name: "Phòng bếp", parent_key: null },
      { catalog_key: "bep_tu_hut_mui", display_name: "Bếp từ / máy hút mùi", parent_key: "phong_bep" },
      { catalog_key: "chau_voi_rua_bat", display_name: "Chậu vòi rửa bát", parent_key: "phong_bep" },
      { catalog_key: "gach_ngoi", display_name: "Gạch ngói", parent_key: null },
      { catalog_key: "quat_tran", display_name: "Quạt trần", parent_key: null },
      { catalog_key: "quat_10_canh", display_name: "Quạt 10 cánh", parent_key: "quat_tran" },
    ],
  };
  const unresolved = [
    { topic: "Phòng tắm", status: "pending_media", catalog_keys: ["combo_phong_tam"] },
    { topic: "Bếp", status: "pending_media", catalog_keys: ["bep_tu_hut_mui"] },
    { topic: "Chậu vòi", status: "pending_media", catalog_keys: ["chau_voi_rua_bat"] },
    { topic: "Gạch", status: "pending_media", catalog_keys: ["gach_ngoi"] },
    { topic: "Quạt", status: "pending_media", catalog_keys: ["quat_10_canh"] },
  ];

  const threads = deriveProductThreads(unresolved, knowledge);
  assert.deepEqual(new Set(threads.map((item) => item.group_key)), new Set(["phong_tam", "phong_bep", "gach_op_lat", "quat_tran"]));
  const kitchen = threads.find((item) => item.group_key === "phong_bep");
  assert.deepEqual(new Set(kitchen.catalog_keys), new Set(["bep_tu_hut_mui", "chau_voi_rua_bat"]));

  const bundles = planMediaBundles(
    threads,
    ["combo_phong_tam", "bep_tu_hut_mui", "chau_voi_rua_bat", "gach_ngoi", "quat_10_canh"],
    knowledge,
  );
  assert.equal(bundles.length, 4);
  assert.deepEqual(new Set(bundles.map((item) => item.group_key)), new Set(["phong_tam", "phong_bep", "gach_op_lat", "quat_tran"]));
  assert.deepEqual(
    new Set(bundles.find((item) => item.group_key === "phong_bep").catalog_keys),
    new Set(["bep_tu_hut_mui", "chau_voi_rua_bat"]),
  );
});
