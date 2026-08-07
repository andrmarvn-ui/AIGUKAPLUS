import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const mergePatch = fs.readFileSync("patch-v10-turn-merge-authority.js", "utf8");
const migration = fs.readFileSync("supabase/migrations/20260807180500_v10_latest_customer_cluster_debounce_authority.sql", "utf8");
const assembler = fs.readFileSync("v10/core/conversation-assembler.js", "utf8");

test("conversation assembler explicitly rejects latest-message authority", () => {
  assert.match(assembler, /latest_message_is_not_authoritative:\s*true/);
});

test("every eligible customer event resets one debounced decision job", () => {
  assert.match(migration, /decision_eligible/);
  assert.match(migration, /merged_into_newer_customer_cluster/);
  assert.match(migration, /greatest\(now\(\),\s*v_event\.received_at\s*\+\s*make_interval/);
  assert.match(migration, /merge_all_prior_unanswered_customer_messages/);
  assert.doesNotMatch(migration, /if\s+not\s+v_contact_captured\s+then/i);
});

test("outbound holds stale reply and guarantees merged replacement work", () => {
  assert.match(mergePatch, /CUSTOMER_CLUSTER_ADVANCED_WAIT_MERGE/);
  assert.match(mergePatch, /ensureLatestCustomerClusterJob/);
  assert.match(mergePatch, /v10_outbound_merge_guarantee/);
  assert.match(mergePatch, /merge_job_ensured/);
});

test("janitor dedupes only identical customer-message frontiers", () => {
  assert.match(mergePatch, /clusterFrontier/);
  assert.match(mergePatch, /duplicate_customer_cluster/);
  assert.match(mergePatch, /exact same customer-message frontier/);
  assert.match(mergePatch, /conversation_merge_authority:\s*"core_ingest_debounce"/);
  assert.doesNotMatch(mergePatch, /A newer pending customer event exists in the same conversation and will carry the full history/);
});
