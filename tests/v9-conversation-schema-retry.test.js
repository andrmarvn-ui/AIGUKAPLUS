import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker = fs.readFileSync("v9-reporting-conversation-refresh-worker.js", "utf8");
const readinessMigration = fs.readFileSync("supabase/migrations/20260730213000_v9_conversation_readiness_and_schema_reload.sql", "utf8");
const relockMigration = fs.readFileSync("supabase/migrations/20260730215000_v9_conversation_rpc_relock.sql", "utf8");

test("conversation worker directly syncs the materialized fact without RPC schema cache", () => {
  assert.match(worker, /const VERSION = "1\.2\.1"/);
  assert.match(worker, /v8_report_conversation_attribution\?select=/);
  assert.match(worker, /v8_report_v21_conversation_fact\?on_conflict=source_channel,conversation_id/);
  assert.match(worker, /transport: "direct_postgrest_table_upsert"/);
  assert.match(worker, /raw_contact_logging: false/);
  assert.doesNotMatch(worker, /rpc\/v9_refresh_conversation_fact/);
  assert.doesNotMatch(worker, /schema cache|pgrst202|could not find the function/i);
});

test("direct sync is bounded and idempotent", () => {
  assert.match(worker, /cycleNo === 1 \? 3 \* 86_400_000 : 30 \* 60_000/);
  assert.match(worker, /const MAX_ROWS = 20_000/);
  assert.match(worker, /resolution=merge-duplicates,return=minimal/);
  assert.match(worker, /mapConversationRow/);
  assert.match(worker, /fact_version: 21/);
});

test("daily refresh preserves ready status", () => {
  assert.match(readinessMigration, /conversation_readiness_false_block_not_found/);
  assert.match(readinessMigration, /'ready'',true/);
});

test("unused refresh RPC is relocked after direct worker cutover", () => {
  assert.match(relockMigration, /revoke execute on function public\.v9_refresh_conversation_fact\(timestamptz\) from anon,authenticated/);
  assert.match(relockMigration, /grant execute on function public\.v9_refresh_conversation_fact\(timestamptz\) to service_role/);
  assert.match(relockMigration, /pg_notify\('pgrst','reload schema'\)/);
});

test("benchmark collection is shadow-only and source verified", () => {
  assert.match(worker, /v9_shadow_benchmark_runs\?select=\*&status=eq\.active/);
  assert.match(worker, /fetchPancakeConversationDetails/);
  assert.match(worker, /aicake_source_verified/);
  assert.match(worker, /source_verified_v2/);
  assert.match(worker, /transport_locked: true/);
  assert.match(worker, /BENCHMARK_INTERVAL_MS/);
  assert.doesNotMatch(worker, /sendMessage|graph\.facebook\.com/);
});