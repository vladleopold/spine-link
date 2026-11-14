import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const load = path => readFile(new URL(path, root), 'utf8');

test('API and SDK guides publish concrete downloadable resources', async () => {
  const [api, sdk, client, contract] = await Promise.all([
    load('public/api-docs.html'),
    load('public/sdk.html'),
    load('public/sdk/spine-link-agent.mjs'),
    load('public/agent-animation-openapi.json'),
  ]);
  assert.match(api, /\/sdk\.html/);
  assert.match(api, /\/agent-animation-openapi\.json/);
  assert.match(api, /\/api\/agent-animation/);
  assert.match(sdk, /\/sdk\/spine-link-agent\.mjs/);
  assert.match(sdk, /SPINE_LINK_AGENT_API_KEY/);
  assert.match(client, /export class SpineLinkAgent/);
  const openapi = JSON.parse(contract);
  assert.equal(openapi.openapi, '3.1.0');
  assert(openapi.paths['/api/agent-animation'].post);
  assert(openapi.components.securitySchemes.AgentKey);
});

test('API navigation is present on both lightweight and authenticated homepages', async () => {
  const [main, app] = await Promise.all([load('src/main.tsx'), load('src/SpineApp.tsx')]);
  for (const source of [main, app]) {
    assert(source.includes('href="/api-docs.html"'));
    assert(source.includes('href: "/sdk.html"'));
    assert(source.includes('href: "/api-docs.html"'));
  }
});

test('agent routing does not exceed the Vercel Hobby 12-functions limit', async () => {
  const [configText, backend] = await Promise.all([load('vercel.json'), load('api/github-upload.js')]);
  const config = JSON.parse(configText);
  const apiFiles = (await readdir(new URL('api/', root))).filter(item => item.endsWith('.js'));
  assert(apiFiles.length <= 12, 'Vercel Hobby permits only 12 serverless functions');
  assert(config.rewrites.some(item => item.source === '/api/agent-animation' &&
    item.destination.includes('/api/github-upload?__spine_link_agent_v1=1')));
  assert(backend.includes("import agentAnimationHandler from '../lib/agent-animation.js'"));
  assert(backend.includes('return agentAnimationHandler(request, response)'));
});

test('account dashboard lists only personal projects via secure API', async () => {
  const [html, script, manager] = await Promise.all([
    load('public/api-keys.html'), load('public/api-keys.js'), load('lib/agent-user-keys.js')
  ]);
  assert(html.includes('Projects from your servers'));
  assert(script.includes("api('keys-projects')"));
  assert(manager.includes("const KEY_REPO = 'vladleopold/3Spine-core'"));
  assert(!manager.includes("const KEY_FILE = 'library/agent-api-keys.json'"));
});

test('personal API work uses verified owner identity, no public Google email', async () => {
  const [agent, upload] = await Promise.all([
    load('lib/agent-animation.js'), load('api/github-upload.js')
  ]);
  assert(!agent.includes('ownerEmail: auth.ownerEmail'));
  assert(agent.includes('ownerAccountId: auth.ownerId'));
  assert(agent.includes('showOwnerLibrary: false'));
  assert(upload.includes('if (entry?.ownerAccountId) return agentOwnerMatches(entry, googlePayload)'));
  assert(upload.includes('delete next.ownerAccountId'));
  assert(upload.includes('if (entry?.ownerAccountId) {'));
});

test("personal agent uploads can be deleted from UI with the owner's Google session", async () => {
  const [html, js, upload] = await Promise.all([
    load('public/api-keys.html'),load('public/api-keys.js'),load('api/github-upload.js')
  ]);
  assert(html.includes('permanently delete it and its files'));
  assert(js.includes("fetch('/api/github-upload'"));
  assert(js.includes("action: 'delete-entry'"));
  assert(js.includes("collectionBasePath: project.collection"));
  assert(upload.includes("if (!canEditEntry(entry, googlePayload, anonymousAccount))"));
  assert(upload.includes("deleteTrees: directory ? [previewPath] : []"));
  assert(js.includes("window.addEventListener('storage'"));
});
