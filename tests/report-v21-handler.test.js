import test from "node:test";
import assert from "node:assert/strict";
import { installReportRoutes } from "../report-handler.js";

function makeApp() {
  const routes = new Map();
  return {
    get(path, handler) { routes.set(path, handler); },
    route(path) { return routes.get(path); },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: new Map(),
    payload: null,
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; },
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function withFetch(handler, { meta = true, core = false, leadRow = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.META_ACCESS_TOKEN;
  const originalCoreUrl = process.env.AIGUKA_V9_CORE_URL;
  const originalCoreKey = process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY;
  const calls = [];
  if (meta) process.env.META_ACCESS_TOKEN = "test-meta-token";
  else delete process.env.META_ACCESS_TOKEN;
  if (core) {
    process.env.AIGUKA_V9_CORE_URL = "https://core.example.co";
    process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY = "core-key";
  } else {
    delete process.env.AIGUKA_V9_CORE_URL;
    delete process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY;
  }
  globalThis.fetch = async (url, options = {}) => {
    const item = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null };
    calls.push(item);
    if (item.url.includes("/rpc/v8_report_filters_test")) {
      return response({
        ok: true,
        data: {
          pages: [{ page_id: "page-1", page_name: "Page 1" }],
          ad_accounts: [{ ad_account_id: "123", ad_account_name: "Account 123", currency: "VND" }],
          ads: [],
        },
      });
    }
    if (item.url.includes("/rpc/v8_report_leads_test")) {
      return response({
        ok: true,
        data: leadRow ? [{
          page_id: "page-1",
          customer_id: "customer-1",
          sender_id: "customer-1",
          customer_name: "Khách 000001",
          phone: "Đã có SĐT",
          has_contact: true,
        }] : [],
        count: leadRow ? 1 : 0,
      });
    }
    if (item.url.startsWith("https://core.example.co/rest/v1/v9_customers?")) {
      return response([{ page_id: "page-1", customer_id: "customer-1", display_name: "Nguyễn Văn An", gender: "male", preferred_salutation: "anh" }]);
    }
    if (item.url.startsWith("https://core.example.co/rest/v1/v9_contacts?")) {
      return response([{ page_id: "page-1", customer_id: "customer-1", contact_type: "phone", contact_value: "0965000111", normalized_value: "0965000111", captured_at: "2026-08-05T10:00:00Z" }]);
    }
    if (item.url.includes("graph.facebook.com") && item.url.includes("/act_123/insights")) {
      return response({ data: [] });
    }
    if (item.url.includes("graph.facebook.com") && item.url.includes("/act_123?")) {
      return response({ id: "act_123", name: "Account 123", currency: "VND", timezone_name: "Asia/Ho_Chi_Minh", account_status: 1 });
    }
    return response({ ok: true, data: [], count: 0 });
  };
  try {
    return await handler(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = originalToken;
    if (originalCoreUrl === undefined) delete process.env.AIGUKA_V9_CORE_URL;
    else process.env.AIGUKA_V9_CORE_URL = originalCoreUrl;
    if (originalCoreKey === undefined) delete process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY;
    else process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY = originalCoreKey;
  }
}

function installedHandler() {
  const app = makeApp();
  installReportRoutes(app, { supabaseUrl: "https://example.supabase.co", publishableKey: "test-key" });
  return app.route("/functions/v1/aiguka-v8-report-api");
}

function urls(calls) {
  return calls.map((call) => call.url);
}

test("summary reads Meta directly and uses stored facts only for customer matching", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "summary", from: "2026-08-05", to: "2026-08-05" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.source, "meta_live_plus_customer_facts");
    assert.ok(urls(calls).some((url) => /v8_report_filters_test$/.test(url)));
    assert.ok(urls(calls).some((url) => /v8_report_ads_test$/.test(url)));
    assert.ok(urls(calls).some((url) => /graph\.facebook\.com\/v23\.0\/act_123\/insights\?/.test(url)));
    assert.ok(urls(calls).some((url) => /graph\.facebook\.com\/v23\.0\/act_123\?/.test(url)));
    assert.equal(urls(calls).some((url) => /v8_report_summary_test$/.test(url)), false);
    const storedAds = calls.find((call) => /v8_report_ads_test$/.test(call.url));
    assert.equal(storedAds.body.p_from, "2026-08-05");
    assert.equal(storedAds.body.p_to, "2026-08-05");
  });
});

test("ads and daily use Meta while leads retain paginated customer history", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "ads", from: "2026-08-01", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "meta_live_plus_customer_facts");
    assert.ok(urls(calls).some((url) => /v8_report_ads_test$/.test(url)));
    assert.ok(urls(calls).some((url) => url.includes("graph.facebook.com") && url.includes("/insights?")));
  });

  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "daily", from: "2026-08-01", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "meta_live_plus_customer_facts");
    assert.ok(urls(calls).some((url) => /v8_report_ads_test$/.test(url)));
    assert.ok(urls(calls).some((url) => /v8_report_daily_test$/.test(url)));
    assert.ok(urls(calls).some((url) => url.includes("graph.facebook.com") && url.includes("/insights?")));
  });

  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "leads", from: "2026-07-01", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "supabase_customer_history");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /v8_report_leads_test$/);
    assert.equal(calls[0].body.p_limit, 250);
    assert.equal(calls[0].body.p_offset, 0);
  });
});

test("lead rows read names and raw contacts from Core without copying them into Reporting", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "leads", from: "2026-08-05", to: "2026-08-05", limit: "250" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.source, "core_live_plus_reporting_history");
    assert.equal(res.payload.customer_data_source, "v10_core_live");
    assert.equal(res.payload.core_enriched_count, 1);
    assert.equal(res.payload.data[0].customer_name, "Nguyễn Văn An");
    assert.equal(res.payload.data[0].phone, "0965000111");
    assert.equal(res.payload.data[0].contact_value_source, "v10_core_live");
    assert.ok(urls(calls).some((url) => url.startsWith("https://core.example.co/rest/v1/v9_customers?")));
    assert.ok(urls(calls).some((url) => url.startsWith("https://core.example.co/rest/v1/v9_contacts?")));
    assert.equal(urls(calls).some((url) => url.includes("fact_contacts") && url.includes("0965000111")), false);
  }, { core: true, leadRow: true });
});

test("filters and health expose direct Meta readiness", async () => {
  await withFetch(async (calls) => {
    const handler = installedHandler();
    const health = makeResponse();
    await handler({ query: { action: "health" } }, health);
    assert.equal(health.payload.version, 5);
    assert.equal(health.payload.meta_direct_ready, true);
    assert.equal(health.payload.customer_history_source, "reporting_history");
    assert.equal(health.payload.raw_contact_replication, false);

    const filterResponse = makeResponse();
    await handler({ query: { action: "filters" } }, filterResponse);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /v8_report_filters_test$/);
  });
});

test("missing Meta token falls back explicitly instead of reporting disconnected", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "ads", from: "2026-08-05", to: "2026-08-05" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.source, "supabase_fallback");
    assert.deepEqual(res.payload.warnings, ["META_ACCESS_TOKEN_MISSING"]);
    assert.ok(urls(calls).some((url) => /v8_report_filters_test$/.test(url)));
    assert.ok(urls(calls).some((url) => /v8_report_ads_test$/.test(url)));
    assert.equal(urls(calls).some((url) => url.includes("graph.facebook.com")), false);
  }, { meta: false });
});

test("retired V2.1 parameter cannot switch production back to stale RPCs", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "summary", version: "2.1", from: "2026-08-05", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "meta_live_plus_customer_facts");
    assert.equal(urls(calls).some((url) => /v8_report_summary_v21$/.test(url)), false);
    assert.equal(urls(calls).some((url) => /v8_report_ads_v21$/.test(url)), false);
    assert.ok(urls(calls).some((url) => url.includes("graph.facebook.com") && url.includes("/insights?")));
  });
});
