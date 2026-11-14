#!/usr/bin/env node
// Example server-side client for /api/agent-animation. Node.js 20+.
// Usage: SPINE_LINK_AGENT_API_KEY=... node scripts/spine-link-agent-publish.mjs ./export --title "My animation"
// Or:  ... ./project --format spine-project --wait
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

const args = process.argv.slice(2);
const directory = args[0];
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? '' : String(args[index + 1] || '');
};
const title = option('--title') || 'Agent animation';
const format = option('--format') || 'runtime';
const publishPublicly = args.includes('--public');
const waitForReady = args.includes('--wait');
const endpoint = (process.env.SPINE_LINK_API_URL || 'https://spine-link.vercel.app/api/agent-animation').trim();
const key = String(process.env.SPINE_LINK_AGENT_API_KEY || '');

if (!directory || !['runtime', 'spine-project'].includes(format) || !key) {
  console.error('Usage: SPINE_LINK_AGENT_API_KEY=<secret> node scripts/spine-link-agent-publish.mjs <folder> [--format runtime|spine-project] [--title "Name"] [--public] [--wait]');
  process.exit(2);
}
if (!/^https:\/\/[^/]+\/api\/agent-animation$/.test(endpoint)) {
  console.error('SPINE_LINK_API_URL must be an HTTPS /api/agent-animation URL');
  process.exit(2);
}

async function call(body, query = '') {
  const response = await fetch(endpoint + query, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw Error('API ' + response.status + ': ' + String(result.error || 'Request failed'));
  return result;
}

async function walk(dir, out = []) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const full = join(dir, item.name);
    if (item.isSymbolicLink()) throw Error('Symlinks are not allowed in animation uploads');
    if (item.isDirectory()) await walk(full, out);
    else if (item.isFile()) out.push(full);
  }
  return out;
}

const root = resolve(directory);
const paths = await walk(root);
if (paths.length < 2 || paths.length > 250) throw Error('Expected between 2 and 250 animation files');
const job = await call({ action: 'create', title, format });
const singles = [];
const assemblies = [];
// Base64 must fit under the Vercel JSON request limit. 2.1MB => 2.8M chars.
const PART_BYTES = 2_100_000;
async function stage(name, data) {
  const response = await call({
    action: 'stage', jobToken: job.jobToken, name,
    contentBase64: data.toString('base64'),
  });
  return response.receipt;
}
async function upload(path) {
  const name = relative(root, path).replace(/\\/g, '/');
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > 95_000_000) throw Error('Invalid file size: ' + name);
  if (bytes.length <= PART_BYTES) {
    return { type: 'single', receipt: await stage(name, bytes) };
  }
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
    parts.push(await stage(name, bytes.subarray(offset, offset + PART_BYTES)));
  }
  return { type: 'assembly', name, parts };
}

// At most three concurrent uploads: avoids exceeding GitHub API secondary rate limits.
for (let i = 0; i < paths.length; i += 3) {
  const batch = await Promise.all(paths.slice(i, i + 3).map(upload));
  for (const item of batch) {
    if (item.type === 'single') singles.push(item.receipt);
    else assemblies.push({ name: item.name, parts: item.parts });
  }
}
let published = await call({
  action: 'complete', jobToken: job.jobToken, files: singles,
  assemblies, public: publishPublicly,
});
if (waitForReady && published.state !== 'ready') {
  const limit = Date.now() + 12 * 60 * 1000;
  while (Date.now() < limit) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const latest = await call({ action: 'status', id: job.id, collection: job.uploadPath.split('/')[0] });
    published = { ...published, ...latest };
    if (latest.state === 'ready' || latest.state === 'failed') break;
  }
}
console.log(JSON.stringify({
  id: job.id, state: published.state, pageUrl: published.pageUrl,
  animations: published.animations || [],
  ...(published.error ? { error: published.error } : {}),
}, null, 2));
