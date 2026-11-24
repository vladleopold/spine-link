import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeVersionOverrideForSpineSkeleton } from '../lib/spine-runtime-file-selection.js';

test('rejects incompatible Spine 3.7 binary skeletons instead of routing them to 3.8', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('3.7.94', true), '');
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
