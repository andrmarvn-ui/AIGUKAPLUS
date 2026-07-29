import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker = fs.readFileSync("v9-reporting-conversation-refresh-worker.js", "utf8");
const readinessMigration = fs.readFileSync("supabase/migrations/20260730213000_v9_conversation_readiness_and_schema_reload.sql", "utf8");
const guardMigration = fs.readFileSync("supabase/migrations/20260730214000_v9_conversation_rpc_exposure_guard.sql", "utf8");

test("conversation worker retries only schema-cache startup failures", () => {
  assert.match(worker, /const VERSION = "1\.0\.2"/);
  assert.match(worker, /attempt <= 4/);
  assert.match(worker, /isSchemaCacheError/);
  assert.match(worker, /pgrst202/);
  assert.match(worker, /attempt \* 2000/);
});

test("daily refresh preserves ready status and reloads PostgREST", () => {
  assert.match(readinessMigration, /conversation_readiness_false_block_not_found/);
  assert.match(readinessMigration, /'ready'',true/);
  assert.match(readinessMigration, /pg_notify\('pgrst','reload schema'\)/);
  assert.match(readinessMigration, /pg_notify\('pgrst','reload config'\)/);
});

test("conversation refresh RPC is visible but remains service-role guarded", () => {
  assert.match(guardMigration, /SERVICE_ROLE_REQUIRED/);
  assert.match(guardMigration, /v_request_role<>'service_role'/);
  assert.match(guardMigration, /grant execute on function public\.v9_refresh_conversation_fact\(timestamptz\) to anon,authenticated,service_role/);
  assert.match(guardMigration, /pg_notify\('pgrst','reload schema'\)/);
  assert.match(guardMigration, /pg_notify\('pgrst','reload config'\)/);
  assert.match(guardMigration, /'''conversation_fact_ready'',false','''conversation_fact_ready'',true'/);
});
