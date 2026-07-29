import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sql = fs.readFileSync("supabase/migrations/20260730212000_v9_conversation_fact_ownership_fix.sql", "utf8");

test("daily V21 refresh no longer owns conversation fact deletion", () => {
  assert.match(sql, /pg_get_functiondef/);
  assert.match(sql, /conversation_fact_delete_block_not_found/);
  assert.match(sql, /Conversation grain is owned by v9_refresh_conversation_fact/);
  assert.match(sql, /daily_refresh_delete_disabled/);
  assert.match(sql, /select public\.v9_refresh_conversation_fact\('epoch'/);
  assert.match(sql, /notify pgrst,'reload schema'/);
});
