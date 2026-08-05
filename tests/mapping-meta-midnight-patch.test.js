import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const patchFile = 'patch-mapping-meta-midnight-delivery.js';

test('Meta delivery patch handles the ad-account midnight boundary', () => {
  execFileSync(process.execPath, ['--check', patchFile], { stdio: 'pipe' });

  const patch = fs.readFileSync(patchFile, 'utf8');
  const start = fs.readFileSync('start.js', 'utf8');
  const server = fs.readFileSync('server-v10-final.js', 'utf8');

  assert.match(patch, /timezone_name,timezone_offset_hours_utc/);
  assert.match(patch, /date_preset=yesterday/);
  assert.match(patch, /META_MIDNIGHT_GRACE_HOURS \|\| 4/);
  assert.match(patch, /todaySpend > 0 \|\| todayImpressions > 0/);
  assert.match(patch, /account_has_recent_delivery/);
  assert.match(patch, /previous_day_midnight_grace/);

  const patchPosition = start.indexOf('patch-mapping-meta-midnight-delivery.js');
  const serverPosition = start.indexOf('v10-server-release.js');
  assert.ok(patchPosition >= 0, 'Startup must include the Mapping Meta delivery feature patch.');
  assert.ok(serverPosition > patchPosition, 'The feature patch must run before the final server imports Mapping Center.');
  assert.doesNotMatch(start, /safeImport\("\.\/patch-server\.js"/);
  assert.doesNotMatch(start, /safeImport\("\.\/patch-direct-meta-dashboard\.js"/);
  assert.match(server, /installMappingCenter\(app/);
});
