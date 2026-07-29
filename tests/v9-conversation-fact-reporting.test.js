import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync("supabase/migrations/20260730211000_v9_conversation_fact_refresh_and_lead_rpc.sql", "utf8");
const filters = fs.readFileSync("supabase/migrations/20260730210000_v9_report_filters_compat.sql", "utf8");
const worker = fs.readFileSync("v9-reporting-conversation-refresh-worker.js", "utf8");
const start = fs.readFileSync("start.js", "utf8");

test("Lead RPC reads only the materialized conversation fact at request time", () => {
  assert.match(migration, /create or replace function public\.v8_report_leads_test/i);
  assert.match(migration, /from public\.v8_report_v21_conversation_fact r/i);
  assert.match(migration, /'source','v9_conversation_fact'/i);
  assert.match(migration, /perform public\.v8_assert_admin_request\(\)/i);
  assert.match(migration, /set_config\('statement_timeout','3000',true\)/i);
  const rpcStart = migration.indexOf("create or replace function public.v8_report_leads_test");
  const rpcSql = migration.slice(rpcStart);
  assert.doesNotMatch(rpcSql, /v8_report_lead_detail/i);
  assert.doesNotMatch(rpcSql, /v8_report_conversation_attribution/i);
  assert.doesNotMatch(rpcSql, /v8_messages_raw/i);
});

test("conversation refresh is incremental, service-role only and idempotent", () => {
  assert.match(migration, /create or replace function public\.v9_refresh_conversation_fact/i);
  assert.match(migration, /on conflict\(source_channel,conversation_id\) do update/i);
  assert.match(migration, /greatest\([\s\S]*r\.updated_at[\s\S]*r\.conversation_started_at/i);
  assert.match(migration, /revoke all on function public\.v9_refresh_conversation_fact[^;]+from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.v9_refresh_conversation_fact[^;]+to service_role/i);
});

test("conversation worker uses a bounded window and never logs contact values", () => {
  assert.match(worker, /cycleNo === 1 \? 3 \* 86_400_000 : 30 \* 60_000/);
  assert.match(worker, /rpc\/v9_refresh_conversation_fact/);
  assert.match(worker, /raw_contact_logging: false/);
  assert.doesNotMatch(worker, /contact_value|normalized_value|\.phone|\.zalo/);
  assert.match(start, /startDetached\("\.\/v9-reporting-conversation-refresh-worker\.js"\)/);
});

test("stable filters read V9 dimensions and exclude unresolved ads", () => {
  assert.match(filters, /from public\.dim_pages/i);
  assert.match(filters, /from public\.dim_ads/i);
  assert.match(filters, /from public\.fact_daily_ad_performance/i);
  assert.match(filters, /where page_id is not null and ad_id is not null/i);
  assert.match(filters, /'source','v9_reporting_dimensions'/i);
  assert.doesNotMatch(filters, /v8_meta_page_registry|v8_meta_ad_account_registry|ad_mappings/);
});
