import test from "node:test";
import assert from "node:assert/strict";
import {
  compatibleMaxTokens,
  isCompatibleResponsesUrl,
  toChatCompletionsBody,
  toResponsesPayload,
} from "../v10-openai-compatible-adapter.js";

test("only KIMI and OpenRouter Responses URLs are adapted", () => {
  assert.equal(isCompatibleResponsesUrl("https://api.moonshot.ai/v1/responses"), true);
  assert.equal(isCompatibleResponsesUrl("https://openrouter.ai/api/v1/responses"), true);
  assert.equal(isCompatibleResponsesUrl("https://api.openai.com/v1/responses"), false);
  assert.equal(isCompatibleResponsesUrl("https://api.moonshot.ai/v1/chat/completions"), false);
});

test("compatible output budget is safe for low-credit OpenRouter accounts", () => {
  assert.equal(compatibleMaxTokens(), 1200);
  assert.equal(compatibleMaxTokens("200"), 256);
  assert.equal(compatibleMaxTokens("8000"), 4000);
  assert.equal(compatibleMaxTokens("invalid"), 1200);
});

test("Responses request becomes OpenAI-compatible chat/completions request", () => {
  const body = toChatCompletionsBody({
    model: "kimi-k2.6",
    instructions: "system instructions",
    input: [{ role: "user", content: [{ type: "input_text", text: "customer context" }] }],
    tools: [{
      type: "function",
      name: "submit_v10_decision",
      strict: true,
      description: "Submit decision",
      parameters: { type: "object", properties: { action: { type: "string" } } },
    }],
    tool_choice: "required",
    parallel_tool_calls: false,
  });

  assert.equal(body.model, "kimi-k2.6");
  assert.deepEqual(body.messages, [
    { role: "system", content: "system instructions" },
    { role: "user", content: "customer context" },
  ]);
  assert.equal(body.max_tokens, 1200);
  assert.equal(body.tools[0].function.name, "submit_v10_decision");
  assert.equal(body.tool_choice, "required");
  assert.equal(body.parallel_tool_calls, false);
});

test("chat tool call becomes Responses-compatible function_call", () => {
  const payload = toResponsesPayload({
    id: "chatcmpl-test",
    model: "openai/gpt-4o",
    choices: [{
      message: {
        tool_calls: [{
          id: "call-test",
          type: "function",
          function: { name: "submit_v10_decision", arguments: "{\"action\":\"reply\"}" },
        }],
      },
    }],
  });

  assert.equal(payload.object, "response");
  assert.equal(payload.output[0].type, "function_call");
  assert.equal(payload.output[0].name, "submit_v10_decision");
  assert.equal(payload.output[0].arguments, "{\"action\":\"reply\"}");
});
