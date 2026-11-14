import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const normalizeUploadBase64 = (content) => assert.match(content, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
test('upload API: background, multipart and batched publishing preserve binary bytes', async () => {
  const { default: handler } = await import('../api/github-upload.js');
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-only';
  const files = new Map();
  const blobs = new Map();
  let serial = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (path.includes('/contents/')) {
      const key = decodeURIComponent(path.split('/contents/')[1]);
      if (method === 'PUT') {
        normalizeUploadBase64(body.content);
        files.set(key, body.content);
        return reply({ content: { sha: 'blob' }, commit: { sha: 'commit' } });
      }
      if (method === 'DELETE') { files.delete(key); return reply({}); }
      return files.has(key) ? reply({ encoding: 'base64', content: files.get(key), sha: 'blob' }) : reply({}, 404);
    }
    if (path.endsWith('/git/blobs')) {
      normalizeUploadBase64(body.content);
      const sha = String(++serial);
      blobs.set(sha, body.content);
      return reply({ sha });
    }
    if (path.endsWith('/git/trees')) {
      for (const item of body.tree) {
        if (item.sha === null) files.delete(item.path);
        else files.set(item.path, blobs.get(item.sha));
      }
      return reply({ sha: 'tree' });
    }
    if (path.endsWith('/git/commits/head')) return reply({ tree: { sha: 'tree' } });
    if (path.endsWith('/git/commits')) return reply({ sha: 'commit' });
    if (path.endsWith('/git/refs/heads/main')) return reply({ object: { sha: 'head' } });
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const call = async (body) => {
    let status;
    let result;
    const response = { setHeader() {}, status(value) { status = value; return this; }, json(value) { result = value; return this; } };
    await handler({ method: 'POST', headers: { host: 'localhost' }, body: { settings: { basePath: 'library_02' }, anonymousAccount: { id: 'anon_regression' }, ...body } }, response);
    assert.equal(status, 200, JSON.stringify(result));
  };
  try {
    const bytes = randomBytes(90_007);
    const input = bytes.toString('base64');
    const chunks = [input.slice(0, 60_000), input.slice(60_000)];
    for (const mode of ['background', 'multipart', 'batch']) {
      const path = `library_02/test/${mode}.png`;
      for (const [index, content] of chunks.entries()) {
        if (mode === 'background') await call({ action: 'background-upload-chunk', uploadId: 'test', uploadPath: 'library_02/test', fileName: `${mode}.png`, chunkIndex: index, chunkCount: 2, chunkBase64: content });
        else if (mode === 'multipart') await call({ action: 'multipart-upload-chunk', path, chunkIndex: index, contentBase64: content });
        else await call({ action: 'publish-entry', stageChunks: [{ path, index, contentBase64: content }] });
      }
      if (mode === 'background') await call({ action: 'background-upload-reassemble', uploadId: 'test', uploadPath: 'library_02/test', fileName: `${mode}.png`, chunkCount: 2 });
      else if (mode === 'multipart') await call({ action: 'reassemble-file', path, chunkCount: 2 });
      else await call({ action: 'publish-entry', assembles: [{ path, chunkCount: 2 }] });
      assert.deepEqual(Buffer.from(files.get(path), 'base64'), bytes);
      assert.equal([...files.keys()].some(key => key.startsWith(path + '.__chunks/')), false);
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
});

test('concurrent finalization rereads index after SHA conflict and preserves both works',async()=>{
 const {default:handler}=await import('../api/github-upload.js');
 const saved=globalThis.fetch, token=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='test-only';
 let writes=0; let finalIndex;
 globalThis.fetch=async(url,options={})=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/contents/library_02/index.json')){
   if(options.method==='PUT'){
    writes++;
    if(writes===1)return new Response(JSON.stringify({message:'sha does not match'}),{status:409});
    finalIndex=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString());
    return new Response('{}');
   }
   return new Response(JSON.stringify({sha:writes?'new':'old',encoding:'base64',content:Buffer.from(JSON.stringify(writes?[{id:'concurrent'}]:[])).toString('base64')}));
  }
  return new Response('{}',{status:404});
 };
 try{
  let status,result;const response={setHeader(){},status(v){status=v;return this;},json(v){result=v;return this;}};
  await handler({method:'POST',headers:{host:'localhost'},body:{action:'background-finalize-index',uploadId:'test',uploadPath:'library_02/test',settings:{basePath:'library_02'},anonymousAccount:{id:'anon_regression'}}},response);
  assert.equal(status,200,JSON.stringify(result));assert.equal(writes,2);assert.deepEqual(finalIndex.map(e=>e.id),['test','concurrent']);
 }finally{globalThis.fetch=saved;if(token===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=token;}
});


test('concurrent branch update retries the final commit without resending asset blobs', async () => {
  const { default: handler } = await import('../api/github-upload.js');
  const savedFetch = globalThis.fetch, savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-only';
  let blobPosts = 0, commitPosts = 0, patchCalls = 0, headReads = 0;
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method || 'GET';
    if (path.endsWith('/git/blobs') && method === 'POST') {
      blobPosts++;
      return reply({ sha: 'immutable-asset-sha' });
    }
    if (path.endsWith('/git/refs/heads/main') && method === 'GET') {
      headReads++;
      return reply({ object: { sha: headReads === 1 ? 'head-before-race' : 'head-after-race' } });
    }
    if (path.includes('/git/commits/head-')) return reply({ tree: { sha: 'base-tree' } });
    if (path.endsWith('/git/trees') && method === 'POST') return reply({ sha: 'new-tree' });
    if (path.endsWith('/git/commits') && method === 'POST') {
      commitPosts++;
      return reply({ sha: 'new-commit-' + commitPosts });
    }
    if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      patchCalls++;
      if (patchCalls === 1) return reply({ message: 'Update is not a fast forward' }, 422);
      return reply({ object: { sha: 'new-commit-2' } });
    }
    return reply({}, 404);
  };
  try {
    let status, data;
    const response = {
      setHeader() {},
      status(value) { status = value; return this; },
      json(value) { data = value; return this; },
    };
    await handler({
      method: 'POST', headers: { host: 'localhost' },
      body: {
        action: 'publish-entry',
        settings: { basePath: 'library_02' },
        anonymousAccount: { id: 'anon_race_test' },
        uploadPath: 'library_02/race-project',
        files: [{
          path: 'library_02/race-project/texture.png',
          contentBase64: Buffer.from('binary-asset').toString('base64'),
        }],
      },
    }, response);
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(blobPosts, 1, 'one immutable blob upload across all retries');
    assert.equal(commitPosts, 2, 'a fresh commit on the newer branch');
    assert.equal(patchCalls, 2);
    assert.equal(headReads, 2);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
});
