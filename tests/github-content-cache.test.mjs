import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedGithubText, invalidateCachedGithubText } from '../lib/github-content-cache.js';

test('an in-flight raw index read cannot overwrite a fresh value after commit invalidation', async () => {
  const settings = { owner: 'spine-link-cache-test', repo: 'spine', branch: 'main' };
  const path = 'library_02/freshness-regression.json';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let finishOld;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return await new Promise(resolve => { finishOld = resolve; });
    return new Response('fresh-index', { status: 200 });
  };
  try {
    const oldRead = cachedGithubText(settings, path, { ttlMs: 60_000, preferRaw: true });
    await Promise.resolve();
    await Promise.resolve();
    invalidateCachedGithubText(settings, path);
    assert.equal(await cachedGithubText(settings, path, { ttlMs: 60_000, preferRaw: true }), 'fresh-index');
    finishOld(new Response('stale-index', { status: 200 }));
    await oldRead;
    const cached = await cachedGithubText(settings, path, { ttlMs: 60_000, preferRaw: true });
    assert.equal(cached, 'fresh-index');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
