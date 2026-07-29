import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker = fs.readFileSync("v9-reporting-conversation-refresh-worker.js", "utf8");
const migration = fs.readFileSync("supabase/migrations/20260730213000_v9_conversation_readiness_and_schema_reload.sql", "utf8");

test("conversation worker retries only schema-cache startup failures", () => {
  assert.match(worker, /const VERSION = "1\.0\.1"/);
  assert.match(worker, /attempt <= 4/);
  assert.match(worker, /isSchemaCacheError/);
  assert.match(worker, /pgrst202/);
  assert.match(worker, /attempt \* 2000/);
});

test("daily refresh preserves ready status and reloads PostgREST", () => {
  assert.match(migration, /conversation_readiness_false_block_not_found/);
  assert.match(migration, /'ready'',true/);
  assert.match(migration, /pg_notify\('pgrst','reload schema'\)/);
  assert.match(migration, /pg_notify\('pgrst','reload config'\)/);
});
