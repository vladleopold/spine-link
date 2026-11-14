/**
 * Personal Spine-Link API keys. Storage keeps only HMAC digests, encrypted
 * owner emails, and non-secret metadata. Full keys are returned ONCE.
 * These credentials can publish under their verified Google account.
 */
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

// Never store account credentials in the public "vladleopold/spine" repo.
// The runtime token must have Contents: Read/Write in this PRIVATE repo.
const KEY_REPO = 'vladleopold/3Spine-core';
const KEY_BRANCH = 'main';
const KEY_FILE = '.spine-link/agent-api-keys.json';
const LIMIT = 5;
function fail(status, message) { const e = new Error(message); e.status = status; return e; }
function compare(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
function signingSecret() {
  const value = String(process.env.SPINE_LINK_AGENT_API_KEY || '');
  if (Buffer.byteLength(value) < 32) throw fail(503, 'Agent API is not configured');
  return value;
}
function mac(text) { return createHmac('sha256', signingSecret()).update(text).digest('hex'); }
function ownerId(sub) { return mac('owner-v1:' + sub); }
function digest(key) { return mac('personal-api-key-v1:' + key); }
function cipherKey() { return createHash('sha256').update('owner-email-v1:').update(signingSecret()).digest(); }
function encryptEmail(email) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cipherKey(), iv);
  const bytes = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}
function decryptEmail(raw) {
  try {
    const data = Buffer.from(raw, 'base64url');
    if (data.length < 29) throw Error('Invalid ciphertext');
    const dec = createDecipheriv('aes-256-gcm', cipherKey(), data.subarray(0, 12));
    dec.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([dec.update(data.subarray(28)), dec.final()]).toString('utf8');
  } catch {
    throw fail(503, 'Cannot read personal API key account information');
  }
}
function url() {
  return 'https://api.github.com/repos/' + KEY_REPO + '/contents/' + KEY_FILE;
}
function headers(settings) {
  return {
    Authorization: 'Bearer ' + settings.token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
async function readRegistry(settings) {
  const res = await fetch(url() + '?ref=' + encodeURIComponent(KEY_BRANCH), {headers: headers(settings)});
  if (res.status === 404) return {sha: '', keys: []};
  if (!res.ok) throw fail(502, 'API key storage unavailable');
  let doc;
  try {
    const content = await res.json();
    doc = JSON.parse(Buffer.from(String(content.content || '').replace(/\s/g, ''), 'base64').toString());
    if (content.encoding !== 'base64' || doc.version !== 1 || !Array.isArray(doc.keys) ||
        doc.keys.length > 100000) throw Error('Bad data');
    return {sha: content.sha, keys: doc.keys};
  } catch { throw fail(503, 'Invalid API key storage format'); }
}
async function mutateRegistry(settings, mutation) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prior = await readRegistry(settings);
    const keys = [...prior.keys];
    const output = mutation(keys);
    const res = await fetch(url(), {
      method:'PUT', headers: {...headers(settings), 'Content-Type':'application/json'},
      body: JSON.stringify({
        message:'Update personal Spine-Link API keys',
        branch:KEY_BRANCH,
        ...(prior.sha ? {sha:prior.sha}:{}),
        content:Buffer.from(JSON.stringify({version:1,keys},null,2)).toString('base64'),
      }),
    });
    if (res.ok) return output;
    if (attempt === 4 || ![409,422].includes(res.status)) throw fail(502, 'API key storage update failed');
  }
  throw fail(409, 'Concurrent API key change');
}
async function verifiedGoogle(accessToken) {
  if (!accessToken || accessToken.length > 4096) throw fail(401, 'Google sign-in required');
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '';
  if (!clientId) throw fail(503, 'Google sign-in is not configured');
  const tokenResponse = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || (token.aud !== clientId && token.azp !== clientId)) {
    throw fail(401, 'Invalid Google session');
  }
  const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers:{Authorization:'Bearer ' + accessToken},
  });
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile.sub || !profile.email ||
      ![true, 'true'].includes(profile.email_verified) ||
      (token.user_id && token.user_id !== profile.sub) ||
      (token.sub && token.sub !== profile.sub)) {
    throw fail(401, 'A verified Google account is required');
  }
  return {ownerId:ownerId(profile.sub), email:String(profile.email).trim().toLowerCase()};
}

// Only expose projects belonging to the verified Google account. Repository
// indexes are read from public work storage; API key secrets remain in the
// separate private repository. The client never receives raw index entries.
async function listOwnerProjects(settings, owner) {
  const base = 'https://api.github.com/repos/' +
    encodeURIComponent(settings.owner) + '/' + encodeURIComponent(settings.repo);
  const response = await fetch(base + '/contents/?ref=' + encodeURIComponent(settings.branch), {
    headers: headers(settings),
  });
  if (!response.ok) throw fail(502, 'Unable to list animation libraries');
  const roots = await response.json();
  if (!Array.isArray(roots)) throw fail(502, 'Invalid library listing');
  const folders = roots.filter(e => e.type === 'dir' && /^library_\d{2,4}$/.test(e.name))
    .map(e => e.name).sort((a,b)=>Number(b.slice(8))-Number(a.slice(8)))
    .slice(0, 40);
  const projects = [];
  for (let i=0; i<folders.length; i+=5) {
    const group = await Promise.all(folders.slice(i,i+5).map(async folder => {
      const res = await fetch(base + '/contents/' + folder +
        '/index.json?ref=' + encodeURIComponent(settings.branch), {headers:headers(settings)});
      if (res.status === 404) return [];
      if (!res.ok) throw fail(502, 'Unable to load library index');
      const source = await res.json();
      let entries;
      try {
        if (source.encoding !== 'base64') throw Error('Invalid index encoding');
        entries=JSON.parse(Buffer.from(String(source.content).replace(/\s/g,''),'base64').toString('utf8'));
      } catch { throw fail(502, 'Invalid library index'); }
      if (!Array.isArray(entries)) throw fail(502, 'Invalid library index');
      return entries.filter(entry => /^agent-[a-f0-9]{32}$/.test(String(entry?.id || '')) &&
        String(entry.ownerAccountId || '') === owner.ownerId)
        .map(entry => {
          const project = entry.sourceKind === 'spine-project';
          const conversion = String(entry.conversionStatus || (project?'pending':'ready'));
          return {
            id:entry.id,
            title:String(entry.title || 'Untitled animation').slice(0,120),
            createdAt:String(entry.uploadedAt || ''),
            format:project?'spine-project':'runtime',
            state:project ? conversion==='ready'?'ready':
              ['failed','needs-editor'].includes(conversion)?'failed':'processing' : 'ready',
            pageUrl:'https://spine-link.vercel.app/p/' + encodeURIComponent(entry.id),
            collection:folder,
            animations:Array.isArray(entry.animations)?entry.animations.length:0,
          };
        });
    }));
    projects.push(...group.flat());
  }
  return projects.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
}

const metadata = k => ({
  id:k.id, name:k.name, prefix:'slk_v1_' + k.id + '_••••',
  createdAt:k.createdAt, revokedAt:k.revokedAt || null, scope:'publish',
});

export async function manageKeys(action, settings, googleAccessToken, body = {}) {
  const user = await verifiedGoogle(googleAccessToken);
  if (action === 'keys-projects') {
    return {ok:true, projects:await listOwnerProjects(settings,user)};
  }
  if (action === 'keys-list') {
    const {keys} = await readRegistry(settings);
    return {ok:true, keys:keys.filter(k=>k.ownerId===user.ownerId)
      .map(metadata).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
  }
  if (action === 'keys-create') {
    const name = String(body.name || '').replace(/\s+/g,' ').trim();
    if (name.length < 3 || name.length > 60) throw fail(400, 'Name must be 3–60 characters');
    const id = randomBytes(8).toString('hex');
    const key = 'slk_v1_' + id + '_' + randomBytes(32).toString('base64url');
    const record = {
      id,name,ownerId:user.ownerId,tokenHash:digest(key),
      emailEnc:encryptEmail(user.email),createdAt:new Date().toISOString(),revokedAt:null,
    };
    await mutateRegistry(settings, keys => {
      if (keys.filter(k => k.ownerId===user.ownerId && !k.revokedAt).length >= LIMIT)
        throw fail(409, 'Limit of five active keys reached; revoke an unused key');
      keys.push(record);
    });
    return {ok:true, key, record:metadata(record)};
  }
  if (action === 'keys-revoke') {
    const id = String(body.keyId || '');
    if (!/^[a-f0-9]{16}$/.test(id)) throw fail(400, 'Invalid key ID');
    await mutateRegistry(settings, keys => {
      const target = keys.find(k=>k.id===id && k.ownerId===user.ownerId);
      if (!target) throw fail(404, 'API key not found');
      if (!target.revokedAt) target.revokedAt = new Date().toISOString();
    });
    return {ok:true, revoked:id};
  }
  throw fail(400, 'Unsupported API key operation');
}

export async function authenticateAgentKey(settings, bearer) {
  if (compare(bearer, signingSecret())) return {mode:'admin'};
  const match = String(bearer || '').match(/^slk_v1_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/);
  if (!match) throw fail(401, 'Invalid API key');
  const {keys} = await readRegistry(settings);
  const entry = keys.find(k=>k.id===match[1] && !k.revokedAt);
  if (!entry || !/^[a-f0-9]{64}$/.test(String(entry.tokenHash || '')) ||
      !compare(entry.tokenHash, digest(bearer))) throw fail(401, 'Invalid or revoked API key');
  return {mode:'personal', ownerId:entry.ownerId, keyId:entry.id, ownerEmail:decryptEmail(entry.emailEnc)};
}

export function requireOwner(jobOrEntry, auth) {
  if (auth.mode === 'admin') return;
  if (!jobOrEntry || String(jobOrEntry.ownerAccountId || jobOrEntry.ownerId || '') !== auth.ownerId)
    throw fail(403, "This key cannot access another user's projects");
  // A signed in-progress upload is bound to the key that created it.
  if (jobOrEntry.apiKeyId && jobOrEntry.apiKeyId !== auth.keyId)
    throw fail(403, 'This upload belongs to another API key');
}

export function profileIdFromEmail(email) {
  let hash=5381;
  for (const ch of String(email).toLowerCase()) hash=(hash*33)^ch.charCodeAt(0);
  return 'u_' + (hash>>>0).toString(36);
}
