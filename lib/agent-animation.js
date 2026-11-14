// Server-to-server Spine-Link Agent API v1.
// Never call this endpoint from public browser code: its Bearer key is a secret.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { manageKeys, authenticateAgentKey, requireOwner, profileIdFromEmail } from './agent-user-keys.js';

const MAX_BASE64 = 3_000_000;
const MAX_FILES = 250;
const MAX_FILE_BYTES = 95_000_000;
const MAX_TOTAL_BYTES = 200_000_000;
const JOB_TTL_MS = 72 * 60 * 60 * 1000;
const DEFAULT_ORIGIN = 'https://spine-link.vercel.app';

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function secret() {
  const value = String(process.env.SPINE_LINK_AGENT_API_KEY || '');
  if (Buffer.byteLength(value) < 32) throw apiError(503, 'Agent API is not configured');
  return value;
}

function hmac(value) {
  return createHmac('sha256', secret()).update(value).digest('hex');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function githubSettings() {
  if (!process.env.GITHUB_TOKEN) throw apiError(503, 'GitHub storage is not configured');
  const owner = process.env.GITHUB_OWNER || 'vladleopold';
  const repo = process.env.GITHUB_REPO || 'spine';
  const branch = process.env.GITHUB_BRANCH || 'main';
  for (const item of [owner, repo, branch]) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(item) || item.includes('..')) {
      throw apiError(503, 'Invalid GitHub repository configuration');
    }
  }
  return { owner, repo, branch, token: process.env.GITHUB_TOKEN };
}

function repoUrl(settings) {
  return '/repos/' + encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo);
}

async function github(settings, method, path, body) {
  const response = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + settings.token,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // Do not relay GitHub's raw error body (which may contain private metadata).
    const error = apiError(response.status === 429 ? 429 : response.status >= 500 ? 502 : 502,
      'GitHub storage returned HTTP ' + response.status);
    error.githubStatus = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function validId(value) {
  return /^agent-[0-9a-f]{32}$/.test(String(value || ''));
}

function workPath(job) {
  return job.collection + '/' + job.id;
}

function encodeJob(job) {
  const payload = Buffer.from(JSON.stringify(job)).toString('base64url');
  return payload + '.' + hmac('spine-link-agent-v1:' + payload);
}

function decodeJob(raw) {
  const [payload, signature, extra] = String(raw || '').split('.');
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]{10,1400}$/.test(payload) ||
      !/^[a-f0-9]{64}$/.test(signature) || !safeEqual(signature, hmac('spine-link-agent-v1:' + payload))) {
    throw apiError(401, 'Invalid job token');
  }
  let job;
  try {
    job = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw apiError(401, 'Invalid job token');
  }
  if (!validId(job?.id) || !/^library_\d{2,4}$/.test(job?.collection) ||
      !['runtime', 'spine-project'].includes(job?.format) ||
      typeof job?.title !== 'string' || job.title.length > 120 ||
      !Number.isSafeInteger(job?.createdAt) || job.createdAt > Date.now() + 300000 ||
      Date.now() - job.createdAt > JOB_TTL_MS) {
    throw apiError(401, 'Expired or invalid job token');
  }
  return job;
}

function fileName(value, format) {
  const name = String(value || '').replace(/\\/g, '/');
  if (!name || name.length > 400 || name.startsWith('/') || name.endsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') ||
        part.length > 180 || /[\x00-\x1f?#<>:"|*]/.test(part))) {
    throw apiError(400, 'Invalid file path');
  }
  if (format === 'spine-project') {
    if (/^[^/]+\.spine$/i.test(name) || /^images\/.+\.(png|jpe?g|webp)$/i.test(name)) return name;
  } else if (/\.(json|skel|atlas(?:\.txt)?|png|jpe?g|webp)$/i.test(name)) {
    return name;
  }
  throw apiError(400, 'Unsupported Spine file for this format');
}

function receiptSignature(job, path, sha, bytes, digest) {
  return hmac('spine-link-agent-receipt-v1:' + JSON.stringify([job.id, path, sha, bytes, digest]));
}

function verifyReceipt(job, raw) {
  const name = fileName(raw?.name, job.format);
  const path = workPath(job) + '/' + name;
  const sha = String(raw?.sha || '');
  const bytes = Number(raw?.bytes);
  const digest = String(raw?.sha256 || '');
  const signature = String(raw?.signature || '');
  if (raw?.path !== path || !/^[0-9a-f]{40}$/.test(sha) ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES ||
      !/^[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{64}$/.test(signature) ||
      !safeEqual(signature, receiptSignature(job, path, sha, bytes, digest))) {
    throw apiError(400, 'Invalid signed upload receipt');
  }
  return { name, path, sha, bytes, sha256: digest };
}

function fullBase64(value) {
  const raw = String(value || '');
  if (!raw || raw.length > MAX_BASE64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    throw apiError(413, 'Invalid or oversized Base64 payload (split the file into parts)');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.toString('base64') !== raw) throw apiError(400, 'Invalid Base64 encoding');
  return bytes;
}

async function activeCollection(settings) {
  const base = repoUrl(settings);
  if (process.env.GITHUB_BASE_PATH && process.env.GITHUB_BASE_PATH !== 'library') {
    const folder = process.env.GITHUB_BASE_PATH;
    if (!/^library_\d{2,4}$/.test(folder)) throw apiError(503, 'Agent API requires a numbered library collection');
    return folder;
  }
  const root = await github(settings, 'GET', base + '/contents/?ref=' + encodeURIComponent(settings.branch));
  const candidates = (Array.isArray(root) ? root : [])
    .filter(item => item?.type === 'dir' && /^library_\d{2,4}$/.test(item?.name || ''))
    .map(item => item.name)
    .sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)));
  for (const folder of candidates) {
    const response = await fetch('https://api.github.com' + base + '/contents/' + folder +
      '/index.json?ref=' + encodeURIComponent(settings.branch), {
      headers: { Authorization: 'Bearer ' + settings.token, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) continue;
    const payload = await response.json();
    const entries = JSON.parse(Buffer.from(String(payload.content || '').replace(/\s/g, ''), 'base64').toString('utf8'));
    if (!Array.isArray(entries)) throw apiError(503, 'Library index is invalid');
    if (entries.length >= 999) throw apiError(503, 'Active library is full; rotate collection before uploading');
    return folder;
  }
  throw apiError(503, 'No writable library collection found');
}

async function readBlob(settings, sha, expected) {
  const blob = await github(settings, 'GET', repoUrl(settings) + '/git/blobs/' + sha);
  if (blob?.encoding !== 'base64') throw apiError(502, 'Invalid stored blob encoding');
  const bytes = Buffer.from(String(blob.content || '').replace(/\s/g, ''), 'base64');
  if (expected && (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)) {
    throw apiError(422, 'Staged blob failed integrity verification');
  }
  return bytes;
}

function safeAnimations(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 150) throw apiError(400, 'Too many animations');
  return [...new Set(input.map(value => String(value || '').trim()).filter(Boolean))].filter(value => value.length <= 120);
}

async function prepareFiles(settings, job, singles, assemblies) {
  if (!Array.isArray(singles) || !Array.isArray(assemblies) ||
      singles.length + assemblies.length < 2 || singles.length + assemblies.length > MAX_FILES) {
    throw apiError(400, 'Submit a project with images or runtime skeleton, atlas, and textures as signed receipts');
  }
  const items = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const raw of singles) {
    const item = verifyReceipt(job, raw);
    if (seen.has(item.name)) throw apiError(400, 'Duplicate asset: ' + item.name);
    seen.add(item.name);
    items.push(item);
    totalBytes += item.bytes;
  }
  for (const assembly of assemblies) {
    const parts = assembly?.parts;
    if (!Array.isArray(parts) || parts.length < 2 || parts.length > 150) {
      throw apiError(400, 'Invalid multipart assembly');
    }
    const verified = parts.map(part => verifyReceipt(job, part));
    const name = fileName(assembly?.name, job.format);
    if (verified.some(part => part.name !== name) || seen.has(name)) {
      throw apiError(400, 'Invalid multipart path or duplicate');
    }
    seen.add(name);
    const size = verified.reduce((sum, part) => sum + part.bytes, 0);
    if (size > MAX_FILE_BYTES) throw apiError(413, 'File exceeds GitHub storage limit');
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) throw apiError(413, 'Job exceeds storage limit');
    const chunks = [];
    for (let i = 0; i < verified.length; i += 4) {
      chunks.push(...(await Promise.all(verified.slice(i, i + 4).map(part => readBlob(settings, part.sha, part)))));
    }
    const bytes = Buffer.concat(chunks);
    const blob = await github(settings, 'POST', repoUrl(settings) + '/git/blobs', {
      content: bytes.toString('base64'), encoding: 'base64',
    });
    items.push({ name, path: workPath(job) + '/' + name, sha: blob.sha, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw apiError(413, 'Job exceeds storage limit');
  const names = items.map(item => item.name);
  if (job.format === 'spine-project') {
    const projects = names.filter(name => /^[^/]+\.spine$/i.test(name));
    if (projects.length !== 1 || !names.some(name => /^images\/.+\.(png|jpe?g|webp)$/i.test(name))) {
      throw apiError(422, 'Exactly one .spine and images/ textures are required');
    }
  } else {
    const skeletons = names.filter(name => /\.(json|skel)$/i.test(name));
    if (!skeletons.length || !names.some(name => /\.atlas(?:\.txt)?$/i.test(name)) ||
        !names.some(name => /\.(png|jpe?g|webp)$/i.test(name))) {
      throw apiError(422, 'Runtime needs JSON/SKEL, .atlas, and textures');
    }
  }
  return items;
}

// Spine-Link's preview loader only recognizes a set when its skeleton, atlas,
// and textures live in the SAME directory (at most 3 levels under the work).
// Validate exactly the topology the site can render before reporting "ready".
async function inspectRuntimeBundle(settings, items, preferred = []) {
  const groups = new Map();
  for (const item of items) {
    const divider = item.name.lastIndexOf('/');
    const folder = divider === -1 ? '' : item.name.slice(0, divider);
    if (folder && folder.split('/').length > 3) {
      throw apiError(422, 'Spine export directory is too deep for the web player');
    }
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  }
  let firstAnimations = [];
  let found = false;
  for (const [folder, group] of groups) {
    const skeletons = group.filter(item => /\.(json|skel)$/i.test(item.name));
    const atlases = group.filter(item => /\.atlas(?:\.txt)?$/i.test(item.name));
    const textures = group.filter(item => /\.(png|jpe?g|webp)$/i.test(item.name));
    if (skeletons.length !== 1 || atlases.length !== 1 || textures.length === 0) {
      throw apiError(422, 'Each export directory needs exactly one JSON/SKEL, one atlas and matching texture images side by side: ' + (folder || '(root)'));
    }
    found = true;
    const atlas = atlases[0];
    if (atlas.bytes > 3_000_000) throw apiError(422, 'Atlas text exceeds validation limit');
    const atlasText = (await readBlob(settings, atlas.sha, atlas)).toString('utf8');
    const pages = atlasText.split(/\r?\n/).map(line => line.trim())
      .filter(line => /\.(png|jpe?g|webp)$/i.test(line));
    if (!pages.length) throw apiError(422, 'Atlas has no texture pages');
    const names = new Set(textures.map(item => item.name.slice(item.name.lastIndexOf('/') + 1).toLowerCase()));
    for (const page of pages) {
      // The browser loader matches texture assets to page filenames. Never
      // silently substitute a blank texture when an agent forgot a page.
      const pageName = page.replace(/\\/g, '/').split('/').pop().toLowerCase();
      if (!names.has(pageName)) throw apiError(422, 'Missing atlas texture: ' + pageName);
    }
    const skeleton = skeletons[0];
    let animations = [];
    if (/\.json$/i.test(skeleton.name)) {
      if (skeleton.bytes > 40_000_000) throw apiError(422, 'JSON skeleton too large to validate; export .skel instead');
      let parsed;
      try {
        parsed = JSON.parse((await readBlob(settings, skeleton.sha, skeleton)).toString('utf8'));
      } catch (error) {
        if (error?.status) throw error;
        throw apiError(422, 'Invalid Spine JSON skeleton');
      }
      if (!parsed?.skeleton || !parsed?.animations || typeof parsed.animations !== 'object' ||
          Array.isArray(parsed.animations)) {
        throw apiError(422, 'JSON is not a Spine runtime skeleton with animations');
      }
      const version = String(parsed.skeleton.spine || '');
      if (!/^4\.3(?:\.|$)/.test(version)) {
        throw apiError(422, 'Spine runtime version ' + (version || '(missing)') + ' is incompatible with player 4.3');
      }
      animations = safeAnimations(Object.keys(parsed.animations));
      if (!animations.length) throw apiError(422, 'Skeleton has no animations to play');
    } else {
      // A binary .skel is a runtime export, not an editor .spine project.
      // Check the version header so incompatible 4.1/4.2 projects never
      // receive the misleading "ready" state.
      const bytes = await readBlob(settings, skeleton.sha, skeleton);
      let version = '';
      function readString(cursor) {
        let len = 0;
        let shift = 0;
        for (let i = 0; i < 5; i++) {
          if (cursor.index >= bytes.length) throw new Error('Short skel header');
          const byte = bytes[cursor.index++];
          len |= (byte & 127) << shift;
          if ((byte & 128) === 0) {
            if (!len) return '';
            const end = cursor.index + len - 1;
            if (end > bytes.length) throw new Error('Short skel string');
            const value = bytes.subarray(cursor.index, end).toString('utf8');
            cursor.index = end;
            return value;
          }
          shift += 7;
        }
        throw new Error('Malformed skel header');
      }
      try {
        const cursor = { index: 0 };
        readString(cursor); // older binary: hash, then version
        version = readString(cursor);
        if (!/^4\.\d+/.test(version)) version = '';
      } catch {}
      if (!version) {
        try {
          version = readString({ index: 8 }); // 4.3 binary: 8-byte hash, then version
        } catch {}
      }
      if (!/^4\.3(?:\.|$)/.test(version)) {
        throw apiError(422, 'Binary .skel must use Spine 4.3; found ' + (version || 'invalid header'));
      }
      animations = safeAnimations(preferred);
    }
    if (!firstAnimations.length) firstAnimations = animations;
  }
  if (!found) throw apiError(422, 'No playable Spine export found');
  return firstAnimations;
}

async function commitJob(settings, job, items, entry) {
  const base = repoUrl(settings);
  const indexPath = job.collection + '/index.json';
  for (let attempt = 0; attempt < 6; attempt++) {
    const ref = await github(settings, 'GET', base + '/git/ref/heads/' + encodeURIComponent(settings.branch));
    const head = String(ref?.object?.sha || '');
    if (!/^[0-9a-f]{40}$/.test(head)) throw apiError(502, 'Invalid GitHub branch head');
    const index = await github(settings, 'GET', base + '/contents/' + indexPath + '?ref=' + head);
    if (index?.encoding !== 'base64') throw apiError(502, 'Invalid library index encoding');
    const entries = JSON.parse(Buffer.from(String(index.content).replace(/\s/g, ''), 'base64').toString('utf8'));
    if (!Array.isArray(entries)) throw apiError(502, 'Invalid library index');
    if (entries.some(item => item?.id === job.id)) {
      throw apiError(409, 'This animation has already been published; check its status');
    }
    if (entries.length >= 999) throw apiError(409, 'Library is full; create a new job in the active collection');
    const idxBlob = await github(settings, 'POST', base + '/git/blobs', {
      content: JSON.stringify([entry, ...entries], null, 2), encoding: 'utf-8',
    });
    const currentCommit = await github(settings, 'GET', base + '/git/commits/' + head);
    const tree = await github(settings, 'POST', base + '/git/trees', {
      base_tree: currentCommit.tree.sha,
      tree: [...items.map(item => ({ path: item.path, mode: '100644', type: 'blob', sha: item.sha })),
        { path: indexPath, mode: '100644', type: 'blob', sha: idxBlob.sha }],
    });
    const commit = await github(settings, 'POST', base + '/git/commits', {
      message: 'Agent animation: ' + job.id, tree: tree.sha, parents: [head],
    });
    try {
      await github(settings, 'PATCH', base + '/git/refs/heads/' + encodeURIComponent(settings.branch), {
        sha: commit.sha, force: false,
      });
      return commit.sha;
    } catch (error) {
      if (![409, 422].includes(error?.githubStatus) || attempt === 5) throw error;
    }
  }
  throw apiError(409, 'Concurrent publication conflict');
}

async function dispatch(settings, job) {
  const target = job.format === 'spine-project' ? '/repos/vladleopold/3Spine-core' : repoUrl(settings);
  const event_type = job.format === 'spine-project' ? 'spine-project-export' : 'spine-export-webm';
  try {
    await github(settings, 'POST', target + '/dispatches', {
      event_type,
      client_payload: {
        uploadId: job.id, uploadPath: workPath(job), origin: publicOrigin(),
        ...(job.format === 'spine-project' ? { projectFile: job.projectFile, imagesRoot: 'images', editorVersion: '4.3.26' } : {}),
      },
    });
    return 'dispatched';
  } catch {
    // Scheduled export workers recover when cross-repository dispatch is unavailable.
    return 'queued';
  }
}

function publicOrigin() {
  const raw = String(process.env.SPINE_LINK_SITE_ORIGIN || DEFAULT_ORIGIN);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return DEFAULT_ORIGIN;
    }
    return url.origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

async function status(settings, job, auth = {mode:'admin'}) {
  const base = repoUrl(settings);
  const path = job.collection + '/index.json?ref=' + encodeURIComponent(settings.branch);
  const result = await github(settings, 'GET', base + '/contents/' + path);
  const entries = JSON.parse(Buffer.from(String(result.content || '').replace(/\s/g, ''), 'base64').toString('utf8'));
  const entry = Array.isArray(entries) ? entries.find(item => item?.id === job.id) : null;
  if (auth.mode === 'personal') requireOwner(entry || job, auth);
  const format = entry?.sourceKind === 'spine-project' ? 'spine-project' : job.format;
  const conversionStatus = entry?.conversionStatus || (entry ? 'ready' : 'awaiting_upload');
  const state = !entry ? 'awaiting_upload' :
    format === 'spine-project'
      ? conversionStatus === 'ready' ? 'ready' : ['failed', 'needs-editor'].includes(conversionStatus) ? 'failed' : 'processing'
      : 'ready';
  return {
    ok: true, id: job.id, state, format,
    conversionStatus, webmStatus: entry?.webmStatus || '',
    animations: Array.isArray(entry?.animations) ? entry.animations : [],
    pageUrl: publicOrigin() + '/p/' + encodeURIComponent(job.id),
    ...(entry?.conversionError ? { error: String(entry.conversionError).slice(0, 300) } : {}),
  };
}

export async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST'].includes(request.method)) {
    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const bearer = String(request.headers?.authorization || '').match(/^Bearer ([^\s]+)$/i)?.[1] || '';
    const settings = githubSettings();
    const body = request.method === 'POST'
      ? typeof request.body === 'string' ? JSON.parse(request.body) : request.body || {}
      : {};
    const action = request.method === 'GET' ? 'status' : String(body?.action || '');
    if (['keys-list', 'keys-create', 'keys-revoke'].includes(action)) {
      // Browser OAuth is valid only for managing the signed-in user's keys.
      if (request.method !== 'POST') throw apiError(405, 'Use POST for key management');
      return response.status(200).json(await manageKeys(action, settings, bearer, body));
    }
    const auth = await authenticateAgentKey(settings, bearer);
    if (action === 'create') {
      const title = String(body.title || 'Untitled animation').trim().slice(0, 120);
      const format = body.format === 'spine-project' ? 'spine-project' : body.format === 'runtime' ? 'runtime' : null;
      if (!title || !format) throw apiError(400, 'title and format (runtime or spine-project) are required');
      const collection = await activeCollection(settings);
      const job = { id: 'agent-' + randomBytes(16).toString('hex'), collection, format, title, createdAt: Date.now(),
        ...(auth.mode === 'personal' ? { ownerId: auth.ownerId, apiKeyId: auth.keyId } : {}) };
      return response.status(201).json({
        ok: true, id: job.id, format, state: 'awaiting_upload',
        jobToken: encodeJob(job), uploadPath: workPath(job),
        pageUrl: publicOrigin() + '/p/' + job.id,
        stageMaxBase64Chars: MAX_BASE64, expiresAt: new Date(job.createdAt + JOB_TTL_MS).toISOString(),
      });
    }
    // Signed upload token is only required for writes. For long-running
    // automation the agent can poll an existing published ID and collection
    // indefinitely, with the same server-side Bearer API key.
    if (action === 'status') {
      const token = request.method === 'GET' ? request.query?.jobToken : body?.jobToken;
      if (token) return response.status(200).json(await status(settings, decodeJob(token), auth));
      const id = String(request.method === 'GET' ? request.query?.id || '' : body?.id || '');
      const collection = String(request.method === 'GET' ? request.query?.collection || '' : body?.collection || '');
      if (!validId(id) || !/^library_\d{2,4}$/.test(collection)) {
        throw apiError(400, 'Provide jobToken, or both agent id and library collection');
      }
      return response.status(200).json(await status(settings, { id, collection, format: 'runtime' }, auth));
    }
    const job = decodeJob(body.jobToken);
    requireOwner(job, auth);
    if (action === 'stage-batch') {
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length || files.length > 8) {
        throw apiError(400, 'Batch must contain 1 to 8 asset files');
      }
      const normalized = files.map(item => ({
        name: fileName(item?.name, job.format),
        contentBase64: String(item?.contentBase64 || ''),
      }));
      if (new Set(normalized.map(item => item.name)).size !== normalized.length) {
        throw apiError(400, 'Duplicate filenames in upload batch');
      }
      if (normalized.reduce((total, item) => total + item.contentBase64.length, 0) > MAX_BASE64) {
        throw apiError(413, 'Batch Base64 payload exceeds limit');
      }
      // Check every part before sending any bytes to GitHub. Splits of a large
      // file still use stage + assemblies; batch is for distinct small assets.
      const valid = normalized.map(item => ({ name: item.name, bytes: fullBase64(item.contentBase64) }));
      const receipts = [];
      for (let i = 0; i < valid.length; i += 4) {
        receipts.push(...await Promise.all(valid.slice(i, i + 4).map(async item => {
          const blob = await github(settings, 'POST', repoUrl(settings) + '/git/blobs', {
            content: item.bytes.toString('base64'), encoding: 'base64',
          });
          if (!/^[0-9a-f]{40}$/.test(String(blob?.sha || ''))) {
            throw apiError(502, 'Storage did not return a blob');
          }
          const path = workPath(job) + '/' + item.name;
          const digest = sha256(item.bytes);
          return {
            name: item.name, path, sha: blob.sha, bytes: item.bytes.length,
            sha256: digest, signature: receiptSignature(job, path, blob.sha, item.bytes.length, digest),
          };
        })));
      }
      return response.status(201).json({ ok: true, receipts });
    }
    if (action === 'stage') {
      const name = fileName(body.name, job.format);
      const bytes = fullBase64(body.contentBase64);
      const blob = await github(settings, 'POST', repoUrl(settings) + '/git/blobs', {
        content: bytes.toString('base64'), encoding: 'base64',
      });
      if (!/^[0-9a-f]{40}$/.test(String(blob?.sha || ''))) throw apiError(502, 'Storage did not return a blob');
      const path = workPath(job) + '/' + name;
      const digest = sha256(bytes);
      return response.status(201).json({
        ok: true, receipt: {
          name, path, sha: blob.sha, bytes: bytes.length, sha256: digest,
          signature: receiptSignature(job, path, blob.sha, bytes.length, digest),
        },
      });
    }
    if (action === 'complete') {
      const items = await prepareFiles(settings, job, body.files || [], body.assemblies || []);
      const names = items.map(item => item.name);
      const projectFile = job.format === 'spine-project'
        ? names.find(name => /^[^/]+\.spine$/i.test(name)) : '';
      const animations = job.format === 'runtime'
        ? await inspectRuntimeBundle(settings, items, body.animations) : [];
      const preferred = String(body.defaultAnimation || '').trim();
      const entry = {
        id: job.id, title: job.title,
        uploadedAt: new Date(job.createdAt).toISOString(), previewPath: workPath(job),
        files: names, sourceKind: job.format, ownerName: String(body.agentName || 'Animation Agent').trim().slice(0, 80),
        ...(auth.mode === 'personal' ? {
          ownerEmail: auth.ownerEmail,
          ownerAccountId: auth.ownerId,
          publicOwnerId: profileIdFromEmail(auth.ownerEmail),
          showOwnerLibrary: true,
        } : { showOwnerLibrary: false }),
        hiddenFromPublicLibrary: body.public !== true,
        portfolioMode: false,
        animations, defaultAnimation: animations.includes(preferred) ? preferred : animations[0] || '',
        webmStatus: job.format === 'spine-project' ? 'waiting-for-editor' : 'pending',
        dispatchStatus: 'pending',
        ...(job.format === 'spine-project'
          ? { projectFile, imagesRoot: 'images', conversionStatus: process.env.SPINE_PROJECT_EXPORT_ENABLED === 'false'
            ? 'needs-editor' : 'pending' }
          : { conversionStatus: 'ready', skeleton: names.find(name => /\.(json|skel)$/i.test(name)) || '',
            atlas: names.find(name => /\.atlas(?:\.txt)?$/i.test(name)) || '', textures: names.filter(name => /\.(png|jpe?g|webp)$/i.test(name)) }),
      };
      const commitSha = await commitJob(settings, job, items, entry);
      const dispatchState = await dispatch(settings, { ...job, projectFile });
      return response.status(201).json({
        ok: true, id: job.id, state: job.format === 'spine-project' ? 'processing' : 'ready',
        pageUrl: publicOrigin() + '/p/' + encodeURIComponent(job.id),
        conversionStatus: entry.conversionStatus, animations,
        dispatchStatus: dispatchState, commitSha,
      });
    }
    throw apiError(400, 'Unknown action: use create, stage, complete or GET status');
  } catch (error) {
    const statusCode = Number(error?.status) || 500;
    if (statusCode >= 500) console.error('[AGENT-API]', error instanceof Error ? error.message : 'Unexpected error');
    return response.status(statusCode >= 400 && statusCode <= 599 ? statusCode : 500)
      .json({ ok: false, error: statusCode >= 500 ? 'Agent API unavailable' : error.message });
  }
}

export default handler;
