import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __private__ } from "../v9-meta-ad-page-resolver-worker.js";

const source = fs.readFileSync(new URL("../v9-meta-ad-page-resolver-worker.js", import.meta.url), "utf8");
const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");

test("story Page id is extracted only from Page_post format", () => {
  assert.equal(__private__.storyPageId("104810069068200_123456"), "104810069068200");
  assert.equal(__private__.storyPageId("not-a-story"), null);
});

test("creative actor evidence is restricted to known Pages", () => {
  const known = new Set(["104810069068200", "985632314640803"]);
  assert.equal(__private__.resolveCreativePage({ actor_id: "985632314640803" }, known), "985632314640803");
  assert.equal(__private__.resolveCreativePage({ actor_id: "999", object_story_id: "104810069068200_1" }, known), "104810069068200");
  assert.equal(__private__.resolveCreativePage({ actor_id: "999" }, known), null);
});

test("resolver uses Meta creative fields and never guesses a two-Page account", () => {
  assert.match(source, /creative\{id,actor_id,effective_object_story_id,object_story_id\}/);
  assert.match(source, /mappedPages\.length === 1/);
  assert.match(source, /knownPages\.has/);
});

test("resolver updates source insights, ad dimension and both fact layers", () => {
  assert.match(source, /v8_ads_daily_insights/);
  assert.match(source, /dim_ads/);
  assert.match(source, /rpc\/v8_report_v21_refresh_day/);
  assert.match(source, /fact_daily_ad_performance/);
});

test("resolver has no outbound or AI path", () => {
  assert.doesNotMatch(source, /messages\?access_token|\/me\/messages|graph\.facebook\.com.*messages/);
  assert.doesNotMatch(source, /openai|responses\/v1|chat\/completions/i);
  assert.match(start, /v9-meta-ad-page-resolver-worker\.js/);
});
