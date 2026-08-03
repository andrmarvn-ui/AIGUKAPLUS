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

test("release establishes pressure-safe Gemini Free retry defaults before worker import", () => {
  const source = fs.readFileSync(new URL("../v10-live-release.js", import.meta.url), "utf8");
  assert.match(source, /AIGUKA_V10_AI_MAX_ATTEMPTS \|\|= "10"/);
  assert.match(source, /AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS \|\|= "12000"/);
  assert.match(source, /AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS \|\|= "300000"/);
});
