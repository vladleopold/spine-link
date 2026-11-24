import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app = readFileSync(new URL('../src/SpineApp.tsx', import.meta.url), 'utf8');

test('local preview selects an exact Spine 4.0, 4.1, or 4.2 Web Player runtime', () => {
  assert.match(app, /pinnedVersions(?::\s*Record<string,\s*string>)?\s*=\s*\{\s*"4\.0"\s*:\s*"4\.0\.31"\s*,\s*"4\.1"\s*:\s*"4\.1\.56"\s*,\s*"4\.2"\s*:\s*"4\.2\.120"/);
  assert.match(app, /function modernSpine4Runtime/);
});

test('local binary previews use the URL option expected by each runtime generation', () => {
  assert.match(app, /function spinePlayerSourceConfig/);
  assert.match(app, /binaryUrl:/);
  assert.match(app, /skelUrl:/);
  assert.match(app, /skeleton:/);
  assert.equal((app.match(/spinePlayerSourceConfig\(/g) || []).length, 4);
});

test('Spine 3.7 binary skeletons are blocked before an incompatible player is constructed', () => {
  assert.match(app, /Spine 3\.7 Web Player requires a JSON skeleton/);
});
