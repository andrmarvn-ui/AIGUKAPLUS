import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { installBotControlUi } from "../bot-control-ui.js";

const server = fs.readFileSync(new URL("../bot-control-ui.js", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../bot-control-client.js", import.meta.url), "utf8");

test("Admin page mode saves the requested preference instead of being blocked by retired V8 gates", () => {
  assert.match(server, /v8_runtime_transition_check/);
  assert.match(server, /transition_warnings: blockers/);
  assert.match(server, /v8_pages\?page_id=eq\.\$\{encodeURIComponent\(pageId\)\}/);
  assert.match(server, /body: \{ bot_mode: mode, updated_at:/);
  assert.match(server, /saved: true/);
  assert.doesNotMatch(server, /const data = await rpc\("v8_set_runtime_mode"/);
});

test("retired V8 blockers are returned as warnings after the page mode is saved", async () => {
  const postHandlers = new Map();
  const app = {
    json: () => (_req, _res, next) => next?.(),
    use: () => {},
    get: () => {},
    post: (path, handler) => postHandlers.set(path, handler),
  };
  installBotControlUi(app, {
    supabaseUrl: "https://legacy.example",
    serviceRoleKey: "test-service-role",
  });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace("https://legacy.example/rest/v1/", "");
    calls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (path.startsWith("v8_pages?select=")) {
      return Response.json([{ page_id: "page-1", page_name: "Page 1", bot_mode: "SUPPORT" }]);
    }
    if (path === "rpc/v8_runtime_transition_check") {
      return Response.json({
        allowed: false,
        blockers: ["SECURITY_AUDIT_NOT_SECURE", "OUTBOUND_WORKER_NOT_HEALTHY"],
      });
    }
    if (path.startsWith("v8_pages?page_id=eq.page-1")) {
      return Response.json([{ page_id: "page-1", page_name: "Page 1", bot_mode: "PRODUCTION" }]);
    }
    if (path === "rpc/v8_resolve_runtime_policy") {
      return Response.json({ runtime_mode: "PRODUCTION", can_send_text: true, can_send_image: true });
    }
    if (path === "v8_admin_change_log") return Response.json([]);
    return Response.json({ message: `UNEXPECTED_TEST_PATH:${path}` }, { status: 500 });
  };

  let responseStatus = 200;
  let responseBody = null;
  const response = {
    status(value) { responseStatus = value; return this; },
    json(value) { responseBody = value; return this; },
  };

  try {
    await postHandlers.get("/bot-control/api/page-mode")({
      body: { page_id: "page-1", mode: "PRODUCTION" },
    }, response);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(responseStatus, 200);
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.data.saved, true);
  assert.equal(responseBody.data.new_page_mode, "PRODUCTION");
  assert.deepEqual(responseBody.data.warnings, [
    "SECURITY_AUDIT_NOT_SECURE",
    "OUTBOUND_WORKER_NOT_HEALTHY",
  ]);
  const saveCall = calls.find((call) => call.path.startsWith("v8_pages?page_id=eq.page-1"));
  assert.equal(saveCall.method, "PATCH");
  assert.equal(saveCall.body.bot_mode, "PRODUCTION");
  assert.equal(calls.some((call) => call.path === "rpc/v8_set_runtime_mode"), false);
});

test("Admin client treats unchanged idempotent saves as success", () => {
  assert.match(client, /result\.data\?\.saved !== true/);
  assert.doesNotMatch(client, /result\.data\?\.changed === false/);
  assert.match(client, /V10 vẫn kiểm soát an toàn khi gửi/);
});

test("page mode endpoint validates page identity and allowed modes", () => {
  assert.match(server, /THIEU_PAGE_ID/);
  assert.match(server, /CHE_DO_PAGE_KHONG_HOP_LE/);
  assert.match(server, /KHONG_TIM_THAY_PAGE/);
  assert.match(server, /\["OFF", "OBSERVE", "TEST", "PRODUCTION"\]/);
});
