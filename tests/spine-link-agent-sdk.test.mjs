import test from 'node:test';
import assert from 'node:assert/strict';
import { SpineLinkAgent, SpineLinkApiError, normalizeAgentFile } from '../public/sdk/spine-link-agent.mjs';

const key = 'client-test-secret-key-32-characters-000';
const source = text => new Uint8Array(Buffer.from(text));

function simulate() {
  const calls = [];
  const sdk = new SpineLinkAgent({
    apiKey: key,
    endpoint: 'https://example.org/api/agent-animation',
    fetchImpl: async (url, init) => {
      const action = JSON.parse(init.body);
      calls.push({ url, init, ...action });
      let value;
      if (action.action === 'ping') {
        value = {ok:true, authenticated:true, keyType:'personal', scope:'publish'};
      } else if (action.action === 'create') {
        value = { id: 'agent-' + 'a'.repeat(32), jobToken: 'signed-test', uploadPath: 'library_02/agent-test' };
      } else if (action.action === 'stage' || action.action === 'stage-batch') {
        const files = action.action === 'stage' ? [{ name: action.name }] : action.files;
        const receipts = files.map(file => ({
          name: file.name, path: 'library_02/agent-test/' + file.name,
          sha: 'a'.repeat(40), bytes: 12, sha256: 'f'.repeat(64), signature: 'b'.repeat(64),
        }));
        value = action.action === 'stage' ? { receipt: receipts[0] } : { receipts };
      } else if (action.action === 'complete') {
        value = { ok: true, id: 'agent-' + 'a'.repeat(32), state: 'ready',
          pageUrl: 'https://spine-link.vercel.app/p/agent-test' };
      } else if (action.action === 'status') {
        value = { ok: true, state: 'ready', id: action.id };
      } else throw Error('Unknown action ' + action.action);
      return { ok: true, status: 201, json: async () => value };
    },
  });
  return { sdk, calls };
}

test('SDK verifies API key via authenticated ping', async () => {
  const {sdk,calls}=simulate();
  const response=await sdk.verifyConnection();
  assert.equal(response.authenticated,true);
  assert.equal(calls[0].action,'ping');
  assert.equal(calls[0].init.headers.Authorization,'Bearer ' + key);
});

test('server SDK publishes runtime by batching small files with secret only in Authorization', async () => {
  const { sdk, calls } = simulate();
  const result = await sdk.publish({
    title: 'Robot', format: 'runtime',
    files: [
      { path: 'robot.json', bytes: source('{"skeleton":{}}') },
      { path: 'robot.atlas', bytes: source('robot.png\n') },
      { path: 'robot.png', bytes: source('png') },
    ],
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.collection, 'library_02');
  assert.deepEqual(calls.map(x => x.action), ['create','stage-batch','complete']);
  assert.equal(calls[1].files.length, 3);
  assert.equal(calls[2].files.length, 3);
  for (const call of calls) {
    assert(!call.url.includes(key), 'API key never goes in request URL');
    assert.equal(call.init.headers.Authorization, 'Bearer ' + key);
    assert(!call.init.body.includes(key), 'API key never goes in JSON payload');
  }
  const status = await sdk.status({ id: result.id, collection: result.collection });
  assert.equal(status.state, 'ready');
  assert.equal(calls[3].action, 'status');
  assert.equal(calls[3].id, result.id);
  assert(!calls[3].url.includes('?'), 'Signed token not transmitted in URL');
});

test('SDK uploads a larger source project as multiple signed parts', async () => {
  const { sdk, calls } = simulate();
  const large = new Uint8Array(2_500_000).fill(42);
  const result = await sdk.publish({
    title: 'Project', format: 'spine-project',
    files: [
      { path: 'actor.spine', bytes: large },
      { path: 'images/actor.png', bytes: source('png') },
    ],
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(calls.map(x=>x.action), ['create','stage','stage','stage-batch','complete']);
  assert.equal(calls[1].name, 'actor.spine');
  assert.equal(calls[2].name, 'actor.spine');
  assert.equal(calls[4].assemblies.length, 1);
  assert.equal(calls[4].assemblies[0].parts.length, 2);
  assert.equal(calls[4].files.length, 1);
});

test('SDK rejects invalid paths, duplicate files and invalid endpoints without network calls', async () => {
  const { sdk, calls } = simulate();
  assert.throws(() => normalizeAgentFile({ path:'../wrong.png', bytes: source('x') }), /Invalid/);
  assert.throws(() => normalizeAgentFile({ path:'root.png', bytes: 'text' }), /Uint8Array/);
  assert.throws(() => new SpineLinkAgent({apiKey:key,endpoint:'http://example.org/api/agent-animation'}), /HTTPS/);
  await assert.rejects(sdk.publish({
    files:[{path:'actor.png',bytes:source('x')},{path:'actor.png',bytes:source('y')}],
  }), /Duplicate file/);
  assert.equal(calls.length,0);
});

test('SDK recovers a committed publication when the complete HTTP response is lost', async () => {
  const { sdk, calls } = simulate();
  const original = sdk.fetchImpl;
  sdk.fetchImpl = async (url, init) => {
    const action = JSON.parse(init.body).action;
    if (action === 'complete') {
      calls.push({ url, init, action });
      throw new Error('response lost after Git commit');
    }
    return original(url, init);
  };
  const work = await sdk.publish({
    title:'Reliable workflow',format:'runtime',
    files:[
      {path:'actor.json',bytes:source('json')},
      {path:'actor.atlas',bytes:source('atlas')},
      {path:'actor.png',bytes:source('png')},
    ],
  });
  assert.equal(work.state, 'ready');
  assert.equal(work.recovered, true);
  assert.equal(work.collection, 'library_02');
  assert.equal(work.uploadId, work.id);
  assert.equal(calls.filter(x => x.action==='complete').length,1,
    'complete must never be retried when it may have committed');
  assert.equal(calls.filter(x => x.action==='status').length,1);
});

test('SDK retains error if status cannot prove that a failed complete committed', async () => {
  const { sdk, calls } = simulate();
  const original = sdk.fetchImpl;
  sdk.fetchImpl = async (url, init) => {
    const action = JSON.parse(init.body).action;
    if (action === 'complete') {
      calls.push({ url, init, action });
      throw new Error('network interrupted');
    }
    if (action === 'status') {
      calls.push({ url, init, action });
      return { ok:true, status:200, json:async()=>({ok:true,state:'awaiting_upload'}) };
    }
    return original(url, init);
  };
  await assert.rejects(() => sdk.publish({
    title:'Not committed',format:'runtime',
    files:[
      {path:'actor.json',bytes:source('json')},
      {path:'actor.atlas',bytes:source('atlas')},
      {path:'actor.png',bytes:source('png')},
    ],
  }),/network interrupted/);
  assert.equal(calls.filter(x => x.action==='complete').length,1);
  assert.equal(calls.filter(x => x.action==='status').length,3);
});

test('SDK surfaces only safe API errors and never retries a complete operation', async () => {
  let tries=0;
  const sdk = new SpineLinkAgent({
    apiKey:key, endpoint:'https://example.org/api/agent-animation',
    fetchImpl:async () => {
      tries++;
      return { ok:false,status:401,headers:{get:()=>null},
        json:async () => ({error:'Invalid API key'}) };
    },
  });
  await assert.rejects(() => sdk.createJob(), error =>
    error instanceof SpineLinkApiError && error.status===401 && error.message==='Invalid API key');
  assert.equal(tries,1);
});
