import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migrationPath = "supabase/migrations/20260730203000_v9_report_compat_source_view.sql";
const sql = fs.readFileSync(migrationPath, "utf8");

test("stable dashboard RPC contracts read only the V9 materialized fact", () => {
  for (const rpc of [
    "v8_report_summary_test",
    "v8_report_daily_test",
    "v8_report_ads_test",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}\\(`, "i"));
  }
  assert.match(sql, /from public\.fact_daily_ad_performance f/i);
  assert.match(sql, /create or replace view public\.v9_report_compat_performance/i);
  assert.match(sql, /create function public\.v9_report_compat_filter/i);
  assert.doesNotMatch(sql, /v8_report_ad_performance_daily/i);
  assert.doesNotMatch(sql, /v8_report_daily_runtime_detail/i);
  assert.doesNotMatch(sql, /v8_messages_raw/i);
});

test("compatibility RPCs remain protected and fail fast", () => {
  assert.equal((sql.match(/perform public\.v8_assert_admin_request\(\);/gi) || []).length, 3);
  assert.equal((sql.match(/set_config\('statement_timeout','3000',true\)/gi) || []).length, 3);
  assert.match(sql, /date_range_too_large/i);
  assert.match(sql, /revoke all on public\.v9_report_compat_performance from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.v9_report_compat_filter/i);
});

test("legacy UI receives its existing JSON shape from V9 Reporting", () => {
  assert.equal((sql.match(/'source','v9_reporting_fact'/g) || []).length, 3);
  assert.match(sql, /'data',to_jsonb\(a\)/i);
  assert.match(sql, /'count',\(select count\(\*\) from final\)/i);
  assert.match(sql, /'warnings'/i);
  assert.match(sql, /'cost_per_conversation'/i);
  assert.match(sql, /'cost_per_contact'/i);
});
