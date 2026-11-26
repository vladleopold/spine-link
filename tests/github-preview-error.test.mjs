import assert from 'node:assert/strict';
import test from 'node:test';

import handler from '../api/github-preview.js';

function createResponse() {
  const headers = new Map();
  return {
    headers,
    headersSent: false,
    statusCode: 0,
    body: '',
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = String(body ?? '');
      this.headersSent = true;
      return this;
    },
    end(body = '') {
      this.body = String(body);
      this.headersSent = true;
      return this;
    },
  };
}

async function withPreviewEnvironment(run) {
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const previous = {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  };
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_OWNER = 'vladleopold';
  process.env.GITHUB_REPO = 'spine';
  console.error = () => {};
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
    if (previous.token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous.token;
    if (previous.owner === undefined) delete process.env.GITHUB_OWNER;
    else process.env.GITHUB_OWNER = previous.owner;
    if (previous.repo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = previous.repo;
  }
}

test('preview upstream failures return generic no-store 503 without leaking internals', async () => {
  await withPreviewEnvironment(async () => {
    globalThis.fetch = async () => {
      throw new Error('PRIVATE_TOKEN_OR_INTERNAL_PATH');
    };
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { path: 'library_02/preview-error-probe-unique/preview.html' },
      headers: { host: 'spine-link.vercel.app' },
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body, 'Preview temporarily unavailable');
    assert.equal(response.headers.get('cache-control')?.includes('no-store'), true);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.equal(response.body.includes('PRIVATE_TOKEN_OR_INTERNAL_PATH'), false);
  });
});

test('private-repository configuration failures do not disclose token requirements', async () => {
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const previous = {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  };
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_OWNER = 'private-owner';
  process.env.GITHUB_REPO = 'private-repo';
  globalThis.fetch = async () => {
    throw new Error('fetch must not run without private-repository credentials');
  };
  console.error = () => {};
  try {
    const response = createResponse();
    await handler({
      method: 'GET',
      query: { entry: 'private-preview-probe' },
      headers: { host: 'spine-link.vercel.app' },
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body, 'Preview temporarily unavailable');
    assert.equal(response.body.includes('GITHUB_TOKEN'), false);
    assert.equal(response.headers.get('cache-control')?.includes('no-store'), true);
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
    if (previous.token === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous.token;
    if (previous.owner === undefined) delete process.env.GITHUB_OWNER;
    else process.env.GITHUB_OWNER = previous.owner;
    if (previous.repo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = previous.repo;
  }
});

test('method errors are also marked no-store', async () => {
  const response = createResponse();
  await handler({ method: 'POST', query: {}, headers: { host: 'spine-link.vercel.app' } }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.get('cache-control')?.includes('no-store'), true);
});
