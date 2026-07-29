import test from "node:test";
import assert from "node:assert/strict";
import { isV9CoreRequest, buildV9CoreTarget } from "../v9-core-fetch-router.js";

const legacy = "https://legacy-project.supabase.co";
const core = "https://core-project.supabase.co";

test("routes V9 REST tables to isolated Core", () => {
  assert.equal(isV9CoreRequest(`${legacy}/rest/v1/v9_events?select=*`, legacy), true);
  const target = buildV9CoreTarget(`${legacy}/rest/v1/v9_events?select=id`, {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "core-secret",
  });
  assert.equal(target.url, `${core}/rest/v1/v9_events?select=id`);
  assert.equal(target.coreKey, "core-secret");
});

test("routes V9 RPC calls to isolated Core", () => {
  assert.equal(isV9CoreRequest(`${legacy}/rest/v1/rpc/v9_claim_jobs`, legacy), true);
});

test("never routes V8 source tables", () => {
  assert.equal(isV9CoreRequest(`${legacy}/rest/v1/v8_meta_events?select=*`, legacy), false);
  assert.equal(buildV9CoreTarget(`${legacy}/rest/v1/v8_customers?select=*`, {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "core-secret",
  }), null);
});

test("never routes OpenAI or unrelated hosts", () => {
  assert.equal(isV9CoreRequest("https://api.openai.com/v1/responses", legacy), false);
  assert.equal(isV9CoreRequest(`${core}/rest/v1/v9_events`, legacy), false);
});

test("missing Core credential fails closed", () => {
  assert.equal(buildV9CoreTarget(`${legacy}/rest/v1/v9_events`, {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "",
  }), null);
});
