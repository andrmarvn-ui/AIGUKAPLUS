import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildConversationTurn, detectProductKeys } from "../v9/core/conversation-intelligence.js";
import { resolveAuthoritativeCatalogKeys, selectAuthoritativeMedia } from "../v9/core/media-authority.js";

function ev(seconds, messageText, extra = {}) {
  return {
    source_event_id: `e${seconds}`,
    event_type: "customer_message",
    occurred_at: new Date(1_785_680_000_000 + seconds * 1000).toISOString(),
    message_text: messageText,
    ...extra,
  };
}

function node(catalogKey, aliases = [], assets = 1) {
  return {
    catalog_key: catalogKey,
    display_name: catalogKey.replaceAll("_", " "),
    aliases,
    assets: Array.from({ length: assets }, (_, index) => ({
      asset_id: `${catalogKey}-${index}`,
      source_url: `https://example.com/${catalogKey}-${index}.jpg`,
      sort_order: index,
    })),
  };
}

test("known contact does not silence a later customer question", () => {
  const turn = buildConversationTurn([
    ev(0, "Zalo 0369227847"),
    ev(180, "Mình ở Lạng Sơn"),
  ], {
    state: { contact_status: "captured", phone: "0369227847" },
    contextCustomerMessages: 12,
    contextMaxMinutes: 45,
  });
  assert.equal(turn.contact.contactCaptured, true);
  assert.equal(turn.contact.newlyCaptured, false);
  assert.equal(turn.action, "needs_ai_decision");
  assert.equal(turn.shouldRequestContact, false);
});

test("only the current message containing contact is captured silently", () => {
  const turn = buildConversationTurn([ev(0, "Zalo 0369227847")], {});
  assert.equal(turn.contact.newlyCaptured, true);
  assert.equal(turn.action, "contact_captured");
});

test("real dropped product phrases resolve to published catalog keys", () => {
  assert.deepEqual(detectProductKeys("Mình cần chậu nhé"), ["chau_voi_rua_bat"]);
  assert.deepEqual(detectProductKeys("Tư vấn gạch ốp lát"), ["gach_da_op_lat"]);
  assert.deepEqual(detectProductKeys("Mình muốn hỏi về quạt này ạ"), ["quat_tran"]);
  assert.deepEqual(detectProductKeys("Cho xem chậu lavabo"), ["lavabo"]);
});

test("broad zero-asset catalog expands to asset-bearing family and ignores unknown siblings", () => {
  const catalog = [
    node("gach_da_op_lat", ["gạch ốp lát"], 0),
    node("gach_an_do", ["gạch ấn độ"], 2),
    node("gach_tay_ban_nha", ["gạch tây ban nha"], 3),
  ];
  assert.deepEqual(
    resolveAuthoritativeCatalogKeys({ requestedKeys: ["gach_da_op_lat", "dien_cong_tac"], catalog }),
    ["gach_tay_ban_nha", "gach_an_do"],
  );
});

test("broad kitchen request balances real kitchen catalogs", () => {
  const catalog = [
    node("phong_bep", [], 0),
    node("bep_tu_hut_mui", ["bếp"], 2),
    node("chau_voi_rua_bat", ["chậu"], 2),
  ];
  const selected = selectAuthoritativeMedia({
    decision: { action: "reply_with_slides", output: { needs_slides: true, products: ["phong_bep"] } },
    catalog,
    maxAssets: 4,
  });
  assert.deepEqual(selected.catalog_keys, ["bep_tu_hut_mui", "chau_voi_rua_bat"]);
  assert.equal(selected.assets.length, 4);
  assert.deepEqual([...new Set(selected.assets.map((item) => item.catalog_key))], ["bep_tu_hut_mui", "chau_voi_rua_bat"]);
});

test("full Railway patch chain installs no-drop workers", async () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-no-drop-"));
  const files = [
    "v9/core/contact-detector.js",
    "v9/core/turn-builder.js",
    "v9/core/conversation-intelligence.js",
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
    ]) {
      await import(`${pathToFileURL(path.join(temp, patch)).href}?test=${Date.now()}-${patch}`);
    }
  } finally {
    process.chdir(previous);
  }

  const ai = fs.readFileSync(path.join(temp, "v9-ai-shadow-worker.js"), "utf8");
  const outbound = fs.readFileSync(path.join(temp, "v9-live-outbound-worker.js"), "utf8");
  const direct = fs.readFileSync(path.join(temp, "v9-direct-core-worker.js"), "utf8");
  assert.match(ai, /AIGUKA_V9_NO_DROP_V1/);
  assert.match(ai, /contactNewlyCaptured/);
  assert.match(ai, /media_text_fallback/);
  assert.match(outbound, /AIGUKA_V9_NO_DROP_V1/);
  assert.match(outbound, /latestCustomerAt/);
  assert.match(outbound, /truthfulTextFallback/);
  assert.doesNotMatch(outbound, /return \{ allowed: false, reason: "CONTACT_ALREADY_CAPTURED" \}/);
  assert.match(direct, /v9_direct_no_drop_v3/);
});
