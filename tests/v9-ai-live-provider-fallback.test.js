import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker = fs.readFileSync(new URL("../v9-ai-live-worker.js", import.meta.url), "utf8");
const release = fs.readFileSync(new URL("../v9-live-release-patch.js", import.meta.url), "utf8");

test("Gemini uses the documented OpenAI-compatible chat completion endpoint", () => {
  assert.match(worker, /\/openai`/);
  assert.match(worker, /\/chat\/completions/);
  assert.match(worker, /tool_choice: "required"/);
  assert.match(worker, /submit_v9_decision/);
  assert.match(worker, /parseChatDecision/);
});

test("Gemini is prioritized before other enabled providers", () => {
  assert.match(worker, /includes\("gemini"\) \? 0 : 1/);
  assert.match(worker, /for \(const ai of providerRows\)/);
  assert.match(worker, /providerErrors\.push/);
});

test("deterministic fallback prevents customer drops when all providers fail", () => {
  assert.match(worker, /fallbackDecision/);
  assert.match(worker, /provider_unavailable/);
  assert.match(worker, /rule_fallback/);
  assert.match(worker, /status: "shadow_ai_completed"/);
  assert.doesNotMatch(worker, /phone:\s*snapshot\?\.customer|zalo:\s*snapshot\?\.customer/);
});

test("fallback uses only verified address and never invents price", () => {
  assert.match(worker, /254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội/);
  assert.match(worker, /nhiều mẫu và mức giá khác nhau/);
  assert.doesNotMatch(worker, /\d{1,3}(?:[.,]\d{3})+\s*(?:đ|vnđ)/i);
});

test("release replaces the old AI worker before startup and removes invalid text_sent state", () => {
  assert.match(release, /fs\.writeFileSync\(aiTargetFile/);
  assert.match(release, /v9-ai-live-worker\.js/);
  assert.match(release, /status: "sent"/);
  assert.doesNotMatch(release, /status: assets\.length \? "text_sent"/);
});
