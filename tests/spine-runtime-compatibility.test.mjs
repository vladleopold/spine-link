import test from 'node:test';
import assert from 'node:assert/strict';
import { isSpine37BinaryUnsupported } from '../lib/spine-runtime-file-selection.js';

test('rejects Spine 3.7 binary skeletons because the 3.7 web player requires JSON', () => {
  assert.equal(isSpine37BinaryUnsupported('3.7.94', true), true);
});

test('keeps Spine 3.7 JSON skeletons playable', () => {
  assert.equal(isSpine37BinaryUnsupported('3.7.94', false), false);
});

test('keeps binary skeletons supported by Spine 3.8 and later runtimes', () => {
  assert.equal(isSpine37BinaryUnsupported('3.8.99', true), false);
  assert.equal(isSpine37BinaryUnsupported('4.2.120', true), false);
});
