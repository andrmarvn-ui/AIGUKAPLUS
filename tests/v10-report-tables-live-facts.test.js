import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { patchV10ReportTablesUi } from "../dashboard-report-v10-patch.js";

const viewSql = fs.readFileSync("supabase/migrations/20260805152500_v10_report_live_fact_view.sql", "utf8");
const rpcSql = fs.readFileSync("supabase/migrations/20260805152600_v10_report_live_fact_rpcs.sql", "utf8");
const leadsSql = fs.readFileSync("supabase/migrations/20260805152700_v10_report_leads_messages_comments.sql", "utf8");
const serverPatch = fs.readFileSync("patch-server.js", "utf8");
const handler = fs.readFileSync("report-handler.js", "utf8");

test("performance view joins Meta spend to live V10 customer facts", () => {
  assert.match(viewSql, /from public\.fact_daily_ad_performance/i);
  assert.match(viewSql, /from public\.fact_messages/i);
  assert.match(viewSql, /from public\.fact_contacts/i);
  assert.match(viewSql, /customer_message','customer_postback/);
  assert.match(viewSql, /array_agg\(mb\.ad_id order by mb\.occurred_at\)/);
  assert.match(viewSql, /runtime_only/);
  assert.match(viewSql, /Tự nhiên \/ chưa xác định/);
  assert.match(viewSql, /m\.customer_id <> m\.page_id/);
});

test("daily and ads RPCs share the unified facts without organic ads pollution", () => {
  assert.match(rpcSql, /v10_live_reporting_unified/g);
  assert.match(rpcSql, /bool_or\(data_match_status in \('matched','runtime_only'\)\) has_runtime_data/);
  assert.match(rpcSql, /bool_or\(data_match_status in \('matched','ads_only'\)\) has_ads_data/);
  assert.match(rpcSql, /where ad_id is not null/);
  assert.match(rpcSql, /cost_per_conversation/);
  assert.match(rpcSql, /cost_per_contact/);
});

test("lead RPC includes comments and excludes Page self activity", () => {
  assert.match(leadsSql, /customer_comment/);
  assert.match(leadsSql, /customer_source_type/);
  assert.match(leadsSql, /comment_customer_count/);
  assert.match(leadsSql, /message_customer_count/);
  assert.match(leadsSql, /m\.customer_id <> m\.page_id/);
  assert.match(leadsSql, /meta_comment/);
  assert.match(leadsSql, /Bình luận|bình luận/);
});

test("dashboard UI exposes message and comment counters and organic daily rows", () => {
  const html = patchV10ReportTablesUi("<html><body></body></html>");
  assert.match(html, /Khách nhắn tin/);
  assert.match(html, /Khách comment/);
  assert.match(html, /Bình luận Facebook/);
  assert.match(html, /Tự nhiên \/ chưa xác định/);
  assert.match(html, /customer_source_type/);
  assert.match(serverPatch, /patchV10ReportTablesUi/);
});

test("exports preserve completed source labels", () => {
  assert.match(handler, /Bình luận Facebook/);
  assert.match(handler, /Messenger \/ tự nhiên/);
  assert.match(handler, /Loại khách/);
  assert.match(handler, /Tự nhiên \/ chưa xác định/);
  assert.match(handler, /v10_live_reporting_unified/);
});
