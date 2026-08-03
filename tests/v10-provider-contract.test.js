import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decisionSchema } from "../v10/core/decision-contract.js";

test("strict provider schema requires every top-level property", () => {
  const schema = decisionSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.ok(schema.required.includes("follow_up_plan"));
});

test("release establishes conservative provider scheduling defaults", () => {
  const source = fs.readFileSync(new URL("../v10-live-release.js", import.meta.url), "utf8");
  assert.match(source, /AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS \|\|= "60000"/);
  assert.match(source, /AIGUKA_GEMINI_FREE_MIN_COOLDOWN_MS \|\|= "120000"/);
  assert.match(source, /AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS \|\|= "300000"/);
  assert.match(source, /AIGUKA_OPENAI_CREDIT_COOLDOWN_MS \|\|= "21600000"/);
});

test("provider scheduler does not claim when no AI provider is ready", () => {
  const source = fs.readFileSync(new URL("../v10-ai-worker-v2.js", import.meta.url), "utf8");
  const availability = source.indexOf("const availability = providerAvailability(providerRows, now)");
  const noProvider = source.indexOf("if (!availability.available.length)");
  const process = source.indexOf("processOne(ready[0], availability.available");
  assert.ok(availability >= 0 && noProvider > availability && process > noProvider);
  assert.match(source, /scheduleWithoutClaim/);
  assert.match(source, /consumeAttempt: !transientOnly/);
  assert.match(source, /operational_fallback_enabled: false/);
});
