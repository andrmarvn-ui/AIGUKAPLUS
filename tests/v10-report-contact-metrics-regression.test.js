import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync("supabase/migrations/20260807130500_v10_customer_report_contacts_multisource.sql", "utf8");
const reportSources = fs.readFileSync("v10-report-sources.js", "utf8");
const bridge = fs.readFileSync("v9-core-bridge-bootstrap.js", "utf8");

test("customer report contact metrics remain bridge-callable and multi-source", () => {
  assert.match(reportSources, /v10_report_customer_metrics/);
  assert.match(bridge, /AIGUKA_V9_CORE_SERVICE_ROLE_KEY = publishableKey/);
  assert.match(bridge, /x-aiguka-core-bridge/);

  assert.match(migration, /aiguka_private\.v9_bridge_authorized\(\)/);
  assert.match(migration, /grant execute on function public\.v10_report_customer_metrics[\s\S]*anon/);
  assert.match(migration, /public\.v9_contacts/);
  assert.match(migration, /public\.v10_followup_contact_guard/);
  assert.match(migration, /pancake_contact_tag/);
  assert.match(migration, /public\.v9_shadow_observations/);
  assert.match(migration, /contact_detector_observation/);
  assert.match(migration, /multisource_contact/);
});
