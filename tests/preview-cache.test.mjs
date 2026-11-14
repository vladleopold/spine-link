import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedGithubText } from '../lib/github-content-cache.js';

test('new preview bypasses a cached index and invalidates the old cache', async () => {
  const oldFetch = globalThis.fetch;
  const settings = { owner: 'example', repo: 'example', branch: 'main', token: 'test' };
  let version = 1;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    const text = JSON.stringify([{ id: 'test-' + version }]);
    return new Response(JSON.stringify({
      encoding: 'base64', content: Buffer.from(text).toString('base64'),
    }));
  };
  try {
    const path = 'library_98765/index.json';
    assert.match(await cachedGithubText(settings, path), /test-1/);
    version = 2;
    assert.match(await cachedGithubText(settings, path), /test-1/, 'ordinary reads may be cached');
    assert.match(await cachedGithubText(settings, path, { ttlMs: 0 }), /test-2/, 'fresh preview must see the new index');
    assert.match(await cachedGithubText(settings, path), /test-2/, 'forced refresh must also invalidate old cache');
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('large collection indexes are resolved through Git blobs', async () => {
  const oldFetch = globalThis.fetch;
  const settings = { owner: 'example', repo: 'example', branch: 'main', token: 'test' };
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/git/blobs/')) {
      return new Response(JSON.stringify({
        encoding: 'base64',
        content: Buffer.from('[{"id":"new-preview"}]').toString('base64'),
      }));
    }
    return new Response(JSON.stringify({ sha: 'test-blob-sha', encoding: 'none', content: '', download_url: null }));
  };
  try {
    const data = await cachedGithubText(settings, 'library_98766/index.json', { ttlMs: 0 });
    assert.match(data, /new-preview/);
    assert.equal(urls.length, 2);
    assert.match(urls[1], /\/git\/blobs\/test-blob-sha/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
