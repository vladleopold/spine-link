import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import handler from '../lib/agent-animation.js';
import siteUploadHandler from '../api/github-upload.js';

const API_KEY = 'test-agent-key-that-is-at-least-32-bytes-long';
const oldFetch = globalThis.fetch;
const oldEnv = { ...process.env };
process.env.SPINE_LINK_AGENT_API_KEY = API_KEY;
process.env.GITHUB_TOKEN = 'test-github-token';
process.env.GITHUB_OWNER = 'vladleopold';
process.env.GITHUB_REPO = 'spine';
process.env.GITHUB_BRANCH = 'main';
delete process.env.GITHUB_BASE_PATH;

function result(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function mockGithub() {
  let entries = [];
  let pendingTree = [];
  let head = 'a'.repeat(40);
  const blobs = new Map();
  const requests = [];
  const dispatches = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ path, method });
    const base = '/repos/vladleopold/spine';
    if (path === base + '/contents/' && method === 'GET') {
      return result(200, [{ name: 'library_02', type: 'dir' }]);
    }
    if (path === base + '/contents/library_02/index.json' && method === 'GET') {
      return result(200, {
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(entries)).toString('base64'),
      });
    }
    if (path === base + '/git/ref/heads/main' && method === 'GET') {
      return result(200, { object: { sha: head } });
    }
    if (path === base + '/git/blobs' && method === 'POST') {
      const bytes = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      blobs.set(sha, bytes);
      return result(201, { sha });
    }
    const blobMatch = path.match(/\/git\/blobs\/([a-f0-9]{40})$/);
    if (blobMatch && method === 'GET') {
      const bytes = blobs.get(blobMatch[1]);
      if (!bytes) return result(404, { message: 'Blob missing' });
      return result(200, { encoding: 'base64', content: bytes.toString('base64') });
    }
    if (path === base + '/git/commits/' + head && method === 'GET') {
      return result(200, { tree: { sha: 'b'.repeat(40) } });
    }
    if (path === base + '/git/trees' && method === 'POST') {
      pendingTree = body.tree;
      return result(201, { sha: 'c'.repeat(40) });
    }
    if (path === base + '/git/commits' && method === 'POST') {
      return result(201, { sha: 'd'.repeat(40) });
    }
    if (path === base + '/git/refs/heads/main' && method === 'PATCH') {
      head = body.sha;
      const indexBlob = pendingTree.find(item => item.path === 'library_02/index.json');
      entries = JSON.parse(blobs.get(indexBlob.sha).toString('utf8'));
      return result(200, { object: { sha: head } });
    }
    if (path.endsWith('/dispatches') && method === 'POST') {
      dispatches.push({ path, body });
      return result(204, null);
    }
    throw Error('Unexpected GitHub API: ' + method + ' ' + path);
  };
  return { requests, dispatches, get entries() { return entries; } };
}

function request(method, body, query = {}, key = API_KEY) {
  const response = {
    code: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; },
  };
  return handler({
    method,
    headers: { authorization: key ? 'Bearer ' + key : '' },
    body, query,
  }, response).then(() => ({ code: response.code, ...response.body }));
}

async function create(format = 'runtime') {
  const result = await request('POST', { action: 'create', format, title: 'Agent test' });
  assert.equal(result.code, 201, JSON.stringify(result));
  assert.match(result.jobToken, /^[\w-]+\.[a-f0-9]{64}$/);
  assert.match(result.pageUrl, /^https:\/\/spine-link\.vercel\.app\/p\/agent-/);
  return result;
}

async function stage(jobToken, name, data) {
  const payload = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
  const response = await request('POST', { action: 'stage', jobToken, name, contentBase64: payload });
  assert.equal(response.code, 201, JSON.stringify(response));
  return response.receipt;
}

const jsonSkeleton = JSON.stringify({
  skeleton: { spine: '4.3.26' },
  animations: { walk: {}, idle: {} },
});

test('reject unauthenticated and invalid API-key requests', async () => {
  const env = mockGithub();
  const a = await request('POST', { action: 'create', format: 'runtime' }, {}, '');
  const b = await request('POST', { action: 'create', format: 'runtime' }, {}, 'wrong-key');
  assert.equal(a.code, 401);
  assert.equal(b.code, 401);
  assert.equal(env.requests.length, 0);
});

test('create, stage, publish real runtime JSON + atlas + PNG, query status; prevent duplicate', async () => {
  const gh = mockGithub();
  const job = await create();
  const skeleton = await stage(job.jobToken, 'character.json', jsonSkeleton);
  const atlas = await stage(job.jobToken, 'character.atlas', 'character.png\nsize: 1,1\n');
  const png = await stage(job.jobToken, 'character.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const complete = await request('POST', {
    action: 'complete', jobToken: job.jobToken, files: [skeleton, atlas, png],
    defaultAnimation: 'walk', agentName: '2Spine',
  });
  assert.equal(complete.code, 201, JSON.stringify(complete));
  assert.equal(complete.state, 'ready');
  assert.deepEqual(complete.animations, ['walk', 'idle']);
  assert.equal(gh.entries[0].defaultAnimation, 'walk');
  assert.equal(gh.entries[0].hiddenFromPublicLibrary, true);
  assert.equal(gh.entries[0].sourceKind, 'runtime');
  assert.equal(gh.dispatches[0].body.event_type, 'spine-export-webm');
  assert.equal(gh.dispatches[0].body.client_payload.uploadId, job.id);
  const status = await request('GET', {}, { jobToken: job.jobToken });
  assert.equal(status.code, 200);
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.animations, ['walk', 'idle']);
  const repeated = await request('POST', { action: 'complete', jobToken: job.jobToken, files: [skeleton, atlas, png] });
  assert.equal(repeated.code, 409);
});

test('accept .spine + one images/ PNG; request licensed editor and report pending', async () => {
  const gh = mockGithub();
  const job = await create('spine-project');
  const file = await stage(job.jobToken, 'actor.spine', Buffer.from([1, 2, 3, 4]));
  const image = await stage(job.jobToken, 'images/actor.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const complete = await request('POST', {
    action: 'complete', jobToken: job.jobToken, files: [file, image],
  });
  assert.equal(complete.code, 201, JSON.stringify(complete));
  assert.equal(complete.state, 'processing');
  assert.equal(gh.entries[0].projectFile, 'actor.spine');
  assert.equal(gh.entries[0].conversionStatus, 'pending');
  assert.equal(gh.dispatches[0].path, '/repos/vladleopold/3Spine-core/dispatches');
  assert.equal(gh.dispatches[0].body.client_payload.projectFile, 'actor.spine');
  const status = await request('GET', {}, { jobToken: job.jobToken });
  assert.equal(status.state, 'processing');
});

test('support multipart staged bytes and reject compromised receipts and traversal', async () => {
  mockGithub();
  const job = await create();
  const traversal = await request('POST', {
    action: 'stage', jobToken: job.jobToken, name: '../index.json', contentBase64: 'YQ==',
  });
  assert.equal(traversal.code, 400);
  const tampered = await request('POST', {
    action: 'stage', jobToken: job.jobToken.slice(0, -1) + 'x', name: 'actor.png', contentBase64: 'YQ==',
  });
  assert.equal(tampered.code, 401);
  const half = Math.floor(jsonSkeleton.length / 2);
  const part1 = await stage(job.jobToken, 'actor.json', jsonSkeleton.slice(0, half));
  const part2 = await stage(job.jobToken, 'actor.json', jsonSkeleton.slice(half));
  const atlas = await stage(job.jobToken, 'actor.atlas.txt', 'actor.png\nsize: 1,1\n');
  const image = await stage(job.jobToken, 'actor.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const bad = await request('POST', {
    action: 'complete', jobToken: job.jobToken,
    files: [{ ...atlas, sha256: 'f'.repeat(64) }, image],
    assemblies: [{ name: 'actor.json', parts: [part1, part2] }],
  });
  assert.equal(bad.code, 400);
  const completed = await request('POST', {
    action: 'complete', jobToken: job.jobToken,
    files: [atlas, image], assemblies: [{ name: 'actor.json', parts: [part1, part2] }],
  });
  assert.equal(completed.code, 201, JSON.stringify(completed));
  assert.deepEqual(completed.animations, ['walk', 'idle']);
});

test('Vercel rewrite marker routes GET status through the existing upload function', async () => {
  mockGithub();
  const job = await create();
  const response = {
    code: 200,
    setHeader() { return this; },
    status(value) { this.code = value; return this; },
    json(value) { this.body = value; return this; },
  };
  await siteUploadHandler({
    method: 'GET',
    query: { __spine_link_agent_v1: '1', jobToken: job.jobToken },
    headers: { authorization: 'Bearer ' + API_KEY },
  }, response);
  assert.equal(response.code, 200);
  assert.equal(response.body.state, 'awaiting_upload');
});

test('reject incompatible runtime Spine version', async () => {
  mockGithub();
  const job = await create();
  const json = await stage(job.jobToken, 'old.json',
    JSON.stringify({ skeleton: { spine: '4.1.24' }, animations: { run: {} } }));
  const atlas = await stage(job.jobToken, 'old.atlas', 'old.png\n');
  const image = await stage(job.jobToken, 'old.png', Buffer.from([1, 2, 3]));
  const completed = await request('POST', {
    action: 'complete', jobToken: job.jobToken, files: [json, atlas, image],
  });
  assert.equal(completed.code, 422);
});

test.after(() => {
  globalThis.fetch = oldFetch;
  Object.keys(process.env).forEach(key => { if (!(key in oldEnv)) delete process.env[key]; });
  Object.assign(process.env, oldEnv);
});
