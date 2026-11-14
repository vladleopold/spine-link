import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import handler from '../api/github-upload.js';

test('fast path uploads four Spine files concurrently and commits only once', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-only';
  const blobs = new Map();
  const branches = [];
  let active = 0, maxParallel = 0, commits = 0;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.fetch = async (url, options = {}) => {
    const request = new URL(url);
    const path = request.pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    if (path.endsWith('/git/blobs') && method === 'POST') {
      active++;
      maxParallel = Math.max(maxParallel, active);
      await new Promise(resolve => setTimeout(resolve, 8));
      const bytes = Buffer.from(body.content, 'base64');
      const sha = createHash('sha1').update('blob ' + bytes.length + '\\0').update(bytes).digest('hex');
      blobs.set(sha, bytes);
      active--;
      return json({ sha });
    }
    if (path.includes('/git/blobs/') && method === 'GET') {
      const sha = path.split('/').pop();
      return blobs.has(sha) ? json({ sha, encoding: 'base64', content: blobs.get(sha).toString('base64') }) : json({}, 404);
    }
    if (path.endsWith('/git/refs/heads/main') && method === 'GET') return json({ object: { sha: 'head' } });
    if (path.endsWith('/git/commits/head')) return json({ tree: { sha: 'base-tree' } });
    if (path.endsWith('/git/trees') && method === 'POST') {
      branches.push(body.tree);
      return json({ sha: 'tree-2' });
    }
    if (path.endsWith('/git/commits') && method === 'POST') {
      commits++;
      return json({ sha: 'commit-2' });
    }
    if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') return json({ ok: true });
    if (path.includes('/contents/')) return json({}, 404);
    if (path.includes('/actions/workflows/')) return json({}, 404);
    return json({}, 404);
  };
  const call = async (body) => {
    let status, data;
    const response = {
      setHeader() {},
      status(code) { status = code; return this; },
      json(value) { data = value; return this; },
    };
    await handler({
      method: 'POST', headers: { host: 'localhost' },
      body: {
        settings: { basePath: 'library_02' },
        anonymousAccount: { id: 'anon_fast_upload' },
        entryId: 'fast-project',
        uploadPath: 'library_02/fast-project',
        ...body,
      },
    }, response);
    return { status, data };
  };
  try {
    const files = [
      ['fast-project.json', Buffer.from('{"skeleton":{"spine":"4.3.26"},"bones":[{"name":"root"}]}')],
      ['fast-project.atlas', Buffer.from('texture.png\\nsize:128,128\\n')],
      ['texture.png', randomBytes(100_003)],
      ['texture-2.png', randomBytes(70_001)],
    ];
    const stage = await Promise.all(files.map(async ([name, bytes]) => {
      const { status, data } = await call({
        action: 'stage-blob',
        path: 'library_02/fast-project/' + name,
        contentBase64: bytes.toString('base64'),
      });
      assert.equal(status, 200, JSON.stringify(data));
      return data;
    }));
    assert.ok(maxParallel >= 2, 'staging should be parallel');
    assert.equal(commits, 0, 'no intermediate commits during staging');
    const published = await call({
      action: 'publish-entry',
      entry: { id: 'fast-project', previewPath: 'library_02/fast-project', files: files.map(([name]) => name) },
      stagedBlobs: stage,
    });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal(commits, 1, 'exactly one commit for the whole project');
    assert.equal(published.data.receipts.length, 4);
    const tree = branches.at(-1);
    for (const [name, bytes] of files) {
      const match = tree.find(item => item.path === 'library_02/fast-project/' + name);
      assert.ok(match, 'missing published file ' + name);
      assert.deepEqual(blobs.get(match.sha), bytes, 'binary content changed for ' + name);
    }
    // A signed receipt is scoped to its file and upload; client changes are rejected.
    const forged = { ...stage[0], path: 'library_02/fast-project/forged.json' };
    const invalid = await call({
      action: 'publish-entry', stagedBlobs: [forged],
      entry: { id: 'fast-project', previewPath: 'library_02/fast-project' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(commits, 1);
    // Larger files are assembled from verified staged parts before commit.
    const source = randomBytes(125_011);
    const encoded = source.toString('base64');
    const pieces = [encoded.slice(0, 60000), encoded.slice(60000)];
    const receipts = [];
    for (const chunk of pieces) {
      const { status, data } = await call({
        action: 'stage-blob', path: 'library_02/fast-project/large.skel',
        contentBase64: chunk,
      });
      assert.equal(status, 200, JSON.stringify(data));
      receipts.push(data);
    }
    const assembled = await call({
      action: 'publish-entry',
      stagedAssemblies: [{ path: 'library_02/fast-project/large.skel', parts: receipts }],
      entry: { id: 'fast-project', previewPath: 'library_02/fast-project' },
    });
    assert.equal(assembled.status, 200, JSON.stringify(assembled.data));
    const asset = branches.at(-1).find(item => item.path.endsWith('large.skel'));
    assert.deepEqual(blobs.get(asset.sha), source);
    assert.equal(commits, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});
