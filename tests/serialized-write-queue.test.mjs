import test from 'node:test';
import assert from 'node:assert/strict';
import { runSerializedWrite } from '../lib/serialized-write-queue.js';

test('serializes writes to the same GitHub metrics file', async () => {
  let active = 0;
  let maximumActive = 0;
  await Promise.all(Array.from({ length: 8 }, (_, index) => runSerializedWrite('library_02/metrics.json', async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  })));
  assert.equal(maximumActive, 1);
});

test('does not serialize independent metrics files', async () => {
  let active = 0;
  let maximumActive = 0;
  await Promise.all(['library_01/metrics.json', 'library_02/metrics.json'].map((key) => runSerializedWrite(key, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(maximumActive, 2);
});

test('releases a write queue after a rejected mutation', async () => {
  await assert.rejects(runSerializedWrite('metrics', async () => { throw new Error('expected'); }), /expected/);
  assert.equal(await runSerializedWrite('metrics', async () => 'recovered'), 'recovered');
});
