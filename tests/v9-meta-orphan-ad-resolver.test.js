import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __private__ } from "../v9-meta-orphan-ad-resolver-worker.js";

const source = fs.readFileSync(new URL("../v9-meta-orphan-ad-resolver-worker.js", import.meta.url), "utf8");
const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

test("direct orphan lookup resolves only known Page evidence", () => {
  const pages = new Set(["104810069068200", "985632314640803"]);
  assert.equal(__private__.resolveOrphanPage({ actor_id: "985632314640803" }, pages), "985632314640803");
  assert.equal(__private__.resolveOrphanPage({ object_story_id: "104810069068200_1" }, pages), "104810069068200");
  assert.equal(__private__.resolveOrphanPage({ actor_id: "999" }, pages), null);
});

test("orphan worker only queries Insights rows with missing Page", () => {
  assert.match(source, /page_id=is\.null/);
  assert.match(source, /v8_ads_daily_insights/);
  assert.match(source, /graph\.facebook\.com\/\$\{GRAPH_VERSION\}\/\$\{adId\}/);
});

test("orphan worker refreshes affected fact dates and has no outbound", () => {
  assert.match(source, /rpc\/v8_report_v21_refresh_day/);
  assert.doesNotMatch(source, /\/me\/messages|messages\?access_token|openai|chat\/completions/i);
  assert.match(start, /v9-meta-orphan-ad-resolver-worker\.js/);
});
