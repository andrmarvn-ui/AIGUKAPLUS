import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('committed Mapping Center handles the ad-account midnight boundary', () => {
  const route = fs.readFileSync('src/routes/mappingCenterRoutes.js', 'utf8');
  const start = fs.readFileSync('start.js', 'utf8');
  const server = fs.readFileSync('server-v10-final.js', 'utf8');

  assert.match(route, /timezone_name,timezone_offset_hours_utc/);
  assert.match(route, /date_preset=yesterday/);
  assert.match(route, /META_MIDNIGHT_GRACE_HOURS \|\| 4/);
  assert.match(route, /todaySpend > 0 \|\| todayImpressions > 0/);
  assert.match(route, /account_has_recent_delivery/);
  assert.match(route, /previous_day_midnight_grace/);
  assert.doesNotMatch(start, /patch-mapping-meta-midnight-delivery\.js/);
  assert.doesNotMatch(start, /safeImport\("\.\/patch-server\.js"/);
  assert.doesNotMatch(start, /safeImport\("\.\/patch-direct-meta-dashboard\.js"/);
  assert.match(server, /installMappingCenter\(app/);
});
