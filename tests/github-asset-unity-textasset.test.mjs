import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/github-asset.js';

function response() {
  return {
    headers: {}, code: 200, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(value) { this.code = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; },
  };
}

test('serves Unity-wrapped Spine 4.2.42 .skel as real JSON for the matching 4.2 runtime', async () => {
  const skeleton = {
    skeleton: { hash: 'fixture', spine: '4.2.42', width: 100, height: 100 },
    bones: [{ name: 'root' }],
    animations: { idle: {} },
  };
  const wrapped = `TextAsset Base
  string m_Name = "20938824"
  string m_Script = "${JSON.stringify(skeleton)}"
  int m_PathID = 0
`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.match(url, /contents\/library_02\/Spine-animation-2026-11-27T04-40-28-926Z\/20938824\.skel\?ref=main/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: Buffer.from(wrapped, 'utf8').toString('base64'),
        encoding: 'base64',
        size: Buffer.byteLength(wrapped),
        sha: 'unity-textasset-fixture',
      }),
    };
  };
  try {
    const res = response();
    await handler({
      method: 'GET',
      headers: {},
      query: {
        path: 'library_02/Spine-animation-2026-11-27T04-40-28-926Z/20938824.skel.json',
        spineRuntime: '4.2',
        v: 'fixture-v1',
      },
    }, res);
    assert.equal(res.code, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['x-spine-link-converted'], 'unity-textasset-to-spine-json');
    const served = JSON.parse(res.body.toString('utf8'));
    assert.equal(served.skeleton.spine, '4.2.42');
    assert.deepEqual(served.bones, [{ name: 'root' }]);
    assert.ok(served.animations.idle);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
