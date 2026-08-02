import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationTurn } from "../v9/core/conversation-intelligence.js";
import { selectKnowledgeContext } from "../v9/core/knowledge-selector-v2.js";
import { validateDecision } from "../v9/core/decision-contract-v2.js";

function ev(seconds, message_text, extra = {}) {
  return {
    source_event_id: `e${seconds}`,
    event_type: "customer_message",
    occurred_at: new Date(1_700_000_000_000 + seconds * 1000).toISOString(),
    message_text,
    ...extra,
  };
}

test("keeps kitchen product context across a gap larger than the active turn", () => {
  const events = [
    ev(0, "Tư vấn mình bếp điện", { referral: { ad_id: "ad1", source: "ADS" } }),
    ev(60, "Tư vấn mình bếp 3 từ"),
    ev(164, "Mình chưa đo được"),
    ev(198, "Cho xem"),
  ];
  const turn = buildConversationTurn(events, { maxGapSeconds: 90, contextMaxMinutes: 45 });
  assert.equal(turn.combinedText, "Mình chưa đo được\nCho xem");
  assert.match(turn.contextText, /bếp 3 từ/);
  assert.deepEqual(turn.salesSignals.products, ["bep_tu_hut_mui"]);
  assert.ok(turn.salesSignals.intents.includes("samples"));
  assert.equal(turn.salesSignals.productSource, "recent_customer_context");
});

test("natural kitchen photo request is recognized as samples", () => {
  const turn = buildConversationTurn([ev(0, "Có chụp chị xem bếp được không")], {});
  assert.deepEqual(turn.salesSignals.products, ["bep_tu_hut_mui"]);
  assert.ok(turn.salesSignals.intents.includes("samples"));
});

test("sink wording does not create a second generic kitchen product", () => {
  const turn = buildConversationTurn([ev(0, "Cho xem bồn rửa bếp")], {});
  assert.deepEqual(turn.salesSignals.products, ["chau_voi_rua_bat"]);
});

test("address plus visit is not misclassified as sample request", () => {
  const turn = buildConversationTurn([ev(0, "Cho mình địa chỉ đến xem")], {});
  assert.ok(turn.salesSignals.intents.includes("address"));
  assert.ok(turn.salesSignals.intents.includes("visit"));
  assert.ok(!turn.salesSignals.intents.includes("samples"));
});

test("bare view request can use persisted product memory", () => {
  const turn = buildConversationTurn([ev(0, "Cho xem")], { customer: { last_product_key: "bep_tu_hut_mui" } });
  assert.deepEqual(turn.salesSignals.products, ["bep_tu_hut_mui"]);
  assert.ok(turn.salesSignals.intents.includes("samples"));
  assert.equal(turn.salesSignals.productSource, "customer_memory");
});

test("support mode does not treat AIcake automation as human takeover", () => {
  const events = [
    ev(0, "Cho xem mẫu bếp"),
    {
      source_event_id: "a1",
      event_type: "automation_message",
      occurred_at: new Date(1_700_000_001_000).toISOString(),
    },
  ];
  const turn = buildConversationTurn(events, { coexistenceMode: "AICAKE_ACTIVE", supportSlideOnly: true });
  assert.equal(turn.action, "needs_ai_decision");
});

test("knowledge selector uses latest document version and customer context", () => {
  const snapshot = {
    id: "s1",
    version_no: 3,
    checksum: "x",
    content: {
      documents: [
        { document_key: "location", version_no: 2, document_type: "location", page_id: "p1", title: "old", content: "một địa chỉ", status: "published", priority: 0, created_at: "2026-07-21T00:00:00Z" },
        { document_key: "location", version_no: 11, document_type: "location", page_id: null, title: "new", content: "bốn cơ sở mới", status: "published", priority: 5, created_at: "2026-07-24T00:00:00Z" },
      ],
      catalog: [
        { catalog_key: "bep_tu_hut_mui", display_name: "Bếp từ / máy hút mùi", aliases: ["bếp", "bếp điện", "bếp 3 từ"], is_active: true, node_type: "product", assets: [{ source_url: "https://x/1.jpg" }] },
        { catalog_key: "bon_cau", display_name: "Bồn cầu", aliases: ["bồn cầu"], is_active: true, node_type: "product", assets: [] },
      ],
      ad_mappings: [{ ad_id: "ad1", is_active: true, catalog_keys: ["bep_tu_hut_mui", "bon_cau"], metadata: { mapping_target_type: "scope", ad_name: "Tổng hợp" } }],
    },
  };
  const selected = selectKnowledgeContext(snapshot, {
    page_id: "p1",
    turn: {
      combinedText: "Cho xem",
      contextText: "Mình làm lại bếp 3 từ",
      referral: { ad_id: "ad1" },
      salesSignals: { intents: ["samples"], products: ["bep_tu_hut_mui"] },
    },
  });
  assert.equal(selected.documents[0].version_no, 11);
  assert.equal(selected.catalog[0].catalog_key, "bep_tu_hut_mui");
  assert.deepEqual(selected.query.requested_catalog_keys, ["bep_tu_hut_mui"]);
});

test("broad mapping candidates do not force an unrelated catalog", () => {
  const snapshot = {
    content: {
      documents: [],
      catalog: [
        { catalog_key: "bep_tu_hut_mui", display_name: "Bếp", aliases: ["bếp"], is_active: true, node_type: "product", assets: [] },
        { catalog_key: "bon_cau", display_name: "Bồn cầu", aliases: ["bồn cầu"], is_active: true, node_type: "product", assets: [] },
      ],
      ad_mappings: [{ ad_id: "ad1", is_active: true, catalog_keys: ["bep_tu_hut_mui", "bon_cau"], metadata: { mapping_target_type: "scope" } }],
    },
  };
  const selected = selectKnowledgeContext(snapshot, {
    turn: {
      combinedText: "Mình hỏi bếp",
      referral: { ad_id: "ad1" },
      salesSignals: { intents: [], products: [] },
    },
  });
  assert.equal(selected.catalog[0].catalog_key, "bep_tu_hut_mui");
  assert.deepEqual(selected.query.requested_catalog_keys, []);
});

test("missing media product is downgraded safely instead of throwing", () => {
  const decision = validateDecision({
    action: "reply_with_slides",
    final_reply: "Dạ em gửi thông tin ạ",
    should_request_contact: false,
    contact_benefit: "",
    products: [],
    intents: ["samples"],
    needs_slides: true,
    confidence: 0.8,
    reason: "x",
    risk_flags: [],
  });
  assert.equal(decision.action, "reply_text");
  assert.equal(decision.needs_slides, false);
  assert.ok(decision.risk_flags.includes("media_product_unresolved"));
});
