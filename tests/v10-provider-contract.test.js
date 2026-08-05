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

test("final provider scheduler does not claim when no AI provider is ready", () => {
  const source = fs.readFileSync(new URL("../v10-ai-worker-final.js", import.meta.url), "utf8");
  const availability = source.indexOf("const availability = providerAvailability(providerRows, Date.now())");
  const noProvider = source.indexOf("if (!availability.available.length)", availability);
  const wait = source.indexOf("scheduleWithoutClaim(row, availability.nextAvailableAt", noProvider);
  const process = source.indexOf("processOne(row, availability.available, snapshot)", noProvider);
  assert.ok(availability >= 0 && noProvider > availability && wait > noProvider && process > wait);
  assert.match(source, /consumeAttempt: !transientOnly/);
  assert.match(source, /operational_fallback_enabled: false/);
  assert.match(source, /providerSettings\(provider\)\.max_input_chars/);
});

test("AI entrypoint installs adapters but never rewrites worker source", () => {
  const entry = fs.readFileSync(new URL("../v10-ai-worker.js", import.meta.url), "utf8");
  assert.match(entry, /v10-provider-runtime-policy\.js/);
  assert.match(entry, /v10-cohere-schema-sanitizer\.js/);
  assert.match(entry, /v10-openai-compatible-adapter\.js/);
  assert.match(entry, /v10-sambanova-runtime-adapter\.js/);
  assert.match(entry, /v10-ai-worker-final\.js/);
  assert.doesNotMatch(entry, /patch-v10-/);
});
