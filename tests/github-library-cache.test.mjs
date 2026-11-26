import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubLibraryFoldersCache } from '../lib/github-library-folders-cache.js';

test('reuses collection discovery within the TTL and returns independent arrays', async () => {
  let now = 1_000;
  let reads = 0;
  const cache = createGithubLibraryFoldersCache({ ttlMs: 60_000, now: () => now });
  const load = async () => ['library_03', 'library_02'];

  const first = await cache.read('repo/main', async () => { reads++; return load(); });
  first.push('mutated-by-caller');
  const second = await cache.read('repo/main', async () => { reads++; return load(); });

  assert.equal(reads, 1);
  assert.deepEqual(second, ['library_03', 'library_02']);
});

test('coalesces concurrent collection discovery requests', async () => {
  const cache = createGithubLibraryFoldersCache({ ttlMs: 60_000, now: () => 1_000 });
  let reads = 0;
  let finish;
  const load = () => {
    reads++;
    return new Promise(resolve => { finish = () => resolve(['library_02']); });
  };

  const first = cache.read('repo/main', load);
  const second = cache.read('repo/main', load);
  await Promise.resolve();
  finish();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(reads, 1);
  assert.deepEqual(a, ['library_02']);
  assert.deepEqual(b, ['library_02']);
});

test('serves the last successful collection discovery when a refresh fails', async () => {
  let now = 1_000;
  const cache = createGithubLibraryFoldersCache({ ttlMs: 100, now: () => now });
  await cache.read('repo/main', async () => ['library_02']);
  now += 101;

  const stale = await cache.read('repo/main', async () => {
    throw new Error('GitHub API rate limit exceeded');
  });

  assert.deepEqual(stale, ['library_02']);
});

test('refreshes an expired collection list after a successful rotation', async () => {
  let now = 1_000;
  const cache = createGithubLibraryFoldersCache({ ttlMs: 100, now: () => now });
  const first = await cache.read('repo/main', async () => ['library_02']);
  now += 101;
  const refreshed = await cache.read('repo/main', async () => ['library_03', 'library_02']);

  assert.deepEqual(first, ['library_02']);
  assert.deepEqual(refreshed, ['library_03', 'library_02']);
});


test('stale collection snapshots back off after a failed refresh', async () => {
  let now = 1_000;
  let reads = 0;
  const cache = createGithubLibraryFoldersCache({ ttlMs: 100, now: () => now });
  await cache.read('repo/main', async () => { reads++; return ['library_02']; });
  now += 101;
  const stale = await cache.read('repo/main', async () => { reads++; throw new Error('rate limit'); });
  const backedOff = await cache.read('repo/main', async () => { reads++; return ['unexpected']; });
  assert.deepEqual(stale, ['library_02']);
  assert.deepEqual(backedOff, ['library_02']);
  assert.equal(reads, 2);
});

test('an in-flight folder scan cannot overwrite a newer scan after invalidation', async () => {
  const cache = createGithubLibraryFoldersCache({ ttlMs: 60_000, now: () => 1_000 });
  let finishOld;
  const oldRead = cache.read('repo/main', () => new Promise(resolve => { finishOld = () => resolve(['library_01']); }));
  await Promise.resolve();
  cache.invalidate('repo/main');
  const fresh = await cache.read('repo/main', async () => ['library_02']);
  finishOld();
  await oldRead;
  const cached = await cache.read('repo/main', async () => { throw new Error('new snapshot should remain cached'); });
  assert.deepEqual(fresh, ['library_02']);
  assert.deepEqual(cached, ['library_02']);
});
