import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  authoritativeRequestedKeys,
  resolveAuthoritativeCatalogKeys,
  selectAuthoritativeMedia,
} from "../v9/core/media-authority.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function asset(id, url, sortOrder = 0) {
  return { asset_id: id, source_url: url, sort_order: sortOrder };
}

const catalog = [
  {
    catalog_key: "quat_10_canh_gold",
    display_name: "Quạt 10 cánh vàng bóng",
    aliases: ["quạt 10 cánh màu vàng bóng"],
    assets: [
      asset("fan-1", "https://example.com/fan-1.jpg", 1),
      asset("fan-2", "https://example.com/fan-2.jpg", 2),
    ],
  },
  {
    catalog_key: "bep_tu_hut_mui",
    display_name: "Bếp từ / máy hút mùi",
    aliases: ["bếp từ hút mùi"],
    assets: Array.from({ length: 10 }, (_, index) => asset(
      `kitchen-${index + 1}`,
      `https://example.com/kitchen-${index + 1}.jpg`,
      index + 1,
    )),
  },
  {
    catalog_key: "bon_cau",
    display_name: "Bồn cầu",
    aliases: [],
    assets: [asset("toilet-1", "https://example.com/toilet-1.jpg", 1)],
  },
];

test("AI product decision is authoritative even when selected Knowledge contains unrelated catalogs", () => {
  const decision = {
    action: "reply_with_slides",
    output: {
      needs_slides: true,
      products: ["quat_10_canh_gold"],
      selected_knowledge: {
        catalog_keys: ["quat_10_canh_gold", "bep_tu_hut_mui", "bon_cau"],
      },
    },
  };
  assert.deepEqual(authoritativeRequestedKeys(decision), ["quat_10_canh_gold"]);
  const result = selectAuthoritativeMedia({ decision, catalog });
  assert.deepEqual(result.catalog_keys, ["quat_10_canh_gold"]);
  assert.equal(result.assets.length, 2);
  assert.ok(result.assets.every((item) => item.catalog_key === "quat_10_canh_gold"));
  assert.ok(result.assets.every((item) => item.source_url.includes("fan-")));
});

test("explicit media_catalog_keys override products and selected Knowledge", () => {
  const decision = {
    action: "reply_with_slides",
    output: {
      needs_slides: true,
      products: ["bep_tu_hut_mui"],
      media_catalog_keys: ["quat_10_canh_gold"],
      selected_knowledge: { catalog_keys: ["bep_tu_hut_mui"] },
    },
  };
  const result = selectAuthoritativeMedia({ decision, catalog });
  assert.deepEqual(result.catalog_keys, ["quat_10_canh_gold"]);
  assert.ok(result.assets.every((item) => item.catalog_key === "quat_10_canh_gold"));
});

test("unique Vietnamese alias resolves to the exact catalog key", () => {
  assert.deepEqual(
    resolveAuthoritativeCatalogKeys({
      requestedKeys: ["Quạt 10 cánh màu vàng bóng"],
      catalog,
    }),
    ["quat_10_canh_gold"],
  );
});

test("multi-product media is balanced and never crosses the decided catalogs", () => {
  const decision = {
    action: "reply_with_slides",
    output: {
      needs_slides: true,
      products: ["quat_10_canh_gold", "bon_cau"],
    },
  };
  const result = selectAuthoritativeMedia({ decision, catalog, maxAssets: 3 });
  assert.deepEqual(result.assets.map((item) => item.catalog_key), [
    "quat_10_canh_gold",
    "bon_cau",
    "quat_10_canh_gold",
  ]);
});

test("slide decision without a final product fails closed", () => {
  const decision = {
    action: "reply_with_slides",
    output: {
      needs_slides: true,
      products: [],
      selected_knowledge: { catalog_keys: ["bep_tu_hut_mui"] },
    },
  };
  assert.throws(
    () => selectAuthoritativeMedia({ decision, catalog }),
    (error) => error?.code === "MEDIA_DECISION_PRODUCTS_REQUIRED",
  );
});

test("missing exact assets never fall back to another product group", () => {
  const decision = {
    action: "reply_with_slides",
    output: { needs_slides: true, products: ["quat_khong_co_anh"] },
  };
  assert.throws(
    () => selectAuthoritativeMedia({ decision, catalog }),
    (error) => error?.code === "MEDIA_CATALOG_NOT_FOUND",
  );
});

function installFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiguka-v9-media-authority-"));
  const files = [
    "v9/core/turn-builder.js",
    "v9/core/knowledge-selector.js",
    "v9/core/media-authority.js",
    "v9-direct-core-worker.js",
    "v9-ai-live-worker.js",
    "v9-live-outbound-worker.js",
    "v9-support-release-patch.js",
    "v9-media-authority-release-patch.js",
  ];
  for (const relative of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), target);
  }
  fs.copyFileSync(path.join(root, "v9-ai-live-worker.js"), path.join(root, "v9-ai-shadow-worker.js"));
  execFileSync(process.execPath, ["v9-support-release-patch.js"], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, ["v9-media-authority-release-patch.js"], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, ["v9-media-authority-release-patch.js"], { cwd: root, stdio: "pipe" });
  return root;
}

test("release patch remains idempotent after SUPPORT and installs fail-closed delivery", () => {
  const root = installFixture();
  const ai = fs.readFileSync(path.join(root, "v9-ai-shadow-worker.js"), "utf8");
  const outbound = fs.readFileSync(path.join(root, "v9-live-outbound-worker.js"), "utf8");

  assert.match(ai, /resolveAuthoritativeCatalogKeys/);
  assert.match(ai, /media_catalog_keys: mediaCatalogKeys/);
  assert.match(ai, /media_catalog_source/);
  assert.match(ai, /v9_ai_media_authority_v5/);

  const resolverStart = outbound.indexOf("async function resolveAssets");
  const resolverEnd = outbound.indexOf("function isAfterOrEqual", resolverStart);
  const resolver = outbound.slice(resolverStart, resolverEnd);
  assert.match(resolver, /selectAuthoritativeMedia/);
  assert.doesNotMatch(resolver, /selected_knowledge/);
  assert.match(outbound, /MEDIA_RESOLUTION_BLOCKED/);
  assert.match(outbound, /MEDIA_ASSET_NOT_FOUND/);
  assert.match(outbound, /media_asset_catalog_keys/);
  assert.match(outbound, /v9_live_outbound_media_authority_v3/);
  assert.ok(
    outbound.indexOf("MEDIA_RESOLUTION_BLOCKED") < outbound.indexOf("bundleFor(claimed"),
    "media must be validated before any delivery bundle or Meta send",
  );
});
