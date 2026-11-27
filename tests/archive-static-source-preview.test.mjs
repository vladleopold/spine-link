import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler from '../api/github-archive.js';

function response() {
  return {
    headers: {}, code: 200, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(value) { this.code = value; return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('archive keeps a public work visible with its own source texture when motion preview is unavailable', async () => {
  const entry = {
    id: 'Spine-animation-2026-11-27T04-40-28-926Z',
    title: 'Spine animation',
    uploadedAt: '2026-11-27T04:40:28.926Z',
    previewPath: 'library_02/Spine-animation-2026-11-27T04-40-28-926Z',
    textures: ['20938824.png'],
    files: ['20938824.atlas', '20938824.skel', '20938824.png'],
    skeleton: '20938824.skel',
    atlas: '20938824.atlas',
    webmStatus: 'blocked-missing-source',
    previewStatus: 'blocked',
    publicOwnerId: 'u_public',
  };
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const indexText = JSON.stringify([entry]);
  globalThis.fetch = async (input) => {
    const url = String(input);
    const json = value => ({ ok: true, status: 200, json: async () => value });
    const text = value => ({ ok: true, status: 200, text: async () => value });
    if (url.includes('/contents/?ref=')) return json([
      { type: 'dir', name: 'library' },
      { type: 'dir', name: 'library_02' },
    ]);
    if (url.includes('/contents/library_02/index.json')) {
      return json({ encoding: 'base64', content: Buffer.from(indexText).toString('base64') });
    }
    if (url.includes('/contents/library/index.json') || url.includes('/contents/library_01/index.json')) {
      return { ok: false, status: 404 };
    }
    if (url.startsWith('https://raw.githubusercontent.com/vladleopold/spine/')) {
      if (url.includes('/library_02/index.json')) return text(indexText);
      if (url.endsWith('/archive-exclusions.json')) return text(JSON.stringify({ rules: [], allow: [] }));
      if (url.endsWith('/metrics.json')) return text('{}');
      if (url.endsWith('/censorship.json')) return text(JSON.stringify({ blocked: [], allowed: [] }));
      return { ok: false, status: 404, text: async () => '' };
    }
    throw new Error('Unexpected GitHub request: ' + url);
  };
  process.env.GITHUB_TOKEN = 'test-only-placeholder';
  try {
    const res = response();
    await handler({ method: 'GET', headers: { host: 'spine-link.vercel.app' }, query: { feed: 'archive', offset: '0', limit: '12' } }, res);
    assert.equal(res.code, 200);
    const work = res.body.entries.find(item => item.id === entry.id);
    assert.ok(work, 'the work must remain in the public archive feed');
    assert.equal(work.video, '', 'a source texture must never unlock motion playback');
    assert.match(work.posterFallback, /library_02\/Spine-animation-2026-11-27T04-40-28-926Z\/20938824\.png/,
      'the card should show the exact uploaded texture as a static fallback');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});
