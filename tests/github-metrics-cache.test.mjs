import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubMetricsCache } from '../lib/github-metrics-cache.js';

const settings = { owner: 'example', repo: 'spine', branch: 'main' };
const path = 'library_02/metrics.json';

test('reuses a metrics snapshot and its GitHub SHA within the cache window', async () => {
  let now = 1_000;
  let reads = 0;
  const cache = createGithubMetricsCache({ ttlMs: 15_000, now: () => now });
  const load = async () => ({
    current: { sha: 'sha-' + (++reads) },
    metrics: { entries: { preview: { views: reads } } },
  });

  const first = await cache.read(settings, path, load);
  const second = await cache.read(settings, path, load);

  assert.equal(reads, 1);
  assert.equal(first.current.sha, 'sha-1');
  assert.equal(second.current.sha, 'sha-1');
  assert.equal(second.metrics.entries.preview.views, 1);
});

test('returns independent metric snapshots so a request cannot mutate shared cache state', async () => {
  const cache = createGithubMetricsCache({ ttlMs: 15_000, now: () => 1_000 });
  const load = async () => ({
    current: { sha: 'sha-1' },
    metrics: { entries: { preview: { views: 4 } } },
  });

  const first = await cache.read(settings, path, load);
  first.metrics.entries.preview.views = 999;
  const second = await cache.read(settings, path, load);

  assert.equal(second.metrics.entries.preview.views, 4);
});

test('refreshes expired metrics snapshots and invalidates stale SHA after a conflict', async () => {
  let now = 1_000;
  let reads = 0;
  const cache = createGithubMetricsCache({ ttlMs: 100, now: () => now });
  const load = async () => ({
    current: { sha: 'sha-' + (++reads) },
    metrics: { entries: { preview: { views: reads } } },
  });

  const first = await cache.read(settings, path, load);
  now += 101;
  const expired = await cache.read(settings, path, load);
  cache.invalidate(settings, path);
  const afterConflict = await cache.read(settings, path, load);

  assert.equal(first.current.sha, 'sha-1');
  assert.equal(expired.current.sha, 'sha-2');
  assert.equal(afterConflict.current.sha, 'sha-3');
  assert.equal(reads, 3);
});

test('a successful write refreshes cached SHA and metrics without another GitHub read', async () => {
  let reads = 0;
  const cache = createGithubMetricsCache({ ttlMs: 15_000, now: () => 1_000 });
  const load = async () => {
    reads++;
    return { current: { sha: 'sha-old' }, metrics: { entries: { preview: { views: 1 } } } };
  };

  await cache.read(settings, path, load);
  cache.set(settings, path, { sha: 'sha-new' }, { entries: { preview: { views: 2 } } });
  const updated = await cache.read(settings, path, load);

  assert.equal(reads, 1);
  assert.equal(updated.current.sha, 'sha-new');
  assert.equal(updated.metrics.entries.preview.views, 2);
});
