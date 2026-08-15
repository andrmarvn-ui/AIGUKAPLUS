import test from "node:test";
import assert from "node:assert/strict";
import {
  providerModelFamily,
  stickyModelProviderOrder,
} from "../v10/core/provider-routing.js";

const provider = (provider_key, model_name, settings = {}, provider_type = "openai_compatible") => ({
  provider_key,
  provider_type,
  model_name,
  settings,
});

const rows = [
  provider("deepseek", "deepseek-v3.1", { runtime_order: 7 }),
  provider("gemma", "gemma-4-26b-a4b-it", { runtime_order: 3, quality_role: "google_primary_3" }, "gemini"),
  provider("gemini", "gemini-3.5-flash", { runtime_order: 5, quality_role: "google_primary_2" }, "gemini"),
  provider("gemini2", "gemini-3.5-flash", { runtime_order: 6, quality_role: "google_primary_1" }, "gemini"),
  provider("cohere", "command-a-plus", { runtime_order: 998, quality_role: "penultimate_last_resort" }),
];

test("two API keys for the same Gemini model are exhausted before switching model family", () => {
  assert.equal(providerModelFamily(rows[2]), providerModelFamily(rows[3]));
  assert.deepEqual(
    stickyModelProviderOrder(rows).map((item) => item.provider_key),
    ["gemini2", "gemini", "gemma", "deepseek", "cohere"],
  );
});

test("the last successful key remains sticky while its model family is available", () => {
  const order = stickyModelProviderOrder(rows, {
    activeFamily: providerModelFamily(rows[2]),
    lastProviderKey: "gemini",
  }).map((item) => item.provider_key);
  assert.deepEqual(order, ["gemini", "gemini2", "gemma", "deepseek", "cohere"]);
});

test("after a family is exhausted the next family stays active instead of bouncing back", () => {
  const activeDeepseek = providerModelFamily(rows[0]);
  const order = stickyModelProviderOrder(rows, {
    activeFamily: activeDeepseek,
    lastProviderKey: "deepseek",
  }).map((item) => item.provider_key);
  assert.deepEqual(order, ["deepseek", "gemini2", "gemini", "gemma", "cohere"]);
});

test("strict last-resort models remain last during normal family rotation", () => {
  const available = rows.filter((item) => !["gemini", "gemini2"].includes(item.provider_key));
  assert.deepEqual(
    stickyModelProviderOrder(available).map((item) => item.provider_key),
    ["gemma", "deepseek", "cohere"],
  );
});

test("sticky routing is not affected by a global Array sort override", () => {
  const nativeSort = Array.prototype.sort;
  try {
    Array.prototype.sort = function forbiddenGlobalSortOverride() {
      throw new Error("GLOBAL_SORT_MUST_NOT_CONTROL_PROVIDER_ROUTING");
    };
    assert.deepEqual(
      stickyModelProviderOrder(rows).map((item) => item.provider_key),
      ["gemini2", "gemini", "gemma", "deepseek", "cohere"],
    );
  } finally {
    Array.prototype.sort = nativeSort;
  }
});
