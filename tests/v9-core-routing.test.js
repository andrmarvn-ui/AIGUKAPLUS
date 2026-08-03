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
  assert.equal(isV9CoreRequest(`${legacy}/rest/v1/rpc/v9_ingest_meta_batch`, legacy), true);
});

test("never routes V8 source tables", () => {
  assert.equal(isV9CoreRequest(`${legacy}/rest/v1/v8_webhook_inbox?select=*`, legacy), false);
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

test("startup gates bridge, current Core workers and reporting publisher behind Core", () => {
  const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
  const gateStart = start.indexOf("if (v9CoreReady) {");
  const gateEnd = start.indexOf("} else {", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gated = start.slice(gateStart, gateEnd);
  for (const worker of [
    "v9-legacy-inbox-bridge.js",
    "v10-decision-queue-janitor.js",
    "v10-direct-core-worker.js",
    "v10-ai-worker.js",
    "v10-outbound-worker.js",
    "v9-reporting-publisher.js",
  ]) assert.match(gated, new RegExp(worker.replaceAll(".", "\\.")));
  assert.doesNotMatch(start, /startDetached\("\.\/v9-shadow-worker\.js"\)/);
  assert.doesNotMatch(start, /startDetached\("\.\/v9-ai-shadow-worker\.js"\)/);
  assert.match(start, /v9CoreRoutingState\?\.enabled === true/);
});

test("current Core-only worker never reads legacy V8 tables", () => {
  const direct = fs.readFileSync(new URL("../v10-direct-core-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(direct, /v8_meta_events|v8_messages_raw|v8_customers|v8_message_actor_registry/);
  assert.match(direct, /v9_events/);
  assert.match(direct, /v9_customers/);
  assert.match(direct, /rpc\/v9_claim_jobs/);
});
