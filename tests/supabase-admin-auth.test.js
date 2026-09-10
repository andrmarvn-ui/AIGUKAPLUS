import assert from "node:assert/strict";
import test from "node:test";
import { __private__ } from "../supabase-admin-auth.js";

test("safeNext accepts only local non-auth destinations", () => {
  assert.equal(__private__.safeNext("/dashboard?view=leads"), "/dashboard?view=leads");
  assert.equal(__private__.safeNext("https://evil.example"), "/dashboard");
  assert.equal(__private__.safeNext("//evil.example"), "/dashboard");
  assert.equal(__private__.safeNext("/auth/logout"), "/dashboard");
});

test("cookie parser decodes values without throwing on malformed input", () => {
  assert.deepEqual(__private__.parseCookies("a=1; b=hello%20world"), { a: "1", b: "hello world" });
  assert.equal(__private__.parseCookies("broken=%E0%A4%A").broken, "%E0%A4%A");
});

test("only health, auth endpoints and explicit Meta webhooks are public", () => {
  const request = (path, method = "GET") => ({ path, url: path, method, headers: {} });
  assert.equal(__private__.publicRequest(request("/health")), true);
  assert.equal(__private__.publicRequest(request("/auth/login")), true);
  assert.equal(__private__.publicRequest(request("/functions/v1/aiguka-v9-webhook")), true);
  assert.equal(__private__.publicRequest(request("/dashboard")), false);
  assert.equal(__private__.publicRequest(request("/api/ai-providers")), false);
  assert.equal(__private__.publicRequest(request("/rest/v1/v8_pages")), false);
});

test("authorization uses immutable app role or an explicit email allowlist", () => {
  const previous = process.env.AIGUKA_AUTH_ALLOWED_EMAILS;
  delete process.env.AIGUKA_AUTH_ALLOWED_EMAILS;
  assert.equal(__private__.authorizedUser({ email: "admin@example.com", app_metadata: { role: "admin" } }), true);
  assert.equal(__private__.authorizedUser({ email: "user@example.com", user_metadata: { role: "admin" } }), false);
  process.env.AIGUKA_AUTH_ALLOWED_EMAILS = "Owner@Example.com, second@example.com";
  assert.equal(__private__.authorizedUser({ email: "owner@example.com", app_metadata: {} }), true);
  assert.equal(__private__.authorizedUser({ email: "other@example.com", app_metadata: { role: "admin" } }), false);
  if (previous === undefined) delete process.env.AIGUKA_AUTH_ALLOWED_EMAILS;
  else process.env.AIGUKA_AUTH_ALLOWED_EMAILS = previous;
});

test("internal bypass requires both the process token and a loopback socket", () => {
  const token = process.env.AIGUKA_INTERNAL_HTTP_TOKEN;
  const request = (address, supplied) => ({
    socket: { remoteAddress: address },
    headers: { "x-aiguka-internal-auth": supplied },
  });
  assert.equal(__private__.internalRequest(request("127.0.0.1", token)), true);
  assert.equal(__private__.internalRequest(request("::ffff:127.0.0.1", token)), true);
  assert.equal(__private__.internalRequest(request("10.0.0.8", token)), false);
  assert.equal(__private__.internalRequest(request("127.0.0.1", "wrong")), false);
});
