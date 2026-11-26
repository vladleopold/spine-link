import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGitHubRateLimitResponse,
  githubRetryAfterSeconds,
  shouldRetryGitHubResponse,
  githubErrorForResponse,
} from '../lib/github-rate-limit.js';
import { getGitHubContent } from '../api/github-upload.js';

function response(status, headers = {}) {
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { status, headers: { get: (name) => values.get(String(name).toLowerCase()) ?? null } };
}

test('primary GitHub rate limit on 403 is recognized from remaining quota header', () => {
  assert.equal(isGitHubRateLimitResponse(response(403, {'x-ratelimit-remaining':'0'})), true);
});

test('secondary GitHub rate limit on 403 is recognized from response message', () => {
  assert.equal(isGitHubRateLimitResponse(response(403), 'You have exceeded a secondary rate limit.'), true);
});

test('ordinary GitHub permission 403 is not mislabeled as rate limiting', () => {
  assert.equal(isGitHubRateLimitResponse(response(403, {'x-ratelimit-remaining':'4987'}), 'Resource not accessible by integration'), false);
});

test('HTTP 429 is always recognized as rate limiting', () => {
  assert.equal(isGitHubRateLimitResponse(response(429)), true);
});

test('Retry-After header takes precedence for client wait time', () => {
  assert.equal(githubRetryAfterSeconds(response(429, {'retry-after':'37','x-ratelimit-reset':'2000'}), 1000000), 37);
});

test('primary rate limit reset is converted to a positive delay', () => {
  assert.equal(githubRetryAfterSeconds(response(403, {'x-ratelimit-reset':'1005'}), 1000000), 5);
});

test('rate limited responses are returned to the client instead of retried by the server', () => {
  assert.equal(shouldRetryGitHubResponse(response(403, {'x-ratelimit-remaining':'0'})), false);
  assert.equal(shouldRetryGitHubResponse(response(429)), false);
});

test('transient server errors remain retryable', () => {
  assert.equal(shouldRetryGitHubResponse(response(503)), true);
  assert.equal(shouldRetryGitHubResponse(response(408)), true);
});

test('secondary rate-limit body prevents retries even without quota headers', () => {
  assert.equal(shouldRetryGitHubResponse(response(403), 'API rate limit exceeded'), false);
});

test('definitive permission errors are not retried', () => {
  assert.equal(shouldRetryGitHubResponse(response(403), 'Resource not accessible by integration'), false);
});

test('primary rate-limit errors expose HTTP 429 and the exact reset delay', () => {
  const error = githubErrorForResponse({
    verb: 'read',
    path: 'library/index.json',
    response: response(403, {'x-ratelimit-remaining':'0','x-ratelimit-reset':'1005'}),
    message: 'API rate limit exceeded',
    nowMs: 1000000,
  });
  assert.equal(error.statusCode, 429);
  assert.equal(error.retryAfter, 5);
});

test('permission errors preserve HTTP 403 instead of becoming rate limits', () => {
  const error = githubErrorForResponse({
    verb: 'read',
    path: 'library/index.json',
    response: response(403, {'x-ratelimit-remaining':'4987'}),
    message: 'Resource not accessible by integration',
  });
  assert.equal(error.statusCode, 403);
  assert.equal(error.retryAfter, undefined);
});


test('GitHub Contents reads stop after a secondary rate-limit body even without rate headers', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
  };
  try {
    await assert.rejects(
      () => getGitHubContent({ owner: 'vladleopold', repo: 'spine', branch: 'main', token: 'test-token' }, 'library/index.json'),
      error => error.statusCode === 429 && error.status === 403,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
