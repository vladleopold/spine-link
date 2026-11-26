import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadRequest } from '../src/upload-request.ts';

test('returns HTTP 429 immediately instead of replaying an upload after Retry-After', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'GitHub rate limit exceeded', retryAfter: 3600 }), {
      status: 429,
      headers: { 'Retry-After': '3600' },
    });
  };

  try {
    const response = await uploadRequest('/api/github-upload', { method: 'POST', body: '{}' }, 3);
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('continues retrying transient server failures', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('temporary', { status: 503 })
      : new Response('ok', { status: 200 });
  };

  try {
    const response = await uploadRequest('/api/github-upload', { method: 'POST', body: '{}' }, 2);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
