import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __private__ as insightsPrivate } from "../v9-meta-ads-insights-worker.js";

const workerSource = fs.readFileSync(new URL("../v9-meta-ads-insights-worker.js", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../v9-admin-report-api-v2.js", import.meta.url), "utf8");
const startSource = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

test("Meta action metrics are parsed deterministically", () => {
  const actions = [
    { action_type: "link_click", value: "3" },
    { action_type: "lead", value: "2" },
    { action_type: "other", value: "99" },
  ];
  assert.equal(insightsPrivate.actionValue(actions, ["link_click"]), 3);
  assert.equal(insightsPrivate.actionValue(actions, ["lead"]), 2);
});

test("Meta Insights worker is limited to mapped Page ad accounts", () => {
  assert.match(workerSource, /v8_meta_page_ad_accounts/);
  assert.match(workerSource, /reporting_enabled=eq\.true/);
  assert.match(workerSource, /is_active=eq\.true/);
  assert.doesNotMatch(workerSource, /v8_meta_ad_accounts\?select=.*&limit=5000/);
});

test("Meta Insights worker upserts idempotently and refreshes V21 fact", () => {
  assert.match(workerSource, /v8_ads_daily_insights/);
  assert.match(workerSource, /ad_account_id,insight_date,ad_id/);
  assert.match(workerSource, /rpc\/v8_report_v21_refresh_day/);
  assert.match(workerSource, /time_increment/);
  assert.match(workerSource, /level: "ad"/);
});

test("Meta token is sent only as Authorization and never logged", () => {
  assert.match(workerSource, /authorization: `Bearer \$\{META_TOKEN\}`/);
  assert.doesNotMatch(workerSource, /access_token=/);
  assert.doesNotMatch(workerSource, /console\.(log|error).*META_TOKEN/);
});

test("Lead API enriches contacts from secure legacy storage without copying raw values to Reporting", () => {
  assert.match(apiSource, /v8_customers\?select=id,page_id,phone,zalo/);
  assert.match(apiSource, /contact_enriched_from_legacy_secure_store/);
  assert.match(apiSource, /legacy_secure/);
  assert.doesNotMatch(apiSource, /fact_contacts.*contact_value/);
});

test("startup launches Meta Insights only after Meta OAuth token is loaded", () => {
  const tokenLoad = startSource.indexOf("process.env.META_ACCESS_TOKEN = connection.accessToken");
  const workerStart = startSource.indexOf('startDetached("./v9-meta-ads-insights-worker.js")');
  assert.ok(tokenLoad >= 0);
  assert.ok(workerStart > tokenLoad);
  assert.match(startSource, /AIGUKA_V9_META_INSIGHTS_ENABLED/);
});
