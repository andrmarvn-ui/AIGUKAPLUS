import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __private__ as sourcePrivate } from "../v10-report-sources.js";
import { __private__ as inventoryPrivate } from "../meta-direct-inventory.js";

const filters = {
  pages: [{ page_id: "p1", page_name: "Page 1" }],
  ad_accounts: [{ ad_account_id: "act_123", ad_account_name: "Account 123" }],
  ads: [{
    page_id: "p1",
    page_name: "Page 1",
    ad_account_id: "123",
    ad_account_name: "Account 123",
    campaign_id: "c1",
    campaign_name: "Campaign 1",
    adset_id: "s1",
    adset_name: "Ad set 1",
    ad_id: "a1",
    ad_name: "Ad 1",
  }],
};

test("Core metrics inherit ad dimensions without changing counts", () => {
  const rows = sourcePrivate.attachDimensions([{
    report_date: "2026-08-06",
    page_id: "p1",
    ad_id: "a1",
    conversations: 7,
    contacts: 3,
    hot_leads: 3,
    message_count: 15,
  }], filters, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ad_account_id, "123");
  assert.equal(rows[0].campaign_id, "c1");
  assert.equal(rows[0].conversations, 7);
  assert.equal(rows[0].contacts, 3);
  assert.equal(rows[0].customer_metric_source, "v10_core_live");
});

test("account and campaign filters apply after Core metric dimension attachment", () => {
  const input = [{ report_date: "2026-08-06", page_id: "p1", ad_id: "a1", conversations: 2, contacts: 1 }];
  assert.equal(sourcePrivate.attachDimensions(input, filters, { ad_account_id: "act_123", campaign_id: "c1" }).length, 1);
  assert.equal(sourcePrivate.attachDimensions(input, filters, { ad_account_id: "999" }).length, 0);
  assert.equal(sourcePrivate.attachDimensions(input, filters, { campaign_id: "other" }).length, 0);
});

test("customer metrics aggregate by ad and by day/account/page", () => {
  const rows = sourcePrivate.attachDimensions([
    { report_date: "2026-08-05", page_id: "p1", ad_id: "a1", conversations: 2, contacts: 1, message_count: 4 },
    { report_date: "2026-08-06", page_id: "p1", ad_id: "a1", conversations: 3, contacts: 2, message_count: 6 },
  ], filters, {});
  const ads = sourcePrivate.aggregateByAd(rows);
  const daily = sourcePrivate.aggregateDaily(rows);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].conversations, 5);
  assert.equal(ads[0].contacts, 3);
  assert.equal(daily.length, 2);
});

test("Meta live inventory status overrides static mapping but historical mapping remains", () => {
  const rows = inventoryPrivate.mergeHistoricalMappings({
    ads: [
      { ad_id: "a1", effective_status: "PAUSED" },
      { ad_id: "old", effective_status: "PAUSED" },
    ],
  }, [{ ad_id: "a1", effective_status: "ACTIVE", inventory_source: "meta_live_inventory" }]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.ad_id === "a1").effective_status, "ACTIVE");
  assert.equal(rows.find((row) => row.ad_id === "old").inventory_source, "static_mapping_history");
});

test("redundant snapshot workers are opt-in while Lead publisher and sync remain active", () => {
  const start = fs.readFileSync("start.js", "utf8");
  assert.match(start, /AIGUKA_V9_REPORTING_LEGACY_REFRESH \|\| "false"/);
  assert.match(start, /AIGUKA_V9_META_INSIGHTS_ENABLED \|\| "false"/);
  assert.match(start, /startDetached\("\.\/v9-reporting-publisher\.js"\)/);
  assert.match(start, /startDetached\("\.\/v9-reporting-sync-worker\.js"\)/);
  assert.match(start, /startDetached\("\.\/v9-legacy-inbox-bridge\.js"\)/);
});
