import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimeVersionOverrideForSpineSkeleton } from '../lib/spine-runtime-file-selection.js';

test('routes Spine 3.7 binary skeletons through the binary-capable 3.8 player', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('3.7.94', true), '3.8');
});

test('keeps Spine 3.7 JSON skeletons on their native 3.7 player', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('3.7.94', false), '');
});

test('does not override native Spine 3.8 binary runtime selection', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('3.8.99', true), '');
});

test('does not override Spine 4.x runtime selection', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('4.2.120', true), '');
});


test('allows public archive reads when preview deployments have no GitHub token', () => {
  const source = readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');
  assert.match(source, /const token = process\\.env\\.GITHUB_TOKEN \\|\\| ''/);
  assert.doesNotMatch(source, /GITHUB_TOKEN is not configured/);
});
