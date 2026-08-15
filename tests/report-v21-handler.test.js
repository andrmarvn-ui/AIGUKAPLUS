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

const staticFilters = {
  pages: [{ page_id: "page-1", page_name: "Page 1" }],
  ad_accounts: [{ ad_account_id: "123", ad_account_name: "Account 123", currency: "VND", timezone_name: "Asia/Ho_Chi_Minh" }],
  ads: [{
    page_id: "page-1",
    page_name: "Page 1",
    ad_account_id: "123",
    ad_account_name: "Account 123",
    campaign_id: "campaign-1",
    campaign_name: "Campaign 1",
    adset_id: "adset-1",
    adset_name: "Ad set 1",
    ad_id: "ad-1",
    ad_name: "Ad 1",
    effective_status: "ACTIVE",
  }],
};

async function withFetch(handler, { meta = true, core = true, leadRow = false, failInsights = false, failFilterRegistry = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originals = {
    token: process.env.META_ACCESS_TOKEN,
    coreUrl: process.env.AIGUKA_V9_CORE_URL,
    coreKey: process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY,
    reportingKey: process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY,
    legacyKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
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
  delete process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  globalThis.fetch = async (url, options = {}) => {
    const item = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null };
    calls.push(item);

    if (item.url.includes("/rpc/v10_report_filter_registry")) {
      if (failFilterRegistry) return response({ message: "registry unavailable" }, 503);
      return response({ ok: true, data: staticFilters, source: "v10_static_registry_and_mapping" });
    }
    if (item.url.includes("/rpc/v8_report_filters_test")) {
      if (failFilterRegistry) return response({ message: "fallback unavailable" }, 503);
      return response({ ok: true, data: staticFilters });
    }
    if (item.url.startsWith("https://core.example.co/rest/v1/rpc/v10_report_customer_metrics")) {
      return response({
        ok: true,
        source: "v10_core_live_customer_metrics",
        data: [{
          report_date: "2026-08-05",
          page_id: "page-1",
          ad_id: "ad-1",
          conversations: 4,
          contacts: 2,
          hot_leads: 2,
          message_count: 8,
        }],
      });
    }
    if (item.url.includes("/rpc/v8_report_ads_test")) {
      return response({ ok: true, data: [{ ad_id: "fallback-ad", spend_with_tax: 99 }], count: 1 });
    }
    if (item.url.includes("/rpc/v8_report_daily_test")) {
      return response({ ok: true, data: [{ report_date: "2026-08-05", ad_account_id: "123", spend_with_tax: 99 }], count: 1 });
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
          ad_id: "ad-1",
          ad_account_id: null,
          campaign_id: null,
          campaign_name: null,
          adset_id: null,
          adset_name: null,
          ad_name: null,
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
    if (item.url.includes("graph.facebook.com") && item.url.includes("/act_123/campaigns?")) {
      return response({ data: [{ id: "campaign-1", name: "Campaign 1", status: "ACTIVE", effective_status: "ACTIVE" }] });
    }
    if (item.url.includes("graph.facebook.com") && item.url.includes("/act_123/adsets?")) {
      return response({ data: [{ id: "adset-1", name: "Ad set 1", campaign_id: "campaign-1", status: "ACTIVE", effective_status: "ACTIVE" }] });
    }
    if (item.url.includes("graph.facebook.com") && item.url.includes("/act_123/ads?")) {
      return response({ data: [{ id: "ad-1", name: "Ad 1", campaign_id: "campaign-1", adset_id: "adset-1", status: "ACTIVE", effective_status: "ACTIVE" }] });
    }
    if (item.url.includes("graph.facebook.com") && item.url.includes("/act_123/insights?")) {
      if (failInsights) return response({ error: { code: 2, message: "temporary" } }, 500);
      return response({ data: [{
        date_start: "2026-08-05",
        date_stop: "2026-08-05",
        account_id: "123",
        account_name: "Account 123",
        campaign_id: "campaign-1",
        campaign_name: "Campaign 1",
        adset_id: "adset-1",
        adset_name: "Ad set 1",
        ad_id: "ad-1",
        ad_name: "Ad 1",
        spend: "100",
        impressions: "1000",
        reach: "800",
        clicks: "20",
        actions: [{ action_type: "messaging_conversation_started_7d", value: "3" }],
      }] });
    }
    if (item.url.includes("graph.facebook.com") && item.url.includes("/act_123?")) {
      return response({ id: "act_123", name: "Account 123", currency: "VND", timezone_name: "Asia/Ho_Chi_Minh", account_status: 1 });
    }
    if (item.url.includes("/rpc/v8_admin_control_overview")) return response({ pages: [], ad_accounts: [], health: {} });
    return response({ ok: true, data: [], count: 0 });
  };

  try { return await handler(calls); }
  finally {
    globalThis.fetch = originalFetch;
    const restore = (name, value) => value === undefined ? delete process.env[name] : process.env[name] = value;
    restore("META_ACCESS_TOKEN", originals.token);
    restore("AIGUKA_V9_CORE_URL", originals.coreUrl);
    restore("AIGUKA_V9_CORE_SERVICE_ROLE_KEY", originals.coreKey);
    restore("AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY", originals.reportingKey);
    restore("SUPABASE_SERVICE_ROLE_KEY", originals.legacyKey);
  }
}

function installedHandler() {
  const app = makeApp();
  installReportRoutes(app, { supabaseUrl: "https://example.supabase.co", publishableKey: "test-key" });
  return app.route("/functions/v1/aiguka-v8-report-api");
}

const urls = (calls) => calls.map((call) => call.url);

test("summary uses direct Meta inventory and Core customer metrics without stored ad snapshots", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "summary", from: "2026-08-05", to: "2026-08-05" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.source, "meta_live_plus_core_customer_metrics");
    assert.equal(res.payload.data.conversations, 4);
    assert.equal(res.payload.data.contacts, 2);
    assert.equal(res.payload.data.spend_with_tax, 105);
    assert.ok(urls(calls).some((url) => /v10_report_filter_registry$/.test(url)));
    assert.ok(urls(calls).some((url) => /v10_report_customer_metrics$/.test(url)));
    assert.ok(urls(calls).some((url) => url.includes("/act_123/campaigns?")));
    assert.ok(urls(calls).some((url) => url.includes("/act_123/adsets?")));
    assert.ok(urls(calls).some((url) => url.includes("/act_123/ads?")));
    assert.ok(urls(calls).some((url) => url.includes("/act_123/insights?")));
    assert.equal(urls(calls).some((url) => /v8_report_ads_test$/.test(url)), false);
    assert.equal(urls(calls).some((url) => /v8_report_daily_test$/.test(url)), false);
  });
});

test("ads and daily normally avoid stored performance RPCs while Leads retain history pagination", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "ads", from: "2026-08-01", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "meta_live_plus_core_customer_metrics");
    assert.equal(res.payload.data[0].conversations, 4);
    assert.equal(urls(calls).some((url) => /v8_report_ads_test$/.test(url)), false);
  });

  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "daily", from: "2026-08-01", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "meta_live_plus_core_customer_metrics");
    assert.ok(res.payload.data.some((row) => row.report_date === "2026-08-05" && row.conversations === 4));
    assert.equal(urls(calls).some((url) => /v8_report_ads_test$/.test(url)), false);
    assert.equal(urls(calls).some((url) => /v8_report_daily_test$/.test(url)), false);
  });

  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "leads", from: "2026-07-01", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "core_live_plus_reporting_history");
    assert.equal(res.payload.data[0].customer_name, "Nguyễn Văn An");
    const leadCall = calls.find((call) => /v8_report_leads_test$/.test(call.url));
    assert.ok(leadCall);
    assert.equal(leadCall.body.p_limit, 250);
    assert.equal(leadCall.body.p_offset, 0);
  }, { leadRow: true });
});

test("Lead rows read names and raw contacts from Core without copying them into Reporting", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "leads", from: "2026-08-05", to: "2026-08-05", limit: "250" } }, res);
    assert.equal(res.payload.source, "core_live_plus_reporting_history");
    assert.equal(res.payload.customer_data_source, "v10_core_live");
    assert.equal(res.payload.data[0].customer_name, "Nguyễn Văn An");
    assert.equal(res.payload.data[0].phone, "0965000111");
    assert.ok(urls(calls).some((url) => url.startsWith("https://core.example.co/rest/v1/v9_customers?")));
    assert.ok(urls(calls).some((url) => url.startsWith("https://core.example.co/rest/v1/v9_contacts?")));
  }, { leadRow: true });
});

test("Lead rows attach current Meta campaign, ad set and ad names by ad_id", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "leads", from: "2026-08-05", to: "2026-08-05", limit: "250" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.live_ad_dimension_enriched_count, 1);
    assert.equal(res.payload.data[0].ad_account_name, "Account 123");
    assert.equal(res.payload.data[0].campaign_id, "campaign-1");
    assert.equal(res.payload.data[0].campaign_name, "Campaign 1");
    assert.equal(res.payload.data[0].adset_id, "adset-1");
    assert.equal(res.payload.data[0].adset_name, "Ad set 1");
    assert.equal(res.payload.data[0].ad_name, "Ad 1");
    assert.equal(res.payload.data[0].ad_dimension_source, "meta_live_inventory");
    assert.ok(urls(calls).some((url) => url.includes("/act_123/ads?")));
  }, { leadRow: true });
});

test("Lead campaign filters run after live Meta enrichment instead of stale Reporting dimensions", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: {
      action: "leads",
      from: "2026-08-05",
      to: "2026-08-05",
      campaign_id: "campaign-1",
      search: "Ad set 1",
      limit: "25",
      offset: "0",
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.live_dimension_filtering, true);
    assert.equal(res.payload.count, 1);
    assert.equal(res.payload.data[0].campaign_name, "Campaign 1");
    const leadCall = calls.find((call) => /v8_report_leads_test$/.test(call.url));
    assert.equal(leadCall.body.p_campaign_id, null);
    assert.equal(leadCall.body.p_search, null);
    assert.equal(leadCall.body.p_limit, 10_000);
    assert.equal(leadCall.body.p_offset, 0);
  }, { leadRow: true });
});

test("Lead history still loads when live ad inventory is temporarily unavailable", async () => {
  await withFetch(async () => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "leads", from: "2026-08-05", to: "2026-08-05" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.count, 1);
    assert.equal(res.payload.data[0].ad_id, "ad-1");
    assert.equal(res.payload.data[0].campaign_name, null);
    assert.ok(res.payload.warnings.some((warning) => String(warning).startsWith("LEAD_LIVE_INVENTORY:")));
  }, { leadRow: true, failFilterRegistry: true });
});

test("filters and health expose the direct report source cutover", async () => {
  await withFetch(async (calls) => {
    const handler = installedHandler();
    const health = makeResponse();
    await handler({ query: { action: "health" } }, health);
    assert.equal(health.payload.version, 7);
    assert.equal(health.payload.snapshot_workers_required, false);
    assert.equal(health.payload.filter_source, "meta_live_inventory_plus_static_mapping");
    assert.equal(health.payload.customer_metric_source, "v10_core_live_customer_metrics");
    assert.equal(health.payload.lead_ad_dimension_source, "meta_live_inventory_by_ad_id");

    const filterResponse = makeResponse();
    await handler({ query: { action: "filters" } }, filterResponse);
    assert.equal(filterResponse.payload.source, "meta_live_inventory_plus_static_mapping");
    assert.equal(filterResponse.payload.data.ad_accounts.length, 1);
    assert.equal(filterResponse.payload.data.ads[0].effective_status, "ACTIVE");
    assert.ok(urls(calls).some((url) => /v10_report_filter_registry$/.test(url)));
    assert.equal(urls(calls).some((url) => /v8_report_filters_test$/.test(url)), false);
  });
});

test("missing Meta token uses stored ad facts only as an explicit outage fallback", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "ads", from: "2026-08-05", to: "2026-08-05" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.source, "supabase_fallback");
    assert.ok(res.payload.warnings.includes("META_ACCESS_TOKEN_MISSING"));
    assert.ok(urls(calls).some((url) => /v10_report_filter_registry$/.test(url)));
    assert.ok(urls(calls).some((url) => /v8_report_ads_test$/.test(url)));
    assert.equal(urls(calls).some((url) => url.includes("graph.facebook.com")), false);
  }, { meta: false });
});

test("Meta Insights failure falls back without reviving V2.1 routing", async () => {
  await withFetch(async (calls) => {
    const res = makeResponse();
    await installedHandler()({ query: { action: "summary", version: "2.1", from: "2026-08-05", to: "2026-08-05" } }, res);
    assert.equal(res.payload.source, "supabase_fallback");
    assert.ok(urls(calls).some((url) => /v8_report_ads_test$/.test(url)));
    assert.equal(urls(calls).some((url) => /v8_report_summary_v21$/.test(url)), false);
    assert.equal(urls(calls).some((url) => /v8_report_ads_v21$/.test(url)), false);
  }, { failInsights: true });
});
