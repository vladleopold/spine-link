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
process.env.GOOGLE_CLIENT_ID = 'test-oauth-spine-link-client';
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
  let registry = null;
  let registryVersion = 0;
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
    const credentialsBase = '/repos/vladleopold/3Spine-core';
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      const access = new URL(url).searchParams.get('access_token');
      const number = access === 'google-user-one' ? '1' : access === 'google-user-two' ? '2' : '';
      return number
        ? result(200, { aud: 'test-oauth-spine-link-client', user_id: 'google-sub-' + number })
        : result(401, { error:'invalid_token' });
    }
    if (path === '/oauth2/v3/userinfo') {
      const access = String(options.headers?.Authorization || '').replace(/^Bearer /,'');
      const number = access === 'google-user-one' ? '1' : access === 'google-user-two' ? '2' : '';
      return number ? result(200, {
        sub:'google-sub-' + number,
        email:'owner' + number + '@test.invalid',
        email_verified:true,
      }) : result(401, {});
    }
    if (path === credentialsBase + '/contents/.spine-link/agent-api-keys.json') {
      if (method === 'GET') {
        return registry ? result(200, {
          sha: String(registryVersion).padStart(40,'a'),
          encoding:'base64',
          content: Buffer.from(JSON.stringify(registry)).toString('base64'),
        }) : result(404, { message:'Not Found' });
      }
      if (method === 'PUT') {
        const existingSha = registry ? String(registryVersion).padStart(40,'a') : null;
        if (existingSha !== (body.sha || null)) return result(409, {message:'Conflict'});
        registry = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
        registryVersion++;
        return result(200, {commit:{sha:String(registryVersion).padStart(40,'c')}});
      }
    }

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
  return { requests, dispatches, get entries() { return entries; }, get registry() { return registry; } };
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


test('reject atlas texture pages missing from the uploaded image set', async () => {
  const gh = mockGithub();
  const job = await create();
  const skeleton = await stage(job.jobToken, 'actor.json', jsonSkeleton);
  const atlas = await stage(job.jobToken, 'actor.atlas', 'different.png\nsize: 1,1\n');
  const texture = await stage(job.jobToken, 'actor.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const output = await request('POST', { action: 'complete', jobToken: job.jobToken, files: [skeleton, atlas, texture] });
  assert.equal(output.code, 422, JSON.stringify(output));
  assert.match(output.error, /Missing atlas texture/);
  assert.equal(gh.entries.length, 0, 'invalid assets must not create a page');
});

test('reject a skeleton with textures in a different folder from atlas', async () => {
  mockGithub();
  const job = await create();
  const skeleton = await stage(job.jobToken, 'export/actor.json', jsonSkeleton);
  const atlas = await stage(job.jobToken, 'export/actor.atlas', 'actor.png\n');
  const texture = await stage(job.jobToken, 'textures/actor.png', Buffer.from([1, 2, 3]));
  const output = await request('POST', { action: 'complete', jobToken: job.jobToken, files: [skeleton, atlas, texture] });
  assert.equal(output.code, 422);
  assert.match(output.error, /side by side/);
});

test('accept nested runtime export, POST status and status by id after signed session', async () => {
  mockGithub();
  const job = await create();
  const skeleton = await stage(job.jobToken, 'export/actor.json', jsonSkeleton);
  const atlas = await stage(job.jobToken, 'export/actor.atlas.txt', 'actor.png\nsize:1,1\n');
  const texture = await stage(job.jobToken, 'export/actor.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const output = await request('POST', { action: 'complete', jobToken: job.jobToken, files: [skeleton, atlas, texture] });
  assert.equal(output.code, 201, JSON.stringify(output));
  const fromId = await request('POST', { action: 'status', id: job.id, collection: 'library_02' });
  assert.equal(fromId.code, 200);
  assert.equal(fromId.state, 'ready');
  assert.deepEqual(fromId.animations, ['walk','idle']);
  const fromToken = await request('POST', { action: 'status', jobToken: job.jobToken });
  assert.equal(fromToken.code, 200);
  const invalid = await request('POST', { action: 'status', id: job.id, collection: '../library_02' });
  assert.equal(invalid.code, 400);
});

test('reject source runtime JSON without 4.3 spine header or animations', async () => {
  mockGithub();
  const job = await create();
  const skeleton = await stage(job.jobToken, 'actor.json', '{"skeleton":{},"animations":{}}');
  const atlas = await stage(job.jobToken, 'actor.atlas', 'actor.png\n');
  const texture = await stage(job.jobToken, 'actor.png', Buffer.from([1, 2, 3]));
  const output = await request('POST', { action: 'complete', jobToken: job.jobToken, files: [skeleton, atlas, texture] });
  assert.equal(output.code, 422);
});


test('batch-staging eight small textures returns distinct signed receipts that publish normally', async () => {
  const gh = mockGithub();
  const job = await create();
  const names = ['actor.json','actor.atlas','actor.png',...Array.from({ length: 5 },(_,i)=>'extra'+i+'.png')];
  const atlas = 'actor.png\nsize: 1,1\n';
  const bodies = names.map(name => ({
    name,
    contentBase64: Buffer.from(name.endsWith('.json') ? jsonSkeleton :
      name.endsWith('.atlas') ? atlas : 'data:' + name).toString('base64'),
  }));
  const staged = await request('POST',{ action:'stage-batch', jobToken:job.jobToken, files:bodies });
  assert.equal(staged.code,201, JSON.stringify(staged));
  assert.equal(staged.receipts.length, 8);
  assert.equal(new Set(staged.receipts.map(item=>item.signature)).size,8);
  assert.equal(gh.requests.filter(item=>item.method==='POST' && item.path.endsWith('/git/blobs')).length,8);
  const completed = await request('POST',{
    action:'complete', jobToken:job.jobToken, files:staged.receipts,
  });
  assert.equal(completed.code,201, JSON.stringify(completed));
  assert.equal(gh.entries[0].files.length,8);
});

test('batch-staging rejects duplicate filenames and malicious paths before storing blobs', async () => {
  const gh = mockGithub();
  const job = await create();
  const before = gh.requests.length;
  const dup = await request('POST',{
    action:'stage-batch',jobToken:job.jobToken,
    files:[{name:'actor.png',contentBase64:'YQ=='},{name:'actor.png',contentBase64:'Yg=='}],
  });
  assert.equal(dup.code,400);
  const bad = await request('POST',{
    action:'stage-batch',jobToken:job.jobToken,
    files:[{name:'../../hijack.json',contentBase64:'YQ=='}],
  });
  assert.equal(bad.code,400);
  assert.equal(gh.requests.length,before);
});


test('new personal and administrator API keys can authenticate without uploading', async () => {
  mockGithub();
  const admin = await request('POST', {action:'ping'});
  assert.equal(admin.code,200);
  assert.equal(admin.authenticated,true);
  assert.equal(admin.keyType,'admin');
  const created = await request('POST', {action:'keys-create',name:'Verify animation server'}, {}, 'google-user-one');
  assert.equal(created.code,200);
  const personal=await request('POST', {action:'ping'}, {}, created.key);
  assert.equal(personal.code,200);
  assert.equal(personal.keyType,'personal');
  const invalid=await request('POST',{action:'ping'}, {},'invalid-api-key');
  assert.equal(invalid.code,401);
  const revoked=await request('POST',{action:'keys-revoke',keyId:created.record.id}, {},'google-user-one');
  assert.equal(revoked.code,200);
  const blocked=await request('POST',{action:'ping'}, {}, created.key);
  assert.equal(blocked.code,401);
});

test('Google account creates a one-time personal key; only masked key is listed', async () => {
  const gh = mockGithub();
  const initial = await request('POST', {action:'keys-list'}, {}, 'google-user-one');
  assert.equal(initial.code, 200, JSON.stringify(initial));
  assert.deepEqual(initial.keys, []);
  const created = await request('POST', {action:'keys-create',name:'Cloud animation server'}, {}, 'google-user-one');
  assert.equal(created.code, 200, JSON.stringify(created));
  assert.match(created.key,/^slk_v1_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.record.scope,'publish');
  const registry = JSON.stringify(gh.registry);
  assert(!registry.includes(created.key), 'never persist plaintext key');
  assert(!registry.includes('owner1@test.invalid'), 'encrypt Google email in key registry');
  assert(gh.requests.some(x => x.path === '/repos/vladleopold/3Spine-core/contents/.spine-link/agent-api-keys.json'),
    'credential registry must be in the private repository');
  assert(!gh.requests.some(x => x.path === '/repos/vladleopold/spine/contents/library/agent-api-keys.json'),
    'must not write credentials to public storage');
  const own = await request('POST', {action:'keys-list'}, {}, 'google-user-one');
  assert.equal(own.keys.length, 1);
  assert(!JSON.stringify(own).includes(created.key));
  const other = await request('POST', {action:'keys-list'}, {}, 'google-user-two');
  assert.deepEqual(other.keys, [], 'other Google account has no access');
  const bad = await request('POST', {action:'keys-revoke',keyId:created.record.id}, {}, 'google-user-two');
  assert.equal(bad.code,404);
});

test('personal API key publishes into verified owner library; another key cannot access', async () => {
  const gh = mockGithub();
  const created = await request('POST', {action:'keys-create', name:'Office animator'}, {}, 'google-user-one');
  const token = created.key;
  const second = await request('POST', {action:'keys-create', name:'Other user server'}, {}, 'google-user-two');
  const job = await request('POST',{action:'create',format:'runtime',title:'Personal robot'}, {}, token);
  assert.equal(job.code,201, JSON.stringify(job));
  assert.match(job.jobToken, /^[\w-]+\.[a-f0-9]{64}$/);
  const attackerUpload = await request('POST',{
    action:'stage',jobToken:job.jobToken,name:'actor.png',contentBase64:'cG5n',
  },{},second.key);
  assert.equal(attackerUpload.code,403, JSON.stringify(attackerUpload));
  const attackerStatus = await request('POST',{action:'status',jobToken:job.jobToken},{},second.key);
  assert.equal(attackerStatus.code,403);
  const files = [
    ['actor.json', jsonSkeleton],
    ['actor.atlas', 'actor.png\nsize: 1,1\n'],
    ['actor.png', 'png'],
  ];
  const receipts = [];
  for (const [name, data] of files) {
    const result = await request('POST',{
      action:'stage',jobToken:job.jobToken,name,contentBase64:Buffer.from(data).toString('base64'),
    },{},token);
    assert.equal(result.code,201);
    receipts.push(result.receipt);
  }
  const done = await request('POST',{action:'complete',jobToken:job.jobToken,files:receipts},{},token);
  assert.equal(done.code,201, JSON.stringify(done));
  const entry = gh.entries[0];
  assert.equal(entry.ownerEmail,'owner1@test.invalid');
  assert.equal(entry.showOwnerLibrary,true);
  assert.match(entry.publicOwnerId,/^u_/);
  assert.match(entry.ownerAccountId,/^[a-f0-9]{64}$/);
  assert.equal(entry.hiddenFromPublicLibrary,true);
  const projects = await request('POST',{action:'keys-projects'}, {}, 'google-user-one');
  assert.equal(projects.code,200,JSON.stringify(projects));
  assert.equal(projects.projects.length,1);
  assert.equal(projects.projects[0].id,job.id);
  const strangerProjects=await request('POST',{action:'keys-projects'}, {}, 'google-user-two');
  assert.equal(strangerProjects.code,200);
  assert.deepEqual(strangerProjects.projects,[], 'projects must be scoped to the verified owner');
  const ownerStatus = await request('POST',{
    action:'status',id:job.id,collection:job.uploadPath.split('/')[0]
  },{},token);
  assert.equal(ownerStatus.code,200);
  const wrongStatus = await request('POST',{
    action:'status',id:job.id,collection:job.uploadPath.split('/')[0]
  },{},second.key);
  assert.equal(wrongStatus.code,403);
  const revoke = await request('POST',{action:'keys-revoke',keyId:created.record.id},{},'google-user-one');
  assert.equal(revoke.code,200);
  const disabled = await request('POST',{action:'create',format:'runtime',title:'Rejected'}, {}, token);
  assert.equal(disabled.code,401, JSON.stringify(disabled));
  const after = await request('POST',{action:'keys-list'},{},'google-user-one');
  assert(after.keys[0].revokedAt);
});

test('maximum five active personal keys and invalid Google session do not create credentials', async () => {
  const gh = mockGithub();
  const invalid = await request('POST',{action:'keys-create',name:'Agent Z'}, {},'invalid-oauth');
  assert.equal(invalid.code,401);
  for (let i=1;i<=5;i++) {
    const created=await request('POST',{action:'keys-create',name:'Agent number '+i}, {},'google-user-one');
    assert.equal(created.code,200, JSON.stringify(created));
  }
  const sixth = await request('POST',{action:'keys-create',name:'Agent six'}, {},'google-user-one');
  assert.equal(sixth.code,409);
  const before=gh.registry.keys.filter(key=>!key.revokedAt).length;
  assert.equal(before,5);
  const first=gh.registry.keys[0].id;
  const revoked=await request('POST',{action:'keys-revoke',keyId:first}, {},'google-user-one');
  assert.equal(revoked.code,200);
  const replacement=await request('POST',{action:'keys-create',name:'Replacement server'}, {},'google-user-one');
  assert.equal(replacement.code,200);
  assert.equal(gh.registry.keys.filter(key=>!key.revokedAt).length,5);
});

test.after(() => {
  globalThis.fetch = oldFetch;
  Object.keys(process.env).forEach(key => { if (!(key in oldEnv)) delete process.env[key]; });
  Object.assign(process.env, oldEnv);
});
