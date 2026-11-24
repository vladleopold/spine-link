import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadPublicSpineWithoutToken } from '../lib/github-read-access.js';

test('public Spine preview and asset reads do not require a production token', () => {
  assert.equal(canReadPublicSpineWithoutToken('', 'vladleopold', 'spine'), true);
  assert.equal(canReadPublicSpineWithoutToken('', 'VladLeopold', 'Spine'), true);
});

test('non-public repositories still require a server-side GitHub token', () => {
  assert.equal(canReadPublicSpineWithoutToken('', 'example', 'private-spine'), false);
  assert.equal(canReadPublicSpineWithoutToken('', 'vladleopold', 'private-spine'), false);
  assert.equal(canReadPublicSpineWithoutToken('server-token', 'example', 'private-spine'), true);
});
