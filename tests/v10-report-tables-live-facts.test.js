import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { patchV10ReportTablesUi } from "../dashboard-report-v10-patch.js";

const viewSql = fs.readFileSync("supabase/migrations/20260805152500_v10_report_live_fact_view.sql", "utf8");
const rpcSql = fs.readFileSync("supabase/migrations/20260805152600_v10_report_live_fact_rpcs.sql", "utf8");
const leadsSql = fs.readFileSync("supabase/migrations/20260805152700_v10_report_leads_messages_comments.sql", "utf8");
const zeroDeliverySql = fs.readFileSync("supabase/migrations/20260805152800_v10_report_daily_zero_delivery_accounts.sql", "utf8");
const serverPatch = fs.readFileSync("patch-server.js", "utf8");
const handler = fs.readFileSync("report-handler-v10.js", "utf8");

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

test("daily table retains active accounts when Meta returns no delivery rows", () => {
  assert.match(zeroDeliverySql, /from public\.v8_meta_ad_accounts aa/i);
  assert.match(zeroDeliverySql, /from public\.v8_meta_page_ad_accounts l/i);
  assert.match(zeroDeliverySql, /generate_series\(v_from,v_to,interval '1 day'\)/);
  assert.match(zeroDeliverySql, /zero_delivery/);
  assert.match(zeroDeliverySql, /Meta không ghi nhận phân phối trong ngày/);
  assert.match(zeroDeliverySql, /aa\.reporting_enabled=true/);
  assert.match(zeroDeliverySql, /aa\.is_active=true/);
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

test("legacy dashboard patch still preserves completed labels for fallback", () => {
  const html = patchV10ReportTablesUi("<html><body></body></html>");
  assert.match(html, /Khách nhắn tin/);
  assert.match(html, /Khách comment/);
  assert.match(html, /Bình luận Facebook/);
  assert.match(html, /Tự nhiên \/ chưa xác định/);
  assert.match(html, /customer_source_type/);
  assert.match(serverPatch, /patchV10ReportTablesUi/);
});

test("exports preserve customer labels and direct Meta/Core source separation", () => {
  assert.match(handler, /Bình luận Facebook/);
  assert.match(handler, /Messenger \/ tự nhiên/);
  assert.match(handler, /Loại khách/);
  assert.match(handler, /Tự nhiên \/ chưa xác định/);
  assert.match(handler, /meta_live_plus_core_customer_metrics/);
  assert.match(handler, /core_live_plus_reporting_history/);
  assert.match(handler, /supabase_fallback/);
  assert.match(handler, /funding_source_display/);
});
