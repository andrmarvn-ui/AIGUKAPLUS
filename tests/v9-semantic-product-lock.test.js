import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildConversationTurn,
  detectSemanticProductKeys,
} from "../v9/core/semantic-conversation-intelligence-v2.js";
import {
  semanticDeterministicDecision,
  enforceSemanticProductLock,
  semanticAfterGeminiCall,
  semanticGeminiState,
} from "../v9/core/semantic-decision-policy-v2.js";

function ev(seconds, messageText, extra = {}) {
  return {
    source_event_id: `semantic-${seconds}-${Math.random()}`,
    event_type: "customer_message",
    occurred_at: new Date(1_785_680_000_000 + seconds * 1000).toISOString(),
    message_text: messageText,
    ...extra,
  };
}

function referral(title = "10 cánh mới - Bản sao") {
  return {
    source: "ADS",
    ad_id: "120245489590430424",
    ads_context_data: { ad_title: title },
  };
}

function build(events, options = {}) {
  return buildConversationTurn(events, {
    contextCustomerMessages: 12,
    contextMaxMinutes: 45,
    maxGapSeconds: 90,
    coexistenceMode: "AICAKE_DISABLED",
    ...options,
  });
}

test("bathroom and kitchen request keeps both groups active", () => {
  const turn = build([ev(0, "Tư vấn nhà tắm/nhà bếp...")]);
  assert.deepEqual(turn.salesSignals.allowedProducts, ["combo_phong_tam", "phong_bep"]);
  assert.equal(turn.salesSignals.productLock, "hard_multi");
  assert.equal(turn.salesSignals.requestPlan.filter((item) => item.state === "active").length, 2);
  const decision = semanticDeterministicDecision({ turn }, {});
  assert.equal(decision.action, "reply_with_slides");
  assert.deepEqual(decision.products, ["combo_phong_tam", "phong_bep"]);
  assert.match(decision.final_reply, /đồng thời|từng nhóm/i);
});

test("explicit bathroom-first follow-up defers other groups without forgetting them", () => {
  const turn = build([
    ev(0, "Tư vấn nhà tắm/nhà bếp..."),
    ev(45, "Cần tư vấn thiết bị vệ sinh đã"),
  ]);
  assert.deepEqual(turn.salesSignals.allowedProducts, ["combo_phong_tam"]);
  assert.ok(turn.salesSignals.pendingProducts.includes("phong_bep"));
  assert.equal(turn.salesSignals.requestPlan.find((item) => item.productKey === "phong_bep")?.state, "pending");
  const decision = semanticDeterministicDecision({ turn }, {});
  assert.deepEqual(decision.products, ["combo_phong_tam"]);
  assert.doesNotMatch(decision.final_reply, /bếp từ|hút mùi/i);
});

test("one-hole kitchen sink never resolves to chandelier or lavabo", () => {
  assert.deepEqual(detectSemanticProductKeys("Mình cần chậu 1 hố 78x48"), ["chau_voi_rua_bat"]);
  const turn = build([
    ev(0, "Mình cần chậu 1 hố 78x48"),
    ev(60, "Thay mới cho mình xem mẫu tầm trung"),
  ]);
  assert.deepEqual(turn.salesSignals.allowedProducts, ["chau_voi_rua_bat"]);
  const decision = semanticDeterministicDecision({ turn }, {});
  assert.deepEqual(decision.products, ["chau_voi_rua_bat"]);
});

test("tủ lavabo is one vanity catalog, not standalone lavabo plus mirror", () => {
  assert.deepEqual(detectSemanticProductKeys("Gửi mình mẫu tủ lavabo"), ["guong_tu"]);
  const turn = build([ev(0, "Gửi mình mẫu tủ lavabo")]);
  assert.deepEqual(turn.salesSignals.allowedProducts, ["guong_tu"]);
});

test("tile project for four bathrooms and kitchen is locked to tile when tile is the only requested product", () => {
  const turn = build([ev(0, "Tôi ốp 4 v s và pòng bếp khoảng 100m")]);
  const decision = semanticDeterministicDecision({ turn }, {});
  assert.deepEqual(decision.products, ["gach_da_op_lat"]);
  assert.equal(decision.needs_slides, true);
});

test("sequential bathroom kitchen and tile requests in one active turn keep all groups", () => {
  const turn = build([
    ev(0, "Tư vấn nhà tắm/nhà bếp..."),
    ev(20, "Tư vấn gạch ốp lát"),
  ]);
  assert.deepEqual(turn.salesSignals.allowedProducts, ["combo_phong_tam", "phong_bep", "gach_da_op_lat"]);
  assert.equal(turn.salesSignals.requestPlan.filter((item) => item.state === "active").length, 3);
  const decision = semanticDeterministicDecision({ turn }, {});
  assert.deepEqual(decision.products, ["combo_phong_tam", "phong_bep", "gach_da_op_lat"]);
  assert.match(decision.final_reply, /không.*bỏ sót|không quy|từng nhóm/i);
});

test("10-wing fan color is inferred from current text plus referral", () => {
  const turn = build([ev(0, "vàng gương", { referral: referral() })]);
  assert.deepEqual(turn.salesSignals.allowedProducts, ["quat_10_canh_gold"]);
  const priceTurn = build([
    ev(0, "vàng gương", { referral: referral() }),
    ev(20, "cho mình xin giá"),
  ]);
  assert.equal(priceTurn.salesSignals.primaryProduct, "quat_10_canh_gold");
  const decision = semanticDeterministicDecision({ turn: priceTurn }, {});
  assert.deepEqual(decision.products, ["quat_10_canh_gold"]);
  assert.match(decision.final_reply, /giá/i);
});

test("Messenger preference stops repeated phone and Zalo requests", () => {
  const turn = build([
    ev(0, "Quạt 10 cánh"),
    ev(20, "Nói luôn Zalo làm gì"),
  ]);
  assert.equal(turn.salesSignals.contactRefused, true);
  assert.equal(turn.shouldRequestContact, false);
  const decision = semanticDeterministicDecision({ turn }, {});
  assert.equal(decision.should_request_contact, false);
  assert.match(decision.final_reply, /Messenger/i);
});

test("provider cannot change a locked sink request into chandelier", () => {
  const snapshot = {
    turn: {
      salesSignals: {
        allowedProducts: ["chau_voi_rua_bat"],
        primaryProduct: "chau_voi_rua_bat",
        productLock: "hard",
      },
    },
  };
  const corrected = enforceSemanticProductLock({
    action: "reply_with_slides",
    final_reply: "Em gửi đèn chùm ạ",
    products: ["den_trum"],
    intents: ["samples"],
    needs_slides: true,
    should_request_contact: true,
    contact_benefit: "",
    confidence: 0.9,
    reason: "provider guess",
    risk_flags: [],
  }, snapshot);
  assert.deepEqual(corrected.products, ["chau_voi_rua_bat"]);
});

test("provider cannot collapse a multi-product request to one group", () => {
  const allowedProducts = ["combo_phong_tam", "phong_bep", "gach_da_op_lat"];
  const corrected = enforceSemanticProductLock({
    action: "reply_with_slides",
    final_reply: "Em gửi mẫu gạch ạ",
    products: ["gach_da_op_lat"],
    intents: ["samples"],
    needs_slides: true,
    should_request_contact: false,
    contact_benefit: "",
    confidence: 0.9,
    reason: "provider collapsed request",
    risk_flags: [],
  }, { turn: { salesSignals: { allowedProducts, productLock: "hard_multi" } } });
  assert.deepEqual(corrected.products, allowedProducts);
  assert.match(corrected.final_reply, /đồng thời|từng nhóm|không bỏ sót/i);
  assert.ok(corrected.risk_flags.includes("multi_product_plan_restored"));
});

test("media is blocked when no semantic product is resolved", () => {
  const corrected = enforceSemanticProductLock({
    action: "reply_with_slides",
    final_reply: "Em gửi mẫu ạ",
    products: ["den_trum"],
    intents: ["samples"],
    needs_slides: true,
    should_request_contact: false,
    contact_benefit: "",
    confidence: 0.9,
    reason: "provider guess",
    risk_flags: [],
  }, { turn: { salesSignals: { allowedProducts: [] } } });
  assert.equal(corrected.action, "ask_clarification");
  assert.equal(corrected.needs_slides, false);
  assert.deepEqual(corrected.products, []);
});

test("Gemini Free 429 opens a cooldown circuit", () => {
  semanticAfterGeminiCall(429);
  const state = semanticGeminiState();
  assert.ok(state.cooldownUntil > Date.now());
  assert.ok(state.consecutive429 >= 1);
  assert.ok(state.minIntervalMs >= 5000);
  semanticAfterGeminiCall(200);
});

test("full Railway patch chain installs multi-product request plan after no-drop", async () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-semantic-lock-"));
  const files = [
    "v9/core/contact-detector.js",
    "v9/core/turn-builder.js",
    "v9/core/conversation-intelligence.js",
    "v9/core/semantic-conversation-intelligence.js",
    "v9/core/semantic-conversation-intelligence-v2.js",
    "v9/core/semantic-decision-policy.js",
    "v9/core/semantic-decision-policy-v2.js",
    "v9/core/knowledge-selector.js",
    "v9/core/knowledge-selector-v2.js",
    "v9/core/decision-contract.js",
    "v9/core/decision-contract-v2.js",
    "v9/core/media-authority.js",
    "v9-direct-core-worker.js",
    "v9-ai-live-worker.js",
    "v9-live-outbound-worker.js",
    "v9-support-release-patch.js",
    "v9-support-fast-vision-release-patch.js",
    "v9-support-sample-ai-release-patch.js",
    "v9-media-authority-release-patch.js",
    "v9-support-large-slide-release-patch.js",
    "v9-root-conversation-architecture-release-patch.js",
    "v9-no-drop-release-patch.js",
    "v9-semantic-product-lock-release-patch.js",
  ];
  for (const relative of files) {
    const target = path.join(temp, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  fs.copyFileSync(path.join(root, "v9-ai-live-worker.js"), path.join(temp, "v9-ai-shadow-worker.js"));

  const previous = process.cwd();
  process.chdir(temp);
  try {
    for (const patch of [
      "v9-support-release-patch.js",
      "v9-support-fast-vision-release-patch.js",
      "v9-support-sample-ai-release-patch.js",
      "v9-media-authority-release-patch.js",
      "v9-support-large-slide-release-patch.js",
      "v9-root-conversation-architecture-release-patch.js",
      "v9-no-drop-release-patch.js",
      "v9-semantic-product-lock-release-patch.js",
    ]) {
      await import(`${pathToFileURL(path.join(temp, patch)).href}?test=${Date.now()}-${patch}`);
    }
  } finally {
    process.chdir(previous);
  }

  const ai = fs.readFileSync(path.join(temp, "v9-ai-shadow-worker.js"), "utf8");
  const direct = fs.readFileSync(path.join(temp, "v9-direct-core-worker.js"), "utf8");
  assert.match(ai, /AIGUKA_V9_MULTI_PRODUCT_REQUEST_PLAN_V1/);
  assert.match(ai, /v9_ai_multi_product_plan_v13/);
  assert.match(ai, /semanticBeforeGeminiCall/);
  assert.match(ai, /enforceSemanticProductLock/);
  assert.match(direct, /v9_direct_multi_product_plan_v5/);
  assert.match(direct, /semantic-conversation-intelligence-v2/);
});
