import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isV9CoreRequest, buildV9CoreTarget, classifyV9CoreRequest } from "../v9-core-fetch-router.js";

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
  assert.equal(classifyV9CoreRequest(`${legacy}/rest/v1/v9_events`, {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "core-secret",
  }).action, "route");
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
  assert.equal(classifyV9CoreRequest(`${legacy}/rest/v1/v8_customers`, {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "",
  }).action, "passthrough");
});

test("never routes OpenAI or unrelated hosts", () => {
  assert.equal(isV9CoreRequest("https://api.openai.com/v1/responses", legacy), false);
  assert.equal(isV9CoreRequest(`${core}/rest/v1/v9_events`, legacy), false);
  assert.equal(classifyV9CoreRequest("https://api.openai.com/v1/responses", {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "",
  }).action, "passthrough");
});

test("missing Core credential blocks legacy V9 access", () => {
  assert.equal(buildV9CoreTarget(`${legacy}/rest/v1/v9_events`, {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "",
  }), null);
  const decision = classifyV9CoreRequest(`${legacy}/rest/v1/v9_events`, {
    legacyBase: legacy,
    coreBase: core,
    coreKey: "",
  });
  assert.equal(decision.action, "block");
  assert.equal(decision.reason, "V9_CORE_CREDENTIAL_REQUIRED");
});

test("startup gates both V9 workers behind verified Core routing", () => {
  const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
  const gateStart = start.indexOf("if (v9CoreReady) {");
  const gateEnd = start.indexOf("} else {", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gated = start.slice(gateStart, gateEnd);
  assert.match(gated, /v9-shadow-worker\.js/);
  assert.match(gated, /v9-ai-shadow-worker\.js/);
  assert.match(start, /v9CoreRoutingState\?\.enabled === true/);
});
