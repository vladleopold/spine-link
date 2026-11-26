import agentAnimationHandler from '../lib/agent-animation.js';
import { createPublicUploaderEvidence } from '../lib/source-proof-privacy.js';
import { mergeCollectionEntries } from '../lib/library-accounts.js';
import { createRecoverySecret, normalizeRecoverySecret, hashRecoverySecret, addRecoveryHashToOwnedEntries, recoverEntriesByRecoveryHash, revokeRecoveryHashFromOwnedEntries, stripPrivateOwnerMetadata } from '../lib/anonymous-recovery.js';
import { githubMetricsCache } from '../lib/github-metrics-cache.js';
import { runSerializedWrite } from '../lib/serialized-write-queue.js';
import { cachedGithubText, invalidateCachedGithubText } from '../lib/github-content-cache.js';
import { githubLibraryFoldersCache } from '../lib/github-library-folders-cache.js';
import { verifyGoogleAccessToken } from '../lib/google-access-token.js';
import { githubErrorForResponse, shouldRetryGitHubResponse } from '../lib/github-rate-limit.js';
const defaultOwner = 'vladleopold';
const defaultRepo = 'spine';
const defaultBranch = 'main';
// New uploads always land in the highest-numbered library_NN folder, so the set of
// folders grows as needed instead of being capped at two. rotate-library.mjs keeps
// the newest folder under the 999-item GitHub limit by moving it into a permanent
// collection and opening the next one.
const DEFAULT_BASE_PATH_PREFIX = 'library_';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dataScienceSchema, inferDataScienceMetadata } from '../lib/spine-data-science.js';
import { metricCountsForIds, parseMetricsJson, sanitizeMetricId, sanitizeMetricIds } from '../lib/spine-metrics.js';
import { appendAssetVersion, assetVersionForEntry } from '../lib/asset-version.js';
import { inspectRuntimeAssetSet } from '../lib/runtime-acceptance.js';
import { isValidSpineAtlasHeader } from '../lib/spine-atlas-integrity.js';

const CENSORSHIP_FILE = 'library/censorship.json';

function normalizeIdList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\s,\n]+/);
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const id = String(raw || '').trim().replace(/^\/+|\/+$/g, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Lists of closed accounts live in the repository so they can be edited from the
// admin page without touching environment variables.
async function readCensorshipLists(settings) {
  try {
    const existing = await getGitHubContent(settings, CENSORSHIP_FILE);
    const parsed = existing?.content ? JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8')) : null;
    return {
      blocked: normalizeIdList(parsed?.blocked),
      allowed: normalizeIdList(parsed?.allowed),
    };
  } catch {
    return { blocked: [], allowed: [] };
  }
}

async function writeCensorshipLists(settings, { blocked, allowed }) {
  const payload = {
    updatedAt: new Date().toISOString(),
    blocked: normalizeIdList(blocked),
    allowed: normalizeIdList(allowed),
  };
  const existing = await getGitHubContent(settings, CENSORSHIP_FILE);
  await putGitHubContent(
    settings,
    CENSORSHIP_FILE,
    textToBase64(JSON.stringify(payload, null, 2)),
    'admin: обновить списки цензуры',
    existing?.sha,
    origin,
  );
  return payload;
}

// The collection that receives new uploads: the highest-numbered library_NN
// folder that actually holds an index.json. Empty placeholder folders are
// skipped, so a rotation that pre-created `library_90` never strands uploads
// there. Numbering starts at 02 because `library` is the first permanent
// collection, which is frozen and only read.
/** Cache key for the active collection list shared by this Vercel runtime. */
function libraryFoldersCacheKey(settings) {
  return [settings.owner, settings.repo, settings.branch].join(String.fromCharCode(10));
}

/** Collection folders that hold an index.json, newest first. */
async function collectionFoldersWithIndex(settings) {
  return githubLibraryFoldersCache.read(libraryFoldersCacheKey(settings), async () => {
    const response = await fetch(
      'https://api.github.com/repos/' + settings.owner + '/' + settings.repo + '/contents/?ref=' + encodeURIComponent(settings.branch),
      { headers: githubHeaders(settings.token) },
    );
    if (!response.ok) {
      const detailResponse = typeof response.clone === 'function' ? response.clone() : response;
      const detail = await detailResponse.json().then(value => typeof value?.message === 'string' ? value.message : '').catch(() => '');
      throw withGitHubStatus(githubFailure('list', '/', response, detail), response, detail);
    }
    const items = await response.json();
    const numbered = (Array.isArray(items) ? items : [])
      .map(item => item && item.type === 'dir' ? String(item.name || '').match(new RegExp('^' + DEFAULT_BASE_PATH_PREFIX + '(\\d+)$')) : null)
      .filter(Boolean)
      .map(match => ({ name: match[0], index: Number(match[1]) }))
      .sort((left, right) => right.index - left.index);
    const present = await Promise.all(numbered.map(async item => {
      const text = await cachedGithubText(settings, item.name + '/index.json', { ttlMs: 30000, preferRaw: true });
      return text ? item.name : '';
    }));
    return present.filter(Boolean);
  });
}

async function libraryCollectionIndexes(settings, { readOnly = false } = {}) {
  const folders = [...new Set([settings.basePath, ...(await collectionFoldersWithIndex(settings)), 'library'].filter(Boolean))];
  return Promise.all(folders.map(async basePath => {
    const indexPath = joinRepoPath(basePath, 'index.json');
    if (readOnly) {
      const text = await cachedGithubText(settings, indexPath, { ttlMs: 10000, preferRaw: true });
      const entries = text ? JSON.parse(text) : [];
      if (!Array.isArray(entries)) throw new Error('Invalid library index: ' + basePath);
      return { basePath, entries, sha: '' };
    }
    const content = await getGitHubContent(settings, indexPath);
    const entries = content?.content && content.encoding === 'base64' ? JSON.parse(base64ToText(content.content)) : [];
    if (!Array.isArray(entries)) throw new Error('Invalid library index: ' + basePath);
    return { basePath, entries, sha: content?.sha };
  }));
}
async function updateLibraryCollectionIndex(settings, collection, transform, message, origin) {
  const indexPath = joinRepoPath(collection.basePath, 'index.json');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = transform(collection.entries);
    if (!result.changed) {
      collection.entries = result.entries;
      return result;
    }
    try {
      await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(result.entries, null, 2)), message, collection.sha, origin);
      collection.entries = result.entries;
      return result;
    } catch (error) {
      if (attempt === 2 || ![409, 422].includes(Number(error?.status))) throw error;
      const fresh = await getGitHubContent(settings, indexPath);
      if (!fresh?.content || fresh.encoding !== 'base64') throw error;
      collection.entries = JSON.parse(base64ToText(fresh.content));
      collection.sha = fresh.sha;
    }
  }
  throw new Error(`Could not update library index: ${collection.basePath}`);
}

/** metrics.json of the collection that holds this work, else the active folder. */
async function metricsPathForEntry(settings, entryId) {
  for (const folder of await collectionFoldersWithIndex(settings)) {
    const index = await getGitHubContent(settings, joinRepoPath(folder, 'index.json'));
    if (!index || index.encoding !== 'base64') continue;
    try {
      const entries = JSON.parse(base64ToText(index.content));
      if (Array.isArray(entries) && entries.some((entry) => entry && entry.id === entryId)) {
        return joinRepoPath(folder, 'metrics.json');
      }
    } catch {}
  }
  return joinRepoPath(settings.basePath, 'metrics.json');
}

/** Metrics for these ids, merged across every collection. */
async function readMetricsAcrossCollections(settings, ids) {
  const wanted = new Set(sanitizeMetricIds(ids));
  const merged = { entries: {} };
  for (const folder of await collectionFoldersWithIndex(settings)) {
    const { metrics } = await readMetrics(settings, joinRepoPath(folder, 'metrics.json'));
    const entries = metrics && typeof metrics === 'object' ? metrics.entries : null;
    if (!entries || typeof entries !== 'object') continue;
    for (const [id, value] of Object.entries(entries)) {
      if (!wanted.size || wanted.has(id)) merged.entries[id] = value;
    }
  }
  return merged;
}

async function newestLibraryBasePath(settings) {
  if (process.env.LIBRARY_BASE_PATH) return cleanRepoPath(process.env.LIBRARY_BASE_PATH);
  const fallback = DEFAULT_BASE_PATH_PREFIX + '02';
  try { return (await collectionFoldersWithIndex(settings))[0] || fallback; }
  catch { return fallback; }
}
/**
 * Resolves a work folder against the active collection. Clients that only know
 * the upload id send a bare id, and the active library_NN folder is prepended
 * here, so a rotation moves uploads without touching the client. A path that
 * already starts with a collection folder is left alone.
 */
function resolveUploadPath(rawPath, basePath, uploadId = '') {
  const value = cleanRepoPath(rawPath || '');
  if (!value) return value;
  if (/^library(_\d+)?\//.test(value)) return value;
  const id = cleanRepoPath(uploadId || '');
  if (id && value === id) return joinRepoPath(basePath, id);
  if (id && value.startsWith(id + '/')) return joinRepoPath(basePath, value);
  return value;
}

function cleanRepoPath(value = '') {
  return String(value).trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function joinRepoPath(...parts) {
  return parts.map(cleanRepoPath).filter(Boolean).join('/');
}

function textToBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function base64ToText(base64) {
  return Buffer.from(String(base64).replace(/\s/g, ''), 'base64').toString('utf8');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256HexFromBase64(base64 = '') {
  return createHash('sha256').update(Buffer.from(String(base64).replace(/\s/g, ''), 'base64')).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitizeSha256(value = '') {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function publicGitHubWrite(result) {
  return {
    contentSha: String(result?.content?.sha || ''),
    commitSha: String(result?.commit?.sha || ''),
    commitUrl: String(result?.commit?.html_url || ''),
    downloadUrl: String(result?.content?.download_url || ''),
  };
}

function encodeRepoPath(path) {
  return cleanRepoPath(path)
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function isExternalAsset(value) {
  return /^https?:\/\//i.test(String(value)) || /^data:/i.test(String(value));
}

function assetUrlForRepoPath(origin, path, version = '') {
  return appendAssetVersion(`${origin}/assets/${encodeRepoPath(path)}`, version);
}

function assetFileName(value = '') {
  return cleanRepoPath(value).split('/').filter(Boolean).pop() || '';
}

function safeHttpAsset(value = '') {
  const url = String(value).trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function sourceProofHashFor(sourceProof) {
  if (!sourceProof || typeof sourceProof !== 'object') return '';
  const provided = sanitizeSha256(sourceProof.proofHash);
  const payload = JSON.parse(JSON.stringify(sourceProof));
  delete payload.proofHash;
  if (payload.blockchain && typeof payload.blockchain === 'object') {
    payload.blockchain.recommendedAnchorPayload = '';
  }
  const calculated = sha256Hex(canonicalJson(payload));
  if (provided && calculated !== provided) throw new Error('Source proof hash mismatch');
  return provided || calculated;
}

function normalizeUploadedProofFiles(value = []) {
  const files = Array.isArray(value) ? value : [];
  return files
    .map((file) => ({
      name: String(file?.name || '').trim().slice(0, 260),
      path: cleanRepoPath(file?.path || ''),
      bytes: Math.max(0, Math.round(Number(file?.bytes || 0) || 0)),
      sha256: sanitizeSha256(file?.sha256),
      github: {
        contentSha: String(file?.github?.contentSha || '').trim().slice(0, 80),
        commitSha: String(file?.github?.commitSha || '').trim().slice(0, 80),
        commitUrl: safeHttpAsset(file?.github?.commitUrl || ''),
        downloadUrl: safeHttpAsset(file?.github?.downloadUrl || ''),
      },
    }))
    .filter((file) => file.name && file.path && file.sha256)
    .slice(0, 250);
}

async function maybeAnchorOnEvm(anchorHash) {
  return {
    status: 'disabled',
    chain: 'evm',
    transactionData: `0x${anchorHash}`,
    message: 'Blockchain anchoring is temporarily disabled.',
  };
}

async function createBlockchainAnchor({ sourceProof, uploadedFiles, body, settings, googlePayload, anonymousAccount, origin }) {
  const sourceProofHash = sourceProofHashFor(sourceProof);
  if (!sourceProofHash) throw new Error('Invalid source proof hash');

  const uploadedAt = String(sourceProof?.uploadedAt || body?.uploadedAt || new Date().toISOString());
  const uploadPath = cleanRepoPath(body?.uploadPath || sourceProof?.github?.previewPath || '');
  const proofPath = cleanRepoPath(sourceProof?.proofPath || body?.proofPath || '');
  const proofUrl = safeHttpAsset(sourceProof?.proofUrl || body?.proofUrl || (proofPath ? assetUrlForRepoPath(origin, proofPath) : ''));
  const userEmail = String(googlePayload?.email || '').trim().toLowerCase();
  const anchorBase = {
    type: 'SpineLinkGitHubBlockchainAnchor',
    version: 2,
    createdAt: new Date().toISOString(),
    entryId: String(body?.entryId || sourceProof?.entryId || '').trim().slice(0, 220),
    title: cleanPublicProfileText(body?.title || sourceProof?.title || '', 180),
    uploadedAt,
    sourceProofHash,
    sourceProofPath: proofPath,
    sourceProofUrl: proofUrl,
    uploader: createPublicUploaderEvidence(sourceProof?.uploader, userEmail ? 'google-account' : 'anonymous-browser'),
    github: {
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch,
      repositoryUrl: `https://github.com/${settings.owner}/${settings.repo}`,
      uploadPath,
      files: normalizeUploadedProofFiles(uploadedFiles),
    },
    legalEvidence: {
      statement:
        'This record links uploaded-file SHA-256 hashes, upload timestamps, GitHub repository writes, and an optional EVM transaction payload for source-origin evidence.',
      privacy:
        'This public anchor records only the sign-in mode. It excludes email addresses and their hashes, anonymous account identifiers, browser fingerprints, and raw or hashed browser/device characteristics. Legacy version 1 proofs may contain fields that are no longer collected or published.',
    },
  };
  const anchorHash = sha256Hex(canonicalJson(anchorBase));
   const blockchain = await maybeAnchorOnEvm(anchorHash);
  return {
    ...anchorBase,
    anchorHash,
    recommendedAnchorPayload: `sha256:${anchorHash}`,
    blockchain,
  };
}

function derivedMediaFromFiles(origin, entry, extensions) {
  const previewPath = cleanRepoPath(entry?.previewPath || '');
  const files = Array.isArray(entry?.files) ? entry.files : [];
  const file = files.find((item) => extensions.some((extension) => String(item || '').toLowerCase().endsWith(extension)));
  return previewPath && file ? assetUrlForRepoPath(origin, joinRepoPath(previewPath, String(file)), assetVersionForEntry(entry, file)) : '';
}

function generatedThumbnailUrl(origin, entry) {
  const id = String(entry?.id || '').trim();
  const poster = String(entry?.thumbnailPoster || '');
  return id && /^data:image\/webp;base64,/i.test(poster)
    ? assetUrlForRepoPath(origin, `library/${id}/generated-preview.webp`, assetVersionForEntry(entry, 'generated-preview'))
    : '';
}

async function dispatchSpineProjectExport(settings, entry, origin) {
  const id = String(entry?.id || '').trim();
  if (!id || entry?.sourceKind !== 'spine-project' || entry?.testOnly === true) return null;
  // Project files are proprietary editor sources. The storage repository's
  // licensed Spine CLI workflow must produce JSON/atlas before any runtime can
  // animate them. Never pretend a .spine file is a .skel runtime export.
  try {
    // The public storage repository owns the licensed Ubuntu executor.
    // Dispatch directly there; the private repository is only credential storage.
    // Its hourly public queue scan recovers pending projects if dispatch is denied.
    const result = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/dispatches`, {
      method: 'POST',
      headers: githubHeaders(settings.token),
      body: JSON.stringify({
        event_type: 'spine-project-export',
        client_payload: {
          uploadId: id,
          uploadPath: cleanRepoPath(entry.previewPath || ''),
          projectFile: String(entry.projectFile || ''),
          imagesRoot: 'images',
          editorVersion: '4.3.26',
          origin: String(origin || '').replace(/\/+$/, ''),
        },
      }),
    });
    return result.ok ? { status: 'dispatched' } :
      { status: 'failed', error: 'Project conversion workflow dispatch HTTP ' + result.status };
  } catch (error) {
    return { status: 'failed', error: String(error) };
  }
}

async function dispatchSpineExportWebm(settings, entry, origin) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  const defaultAnimation = typeof entry?.defaultAnimation === 'string' ? entry.defaultAnimation : '';
  const animations = Array.isArray(entry?.animations) ? entry.animations : [];
  // Missing index metadata is explicit: the export worker loads the exact
  // uploaded skeleton with its pinned Spine runtime, then validates visible
  // motion before selecting a preview track; it never guesses from the index.
  try {
    const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/dispatches`, {
      method: 'POST',
      headers: githubHeaders(settings.token),
      body: JSON.stringify({
        event_type: 'spine-export-webm',
        client_payload: {
          uploadId: id,
          animation: defaultAnimation.trim() ? defaultAnimation : '__SPINE_AUTO__',
          animations,
          origin: String(origin || '').replace(/\/+$/, ''),
          owner: settings.owner,
          repo: settings.repo,
          branch: settings.branch,
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[UPLOAD] dispatch workflow error: ${response.status} ${text}`);
      return { status: 'failed', error: text };
    }
    return { status: 'dispatched' };
  } catch (error) {
    console.error('[UPLOAD] dispatch workflow exception:', error instanceof Error ? error.message : String(error));
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

export function publicLibraryEntry(origin, entry) {
  if (!entry || typeof entry !== 'object') return entry;
  // Authorization is computed against the original index record. Public API
  // cards never expose email, owner IDs, recovery hashes or API-key metadata.
  const next = stripPrivateOwnerMetadata(entry);
  const version = assetVersionForEntry(entry);
  next.thumbnail = appendAssetVersion(safeHttpAsset(next.thumbnail), version);
  // Generated WebP preview posters take precedence over uploaded texture
  // images. The texture remains the fallback only until the export worker
  // publishes a poster for this exact work.
  const generatedPoster = safeHttpAsset(entry.webpPosterMedium) ||
    safeHttpAsset(entry.webpPoster) ||
    safeHttpAsset(entry.webpPosterLow);
  next.thumbnailPoster =
    appendAssetVersion(generatedPoster || safeHttpAsset(next.thumbnailPoster), version) ||
    generatedThumbnailUrl(origin, entry) ||
    derivedMediaFromFiles(origin, entry, ['.webp', '.png', '.jpg', '.jpeg']);
  // The library/player APIs expose the medium clip first, then full/low.
  // This also makes an entry discoverable as soon as the export worker has
  // populated any supported preview tier.
  const generatedVideo = safeHttpAsset(entry.webmPreviewMedium) ||
    safeHttpAsset(entry.webmPreview) ||
    safeHttpAsset(entry.webmPreviewLow);
  next.webmPreview = appendAssetVersion(generatedVideo, version) ||
    derivedMediaFromFiles(origin, entry, ['.webm']);
  return next;
}

function publicLibraryEntries(origin, entries) {
  return Array.isArray(entries) ? entries.map((entry) => publicLibraryEntry(origin, entry)) : [];
}

function normalizePreviewHtml(settings, path, contentBase64, origin) {
  if (!path.endsWith('/preview.html')) return contentBase64;

  try {
    const html = base64ToText(contentBase64);
    const match = html.match(/(<script type="application\/json" id="spine-preview-config">)([\s\S]*?)(<\/script>)/);
    if (!match) return contentBase64;

    const uploadPath = cleanRepoPath(path).replace(/\/preview\.html$/, '');
    const assetUrl = (repoPath) => `${origin}/assets/${encodeRepoPath(repoPath)}`;
    const config = JSON.parse(match[2].replace(/\\u003c/g, '<'));

    for (const set of Array.isArray(config.sets) ? config.sets : []) {
      const setLabel = String(set.label || '');
      const setAssetUrl = (name) => assetUrl(joinRepoPath(uploadPath, setLabel, String(name || '')));

      if (set.skeleton && (!isExternalAsset(set.skeleton) || String(set.skeleton).includes('raw.githubusercontent.com'))) set.skeleton = setAssetUrl(set.skeleton.split('/').pop());
      if (set.atlas && (!isExternalAsset(set.atlas) || String(set.atlas).includes('raw.githubusercontent.com'))) set.atlas = setAssetUrl(set.atlas.split('/').pop());

      if (set.rawDataURIs && typeof set.rawDataURIs === 'object') {
        for (const key of Object.keys(set.rawDataURIs)) {
          const canonicalKey = assetFileName(key);
          if (!isExternalAsset(set.rawDataURIs[key]) || String(set.rawDataURIs[key]).startsWith('data:') || String(set.rawDataURIs[key]).includes('raw.githubusercontent.com')) {
            set.rawDataURIs[key] = setAssetUrl(canonicalKey || key);
          }
          if (canonicalKey && canonicalKey !== key) delete set.rawDataURIs[key];
          if (canonicalKey) set.rawDataURIs[canonicalKey] = setAssetUrl(canonicalKey);
        }
      }
    }

    const nextJson = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return textToBase64(html.replace(match[0], `${match[1]}${nextJson}${match[3]}`));
  } catch {
    return contentBase64;
  }
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function unauthorized(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function verifyGoogleToken(request, body) {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '';
  const authHeader = request.headers.authorization || request.headers.Authorization || '';
  const bearerToken = String(authHeader).match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const googleToken = bearerToken || String(body?.googleIdToken || '');

  if (!clientId) throw unauthorized('GOOGLE_CLIENT_ID is not configured', 500);
  if (!googleToken) throw unauthorized('Sign in with Google before uploading files');

  const idTokenResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(googleToken)}`);
  const idPayload = await idTokenResponse.json().catch(() => ({}));

  if (idTokenResponse.ok) {
    if (idPayload.aud !== clientId) throw unauthorized('Google token audience does not match this app');
    if (idPayload.email_verified !== true && idPayload.email_verified !== 'true') throw unauthorized('Google email is not verified');
    return idPayload;
  }

  try {
    const verified = await verifyGoogleAccessToken(googleToken, clientId);
    return verified.profile;
  } catch (error) {
    if (error?.code === 'google_oauth_client_mismatch') {
      console.warn('[AUTH] Google access-token audience mismatch', {
        status: Number(error.googleStatus) || 200, expectedClientId: clientId,
        issued_to: error.tokenInfo?.issued_to || null, audience: error.tokenInfo?.audience || null,
        aud: error.tokenInfo?.aud || null, azp: error.tokenInfo?.azp || null,
      });
      throw unauthorized('Google token audience does not match this app');
    }
    if (error?.code === 'google_access_token_invalid') {
      console.warn('[AUTH] Google access-token validation failed', {
        status: Number(error.googleStatus) || 0, error: typeof error.googleError === 'string' ? error.googleError : '',
      });
      throw unauthorized('Google session expired or invalid. Reconnect to continue.');
    }
    if (error?.code === 'google_token_validation_unavailable') throw unauthorized('Google sign-in validation is temporarily unavailable', 503);
    throw unauthorized(error instanceof Error ? error.message : 'Invalid Google token');
  }
}

async function optionalGooglePayload(request, body) {
  const authHeader = request.headers.authorization || request.headers.Authorization || '';
  const bearerToken = String(authHeader).match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const googleToken = bearerToken || String(body?.googleIdToken || '');
  if (!googleToken) return null;
  return verifyGoogleToken(request, body);
}

function normalizeAnonymousAccount(body) {
  const account = body?.anonymousAccount && typeof body.anonymousAccount === 'object' ? body.anonymousAccount : {};
  const id = String(account.id || body?.anonymousAccountId || '').trim();
  const fingerprint = String(account.fingerprint || body?.anonymousFingerprint || '').trim();
  if (!id || !/^anon_[a-z0-9_-]{3,96}$/i.test(id)) return null;
  return { id, fingerprint };
}


function normalizeNote(value = '') {
  const words = String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 20);
  return words.join(' ');
}

function cleanPublicProfileText(value = '', maxLength = 120) {
  return String(value).trim().slice(0, maxLength);
}

function cleanPublicProfileImage(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function hashString(value = '') {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function googleOwnerAccountId(googlePayload) {
  const sub = String(googlePayload?.sub || '');
  const signingKey = String(process.env.SPINE_LINK_AGENT_API_KEY || '');
  if (!sub || !signingKey || Buffer.byteLength(signingKey) < 32) return '';
  return createHmac('sha256', signingKey).update('owner-v1:' + sub).digest('hex');
}

function publicOwnerIdFor(googlePayload, anonymousAccount, fallback = '') {
  const provided = String(fallback || '').trim();
  if (/^u_[a-z0-9]{3,32}$/i.test(provided)) return provided;
  const source = String(googlePayload?.sub || anonymousAccount?.id || '').toLowerCase();
  return source ? `u_${sha256Hex(source).slice(0, 20)}` : '';
}

function applyOwnerMetadata(entry, googlePayload, anonymousAccount, existingEntry, fallbackPublicOwnerId = '') {
  const next = { ...entry };
  delete next.ownerEmail;
  delete next.ownerEmailSha256;
  delete next.ownerAccountId;
  delete next.ownerAnonId;
  delete next.ownerAnonFingerprint;
  delete next.ownerRecoveryHash;
  delete next.ownerRecoveryCreatedAt;
  delete next.apiKeyId;

  const publicOwnerId = publicOwnerIdFor(
    googlePayload,
    anonymousAccount,
    fallbackPublicOwnerId || existingEntry?.publicOwnerId,
  );
  if (publicOwnerId) next.publicOwnerId = publicOwnerId;

  if (googlePayload?.sub) {
    const ownerAccountId = googleOwnerAccountId(googlePayload);
    if (!ownerAccountId) throw new Error('Google owner signing key is not configured');
    next.ownerAccountId = ownerAccountId;
    delete next.ownerAnonId;
    delete next.ownerRecoveryHash;
    delete next.ownerRecoveryCreatedAt;
  } else if (anonymousAccount?.id && !existingEntry?.ownerAccountId) {
    next.ownerAnonId = anonymousAccount.id;
    const sameAnonymousOwner =
      String(existingEntry?.ownerAnonId || '').toLowerCase() === String(anonymousAccount.id).toLowerCase();
    if (sameAnonymousOwner && existingEntry?.ownerRecoveryHash) {
      next.ownerRecoveryHash = existingEntry.ownerRecoveryHash;
      if (existingEntry.ownerRecoveryCreatedAt) next.ownerRecoveryCreatedAt = existingEntry.ownerRecoveryCreatedAt;
    } else {
      delete next.ownerRecoveryHash;
      delete next.ownerRecoveryCreatedAt;
    }
  }

  return next;
}

// Google-linked works store a non-reversible HMAC of Google's account sub.
// Email addresses are not persisted in public library indexes.
function agentOwnerMatches(entry, googlePayload) {
  const stored = String(entry?.ownerAccountId || '');
  if (!/^[a-f0-9]{64}$/.test(stored)) return false;
  const digest = googleOwnerAccountId(googlePayload);
  if (!digest) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(digest));
}

export function canEditEntry(entry, googlePayload, anonymousAccount) {
  if (entry?.ownerAccountId) return agentOwnerMatches(entry, googlePayload);
  const userEmail = String(googlePayload?.email || '').toLowerCase();
  const ownerEmail = String(entry?.ownerEmail || '').toLowerCase();
  const anonymousId = String(anonymousAccount?.id || '').toLowerCase();
  const ownerAnonId = String(entry?.ownerAnonId || '').toLowerCase();
  const emailHash = String(entry?.ownerEmailSha256 || '').toLowerCase();
  if (userEmail && ownerEmail && userEmail !== ownerEmail) return false;
  if (userEmail && !ownerEmail && emailHash) return sha256Hex(userEmail) === emailHash;
  return Boolean((userEmail && ownerEmail === userEmail) || (anonymousId && ownerAnonId === anonymousId));
}

function accountLibraryEntries(origin, entries, googlePayload, anonymousAccount) {
  return (Array.isArray(entries) ? entries : []).map(entry => {
    // Compute authorization against the original index record before the
    // public projection removes its private owner/recovery metadata.
    const canEdit = canEditEntry(entry, googlePayload, anonymousAccount);
    const next = { ...publicLibraryEntry(origin, entry), canEdit };
    // The account list is a card index, not the complete download manifest.
    // Large per-animation exports can exceed the server response limit.
    delete next.allAnimationPreviews;
    delete next.blockchainAnchor;
    delete next.sourceProof;
    return next;
  });
}

const archiveAdminEmails = new Set([
  'vladyslavchaplygin@gmail.com',
  'vladyslavchaplyрin@gmail.com',
  'leopolds2010@gmail.com',
]);

function isArchiveAdmin(googlePayload) {
  return archiveAdminEmails.has(String(googlePayload?.email || '').trim().toLowerCase());
}

function normalizeArchiveExclusionRules(value) {
  const rules = Array.isArray(value) ? value : [];
  return rules
    .map((rule) => ({
      enabled: rule?.enabled !== false,
      type: rule?.type === 'regex' ? 'regex' : 'contains',
      field: ['all', 'id', 'title', 'ownerEmail', 'ownerName', 'note', 'files', 'animations', 'path'].includes(String(rule?.field || ''))
        ? String(rule.field)
        : 'all',
      pattern: String(rule?.pattern || '').trim().slice(0, 400),
      flags: String(rule?.flags || 'i').replace(/[^dgimsuvy]/g, '').slice(0, 8) || 'i',
    }))
    .filter((rule) => rule.pattern)
    .slice(0, 3000);
}

function normalizeArchiveEntryIds(value) {
  const ids = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];
  for (const id of ids) {
    const entryId = String(id || '').trim();
    if (!entryId || entryId.length > 220 || /[<>"'\\/\0]/.test(entryId) || seen.has(entryId)) continue;
    seen.add(entryId);
    normalized.push(entryId);
    if (normalized.length >= 1000) break;
  }
  return normalized;
}

function metricsVisitorHash(request, body = {}) {
  const provided = String(body?.visitorId || '').trim();
  const fallback = [
    request.headers['x-forwarded-for'] || request.socket?.remoteAddress || '',
    request.headers['user-agent'] || '',
  ].join('|');
  return createHash('sha256').update(provided || fallback || 'anonymous').digest('hex').slice(0, 32);
}

function normalizeMetrics(metrics) {
  const next = metrics && typeof metrics === 'object' ? metrics : {};
  if (!next.entries || typeof next.entries !== 'object' || Array.isArray(next.entries)) next.entries = {};
  return next;
}

function normalizeEntryMetric(metrics, id) {
  const metricId = sanitizeMetricId(id);
  if (!metricId) return null;
  const current = metrics.entries[metricId] && typeof metrics.entries[metricId] === 'object' ? metrics.entries[metricId] : {};
  current.likes = Math.max(0, Number(current.likes || 0) || 0);
  current.views = Math.max(0, Number(current.views || 0) || 0);
  if (!current.likedBy || typeof current.likedBy !== 'object' || Array.isArray(current.likedBy)) current.likedBy = {};
  if (!current.recentViews || typeof current.recentViews !== 'object' || Array.isArray(current.recentViews)) current.recentViews = {};
  metrics.entries[metricId] = current;
  return current;
}

function pruneRecentViews(entry, now) {
  const cutoff = now - 32 * 24 * 60 * 60 * 1000;
  const pairs = Object.entries(entry.recentViews || {})
    .map(([key, value]) => [key, Date.parse(String(value || '')) || 0])
    .filter(([, time]) => time >= cutoff)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2000);
  entry.recentViews = Object.fromEntries(pairs.map(([key, time]) => [key, new Date(time).toISOString()]));
}

async function readMetrics(settings, metricsPath) {
  return githubMetricsCache.read(settings, metricsPath, async () => {
    try {
      const current = await getGitHubContent(settings, metricsPath);
      const text = current?.content && current.encoding === 'base64' ? base64ToText(current.content) : '';
      return { current, metrics: normalizeMetrics(parseMetricsJson(text)) };
    } catch (error) {
      const rateLimitDetails = `${String(error?.message || '')} ${String(error?.githubMessage || '')}`;
      if (!/rate limit|secondary rate|abuse detection/i.test(rateLimitDetails)) throw error;
      // The collection is public. Raw GitHub remains readable when the
      // authenticated Contents API quota is exhausted; serve counts without
      // attempting a write until a fresh Contents SHA is available.
      const text = await cachedGithubText(settings, metricsPath, { ttlMs: 15_000, preferRaw: true });
      if (!text) throw error;
      return { current: null, metrics: normalizeMetrics(parseMetricsJson(text)), stale: true };
    }
  });
}

async function mutateMetrics(settings, metricsPath, message, mutate, origin = '') {
  const queueKey = [settings.owner, settings.repo, settings.branch, metricsPath].join('/');
  return runSerializedWrite(queueKey, async () => {
    // A warm Vercel instance may handle several metric updates concurrently.
    // Serialize those writes locally, then retain optimistic-SHA retries for
    // collisions with other serverless instances.
    const attempts = 6;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const { current, metrics, stale } = await readMetrics(settings, metricsPath);
        if (stale) return { metrics, changed: false, deferred: true };
        const changed = mutate(metrics);
        if (!changed) return { metrics, changed: false };
        metrics.updatedAt = new Date().toISOString();
        const written = await putGitHubContent(settings, metricsPath, textToBase64(JSON.stringify(metrics, null, 2)), message, current?.sha, origin);
        githubMetricsCache.set(settings, metricsPath, written?.content || written, metrics);
        return { metrics, changed: true };
      } catch (error) {
        const conflict = Number(error?.status) === 409 || /sha/i.test(String(error?.message || ''));
        if (conflict) githubMetricsCache.invalidate(settings, metricsPath);
        if (!conflict || attempt >= attempts - 1) throw error;
        const delay = Math.min(200 * 2 ** attempt + Math.floor(Math.random() * 300), 1500);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Could not update metrics after retries');
  });
}

function compareLibraryEntries(a, b) {
  const aOrder = Number(a?.libraryOrder);
  const bOrder = Number(b?.libraryOrder);
  const hasAOrder = Number.isFinite(aOrder);
  const hasBOrder = Number.isFinite(bOrder);
  if (hasAOrder && hasBOrder && aOrder !== bOrder) return aOrder - bOrder;
  if (hasAOrder !== hasBOrder) return hasAOrder ? -1 : 1;
  return String(b?.uploadedAt || '').localeCompare(String(a?.uploadedAt || ''));
}

function isSameLibraryOwner(entry, targetEntry) {
  const publicOwnerId = String(targetEntry?.publicOwnerId || '');
  const ownerEmail = String(targetEntry?.ownerEmail || '').toLowerCase();
  const ownerAnonId = String(targetEntry?.ownerAnonId || '').toLowerCase();
  const samePublicOwner = publicOwnerId && String(entry?.publicOwnerId || '') === publicOwnerId;
  const sameEmail = ownerEmail && String(entry?.ownerEmail || '').toLowerCase() === ownerEmail;
  const sameAnon = ownerAnonId && String(entry?.ownerAnonId || '').toLowerCase() === ownerAnonId;
  return Boolean(samePublicOwner || sameEmail || sameAnon);
}

function dataScienceBasePathFor(body) {
  return cleanRepoPath(process.env.DATA_SCIENCE_BASE_PATH || body?.dataScience?.basePath || 'data-science');
}

// Reads the catalog and returns the exact bytes that would be written. The
// single-commit publish path folds these into the same tree as the preview
// files, so it must not write anything itself.
async function prepareDataScienceCatalog(settings, body, entry) {
  if (body?.dataScience?.enabled === false) return null;
  const basePath = dataScienceBasePathFor(body);
  if (!basePath) return null;

  const metadata = inferDataScienceMetadata(entry, settings);
  const animationAsset = metadata.animation_asset || {};
  const itemId = String(animationAsset.id || entry?.id || '');
  const itemPath = joinRepoPath(basePath, 'items', `${itemId}.json`);
  const indexPath = joinRepoPath(basePath, 'index.json');
  const schemaPath = joinRepoPath(basePath, 'schema.json');
  const currentIndex = await getGitHubContent(settings, indexPath);
  const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
  const indexRecord = {
    id: itemId,
    name: animationAsset.name || itemId,
    updatedAt: metadata.updatedAt,
    animation_asset: animationAsset,
    source: metadata.source,
    spine_spec: metadata.spine_spec,
    inference: metadata.inference,
    privacy: metadata.privacy,
  };
  const nextEntries = [indexRecord, ...currentEntries.filter((currentEntry) => String(currentEntry?.id || '') !== itemId)];

  return {
    summary: { basePath, itemPath, indexPath, schemaPath, animation_asset: animationAsset, inference: metadata.inference },
    writes: [
      { path: itemPath, contentBase64: textToBase64(JSON.stringify(metadata, null, 2)), suffix: 'data-science item' },
      { path: indexPath, contentBase64: textToBase64(JSON.stringify(nextEntries, null, 2)), suffix: 'data-science index' },
      { path: schemaPath, contentBase64: textToBase64(JSON.stringify(dataScienceSchema(), null, 2)), suffix: 'data-science schema' },
    ],
  };
}

async function updateDataScienceCatalog(settings, body, entry, commitPrefix, origin) {
  const prepared = await prepareDataScienceCatalog(settings, body, entry);
  if (!prepared) return null;
  for (const write of prepared.writes) {
    const current = await getGitHubContent(settings, write.path);
    await putGitHubContent(settings, write.path, write.contentBase64, `${commitPrefix}: ${write.suffix}`, current?.sha, origin);
  }
  return prepared.summary;
}

// Every anonymous upload shares one GITHUB_TOKEN. Retry only transient
// transport/server failures; primary and secondary rate limits must be returned
// immediately with Retry-After so concurrent users do not amplify the limit.
// GitHub 409 on a write means the expected branch/file SHA is stale. It must
// be returned to the caller so the index can be re-read, not replayed with the
// same stale SHA (which can overwrite another person's just-published work).
const GITHUB_RETRY_ATTEMPTS = 8;

function githubRetryDelay(attempt) {
  return Math.min(300 * 2 ** attempt + Math.floor(Math.random() * 550), 6000);
}

// The response body a client sees when the platform terminates the function
// (timeout, OOM, crash) is not JSON, so the client logs an empty object and the
// real cause is invisible. `err.status` is read separately from statusCode
// because statusCode is reserved for the HTTP reply we synthesise here.
function withGitHubStatus(error, response, githubMessage = '') {
  const status = Number(response?.status) || 0;
  if (!error || typeof error !== 'object' || status < 400) return error;
  error.status = status;
  // Prefer GitHub's own explanation; fall back to ours only when GitHub said
  // nothing useful. Without this the console showed our generic summary and
  // the real reason stayed invisible.
  const detail = String(githubMessage || '').trim();
  error.githubMessage = detail && detail !== error.message ? detail : '';
  return error;
}

// A GitHub rate limit is not a server fault: it means "come back later", and
// every anonymous upload shares one GITHUB_TOKEN, so the limit hits all users
// at once. Surfacing that as a 500 made the browser look broken and gave the
// client nothing to act on. Hand it back as 429 with the window GitHub gave us
// so the client can wait it out instead of hammering and losing the upload.
function githubFailure(verb, path, response, detail = '') {
  return githubErrorForResponse({ verb, path, response, message: detail });
}

export async function getGitHubContent(settings, path) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
  let response = null;
  let responseDetail = '';
  for (let attempt = 0; attempt < GITHUB_RETRY_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch('https://api.github.com/repos/' + settings.owner + '/' + settings.repo + '/contents/' + encodedPath + '?ref=' + encodeURIComponent(settings.branch), { headers: githubHeaders(settings.token) });
    } catch (error) {
      if (attempt === GITHUB_RETRY_ATTEMPTS - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, githubRetryDelay(attempt)));
      continue;
    }
    if (response.ok || response.status === 404) break;
    const detailResponse = typeof response.clone === 'function' ? response.clone() : response;
    responseDetail = await detailResponse.json().then(value => typeof value?.message === 'string' ? value.message : '').catch(() => '');
    if (!shouldRetryGitHubResponse(response, responseDetail)) break;
    if (attempt < GITHUB_RETRY_ATTEMPTS - 1) await new Promise(resolve => setTimeout(resolve, githubRetryDelay(attempt)));
  }
  if (response.status === 404) return null;
  if (!response.ok) throw withGitHubStatus(githubFailure('read', path, response, responseDetail), response, responseDetail);
  const data = await response.json();
  if (data?.encoding !== 'base64' || !data?.content) {
    if (data?.sha) {
      const blobResponse = await fetch('https://api.github.com/repos/' + settings.owner + '/' + settings.repo + '/git/blobs/' + data.sha, { headers: githubHeaders(settings.token) });
      if (blobResponse.ok) {
        const blob = await blobResponse.json();
        if (blob?.encoding === 'base64' && blob?.content) return { ...data, encoding: 'base64', content: blob.content };
      }
    }
    if (typeof data?.download_url === 'string' && data.download_url) {
      const rawResponse = await fetch(data.download_url, { headers: githubHeaders(settings.token) });
      if (rawResponse.ok) {
        const rawBytes = Buffer.from(await rawResponse.arrayBuffer());
        return { ...data, encoding: 'base64', content: rawBytes.toString('base64') };
      }
    }
  }
  return data;
}
async function putGitHubContent(settings, path, contentBase64, message, sha, origin = '') {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
  const normalizedContentBase64 = normalizePreviewHtml(settings, path, contentBase64, origin);
  const body = JSON.stringify({ message, content: normalizedContentBase64, branch: settings.branch, ...(sha ? { sha } : {}) });
  let lastError;
  for (let attempt = 0; attempt < GITHUB_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}`, {
        method: 'PUT',
        headers: {
          ...githubHeaders(settings.token),
          'Content-Type': 'application/json',
        },
        body,
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        const normalizedPath = cleanRepoPath(path);
        invalidateCachedGithubText(settings, normalizedPath);
        if (normalizedPath === 'index.json' || normalizedPath.endsWith('/index.json')) githubLibraryFoldersCache.invalidate(libraryFoldersCacheKey(settings));
        return result;
      }
      // Rate-limited writes are returned immediately with Retry-After. Only
      // transient transport/server failures are retried in this function.
      if (shouldRetryGitHubResponse(response, typeof result?.message === 'string' ? result.message : '') && attempt < GITHUB_RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, githubRetryDelay(attempt)));
        lastError = withGitHubStatus(new Error(typeof result?.message === 'string' ? result.message : `Upload API ${response.status}`), response, typeof result?.message === 'string' ? result.message : '');
        continue;
      }
      // Carry GitHub's own wording into the error. Our summary line ("Storage
      // write failed for <path>: 422") says nothing about why, and GitHub's
      // message ("sha wasn't supplied") is the only clue that makes a failure
      // diagnosable from the browser console.
      throw withGitHubStatus(githubFailure('write', path, response, typeof result?.message === 'string' ? result.message : ''), response, typeof result?.message === 'string' ? result.message : '');
    } catch (err) {
      lastError = err;
      // Only retry what the retry set says is worth retrying. A definitive
      // answer (422 "sha mismatch", 404, 401) must surface immediately: the
      // chunk writer relies on seeing 422 to look the current sha up, and
      // replaying it four times only burned seconds before failing anyway.
      const definitive = Number(err?.status) >= 400 && !shouldRetryGitHubResponse({ status: Number(err.status) }, err?.githubMessage || '');
      if (definitive || attempt >= GITHUB_RETRY_ATTEMPTS - 1) break;
      await new Promise((r) => setTimeout(r, githubRetryDelay(attempt)));
    }
  }
  throw lastError;
}

async function deleteGitHubContent(settings, path, message, sha) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
  const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}`, {
    method: 'DELETE',
    headers: {
      ...githubHeaders(settings.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      sha,
      branch: settings.branch,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 404) {
    throw new Error(typeof result?.message === 'string' ? result.message : `Delete API ${response.status}`);
  }
  return result;
}

async function deleteGitHubPath(settings, path, commitPrefix) {
  const item = await getGitHubContent(settings, path);
  if (!item) return;
  if (Array.isArray(item)) {
    for (const child of item) {
      await deleteGitHubPath(settings, child.path, commitPrefix);
    }
    return;
  }
  if (item.type === 'file' && item.sha) {
    await deleteGitHubContent(settings, item.path || path, `${commitPrefix}: ${item.name || path}`, item.sha);
  }
}

// One-commit writer (Git Data API).
//
// The old publish flow wrote one file per request: a Contents API PUT per file,
// which is one commit each, plus a separate chunk staging and cleanup round trip
// for every large texture. A five file animation cost 7-40 sequential Vercel
// invocations, each paying GitHub round trips of its own. Everything a publish
// needs - files, assembled chunks, the source-proof anchor, index.json and the
// data-science catalog - is folded into a single commit here instead.
async function githubApi(settings, method, apiPath, payload) {
  let lastError;
  for (let attempt = 0; attempt < GITHUB_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: { ...githubHeaders(settings.token), 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;
      const detail = typeof data?.message === 'string' ? data.message : '';
      const failure = withGitHubStatus(githubFailure(method === 'GET' ? 'read' : 'write', apiPath, response, detail), response, detail);
      if (!shouldRetryGitHubResponse(response, detail)) throw failure;
      lastError = failure;
      await new Promise((resolve) => setTimeout(resolve, githubRetryDelay(attempt)));
    } catch (error) {
      lastError = error;
      const definitive = Number(error?.status) >= 400 && !shouldRetryGitHubResponse({ status: Number(error.status) }, error?.githubMessage || '');
      if (definitive || attempt >= GITHUB_RETRY_ATTEMPTS - 1) break;
      await new Promise((resolve) => setTimeout(resolve, githubRetryDelay(attempt)));
    }
  }
  throw lastError;
}

async function commitGitHubChanges(settings, { writes, stagedBlobs = [], deletions = [], deleteTrees = [], message, origin = '' }) {
  const repoApi = '/repos/' + settings.owner + '/' + settings.repo;
  const branchRef = repoApi + '/git/refs/heads/' + encodeURIComponent(settings.branch);
  const normalized = Array.isArray(writes)
    ? writes.map(write => ({
        path: cleanRepoPath(String(write?.path || '')),
        contentBase64: normalizePreviewHtml(settings, String(write?.path || ''), String(write?.contentBase64 || ''), origin),
      })).filter(write => write.path && write.contentBase64)
    : [];

  // Upload immutable blobs ONCE, in parallel, before reading the current branch
  // head. GitHub writes from other users/export workers cannot invalidate blobs.
  // Retries only reconstruct a tree/commit, never reupload megabytes of assets.
  const preparedEntries = stagedBlobs.map(item => ({
    path: item.path, mode: '100644', type: 'blob', sha: item.sha,
  }));
  const CONCURRENCY = 4;
  for (let index = 0; index < normalized.length; index += CONCURRENCY) {
    const slice = normalized.slice(index, index + CONCURRENCY);
    const blobs = await Promise.all(slice.map(write =>
      githubApi(settings, 'POST', repoApi + '/git/blobs',
        { content: write.contentBase64, encoding: 'base64' })));
    blobs.forEach((blob, offset) => {
      const sha = String(blob?.sha || '');
      if (!sha) throw new Error('GitHub did not acknowledge an uploaded asset blob');
      preparedEntries.push({ path: slice[offset].path, mode: '100644', type: 'blob', sha });
    });
  }
  for (const rawPath of deletions) {
    const path = cleanRepoPath(String(rawPath || ''));
    if (path) preparedEntries.push({ path, mode: '100644', type: 'blob', sha: null });
  }
  // Git's tree API supports deleting a whole subtree (040000, sha:null).
  // Use it instead of a GitHub Contents DELETE and commit per uploaded file.
  for (const rawPath of deleteTrees) {
    const path = cleanRepoPath(String(rawPath || ''));
    if (path) preparedEntries.push({ path, mode: '040000', type: 'tree', sha: null });
  }
  if (!preparedEntries.length) throw new Error('Nothing to write');

  let lastError;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const ref = await githubApi(settings, 'GET', branchRef);
      const headSha = String(ref?.object?.sha || '');
      if (!headSha) throw new Error('GitHub branch ' + settings.branch + ' not found');
      const headCommit = await githubApi(settings, 'GET', repoApi + '/git/commits/' + headSha);
      const baseTree = String(headCommit?.tree?.sha || '');
      if (!baseTree) throw new Error('GitHub head tree not found');

      const tree = await githubApi(settings, 'POST', repoApi + '/git/trees', {
        base_tree: baseTree, tree: preparedEntries,
      });
      const commit = await githubApi(settings, 'POST', repoApi + '/git/commits', {
        message, tree: tree.sha, parents: [headSha],
      });
      // Non-fast-forward is a NORMAL concurrent writer, not a broken upload.
      // Retry against a fresh head; no blob bytes are sent again.
      await githubApi(settings, 'PATCH', branchRef, { sha: commit.sha });
      for (const write of normalized) {
        invalidateCachedGithubText(settings, write.path);
        if (write.path === 'index.json' || write.path.endsWith('/index.json')) githubLibraryFoldersCache.invalidate(libraryFoldersCacheKey(settings));
      }
      // Callers consume the GitHub commit SHA and URL directly; returning a
      // wrapper silently erased commit receipts and source audit metadata.
      return commit;
    } catch (error) {
      lastError = error;
      if (![409, 422].includes(Number(error?.status)) || attempt === 6) break;
      await new Promise(resolve => setTimeout(resolve, 120 + Math.floor(Math.random() * 400)));
    }
  }
  throw lastError;
}

// Receipts for the batch commit: one commit covers every path, so the per-file
// identity is the blob sha the client hashes back into its source proof.
function publicBatchReceipts(commit, writes) {
  const commitSha = String(commit?.sha || '');
  const commitUrl = String(commit?.html_url || '');
  return writes.map((write) => ({
    path: write.path,
    name: String(write.path || '').split('/').pop() || '',
    bytes: Buffer.from(String(write.contentBase64 || '').replace(/\s/g, ''), 'base64').byteLength,
    sha256: sha256HexFromBase64(write.contentBase64),
    github: { contentSha: '', commitSha, commitUrl, downloadUrl: '' },
  }));
}

// Staged Git blobs are not visible on the branch until the final atomic commit.
// Sign every receipt with the server-side GitHub token so a client cannot make
// the server publish unrelated blob SHAs or paths by fabricating a receipt.
const STAGE_BASE64_LIMIT = 3_300_000;
function stageReceiptSignature(token, uploadId, path, sha, bytes, sha256) {
  return createHmac('sha256', token)
    .update('spine-link-stage-v1:')
    .update(JSON.stringify([String(uploadId), String(path), String(sha), Number(bytes), String(sha256)]))
    .digest('hex');
}
function verifyStageReceipt(settings, item, uploadId, workPath) {
  const path = cleanRepoPath(item?.path || '');
  const sha = String(item?.blobSha || '');
  const bytes = Number(item?.bytes);
  const sha256 = String(item?.sha256 || '');
  const signature = String(item?.signature || '');
  const prefix = cleanRepoPath(workPath);
  if (!uploadId || !prefix || !path.startsWith(prefix + '/') ||
      !/^[a-f0-9]{40}$/i.test(sha) || !Number.isSafeInteger(bytes) || bytes < 1 ||
      !/^[a-f0-9]{64}$/i.test(sha256) || !/^[a-f0-9]{64}$/i.test(signature)) {
    throw unauthorized('Invalid staged asset receipt', 400);
  }
  const expected = stageReceiptSignature(settings.token, uploadId, path, sha, bytes, sha256);
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
    throw unauthorized('Staged asset receipt does not match', 400);
  }
  return { path, sha, bytes, sha256 };
}

// One atomic final commit references staged file SHAs. A file too large for
// Vercel's request body is split into staged blobs, fetched in parallel and
// reassembled once (not committed as hundreds of temporary GitHub files).
async function prepareStagedAssets(settings, uploadId, workPath, singles = [], assemblies = []) {
  const committed = [];
  const receipts = [];
  const seen = new Set();
  for (const item of singles) {
    const verified = verifyStageReceipt(settings, item, uploadId, workPath);
    if (seen.has(verified.path)) throw unauthorized('Duplicate staged file path', 400);
    seen.add(verified.path);
    committed.push(verified);
    receipts.push({ path: verified.path, bytes: verified.bytes, sha256: verified.sha256 });
  }
  for (const assembly of assemblies) {
    const parts = Array.isArray(assembly?.parts) ? assembly.parts : [];
    if (parts.length < 2 || parts.length > 150) throw unauthorized('Invalid staged file parts', 400);
    const verified = parts.map(part => verifyStageReceipt(settings, part, uploadId, workPath));
    const filePath = verified[0].path;
    if (seen.has(filePath) || verified.some(item => item.path !== filePath)) {
      throw unauthorized('Invalid staged file assembly', 400);
    }
    seen.add(filePath);
    const contents = [];
    for (let i = 0; i < verified.length; i += 4) {
      const slice = verified.slice(i, i + 4);
      const fetched = await Promise.all(slice.map(item =>
        githubApi(settings, 'GET', '/repos/' + settings.owner + '/' + settings.repo + '/git/blobs/' + item.sha)));
      for (let k = 0; k < fetched.length; k++) {
        const raw = String(fetched[k]?.content || '').replace(/\s/g, '');
        if (fetched[k]?.encoding !== 'base64') throw new Error('Staged Git blob has wrong encoding');
        const bytes = Buffer.from(raw, 'base64');
        if (bytes.length !== slice[k].bytes ||
            createHash('sha256').update(bytes).digest('hex') !== slice[k].sha256) {
          throw new Error('Staged Git blob integrity check failed');
        }
        contents.push(bytes);
      }
    }
    const joined = Buffer.concat(contents);
    if (joined.length > 95_000_000) throw unauthorized('Staged file exceeds GitHub file size limit', 413);
    const blob = await githubApi(settings, 'POST',
      '/repos/' + settings.owner + '/' + settings.repo + '/git/blobs',
      { content: joined.toString('base64'), encoding: 'base64' });
    const sha = String(blob?.sha || '');
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Assembled Git blob SHA is missing');
    const sha256 = createHash('sha256').update(joined).digest('hex');
    committed.push({ path: filePath, sha, bytes: joined.length, sha256 });
    receipts.push({ path: filePath, bytes: joined.length, sha256 });
  }
  return { committed, receipts };
}

export default async function handler(request, response) {
  // Keep the public agent endpoint inside this existing Vercel function;
  // the Hobby deployment limit is 12 serverless functions.
  if (String(request.query?.__spine_link_agent_v1 || '') === '1' ||
      /^\/api\/agent-animation(?:[/?]|$)/.test(String(request.url || ''))) {
    return agentAnimationHandler(request, response);
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return response.status(500).json({ error: 'GITHUB_TOKEN is not configured' });

  // Declared out here on purpose: the catch block needs it for logging, and
  // anything declared inside the try is out of scope there, so reading it
  // would throw a ReferenceError from inside the catch and turn every real
  // error into an unhandled exception (which Vercel renders as a non-JSON 500,
  // losing the message entirely).
  let failedAction = 'unknown';

  try {
    const origin = `${request.headers['x-forwarded-proto'] || 'https'}://${request.headers['x-forwarded-host'] || request.headers.host}`;
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    const googlePayload = await optionalGooglePayload(request, body);
    const anonymousAccount = normalizeAnonymousAccount(body);

    const settings = {
      owner: process.env.GITHUB_OWNER || body?.settings?.owner || defaultOwner,
      repo: process.env.GITHUB_REPO || body?.settings?.repo || defaultRepo,
      branch: process.env.GITHUB_BRANCH || body?.settings?.branch || defaultBranch,
      token,
    };
    // An explicit setting still wins; otherwise uploads follow the newest folder.
    const routePathHint = cleanRepoPath(body?.uploadPath || body?.path || body?.entry?.previewPath || body?.collectionBasePath || '');
    const routeCollectionCandidate = routePathHint.split('/')[0] || '';
    const routeCollectionHint = /^library(_\d+)?$/i.test(routeCollectionCandidate) ? routeCollectionCandidate : '';
    settings.basePath = cleanRepoPath(process.env.GITHUB_BASE_PATH || body?.settings?.basePath || routeCollectionHint || (await newestLibraryBasePath(settings)));

    const files = Array.isArray(body?.files) ? body.files : [];
    const file = body?.file;
    const entry = body?.entry;
    const previewHtml = String(body?.previewHtml || '');
    const uploadPath = resolveUploadPath(body?.uploadPath, settings.basePath, String(body?.entry?.id || body?.uploadId || ''));
    const commitPrefix = String(body?.commitPrefix || 'Add Spine preview');
    const action = String(body?.action || '');
    failedAction = action || 'unknown';
    if (['update-note', 'update-layout', 'update-entry-visibility'].includes(action) && body?.entryId) {
      const collections = await libraryCollectionIndexes(settings);
      const collection = collections.find(item => item.entries.some(entry => String(entry?.id) === String(body.entryId)));
      if (collection) settings.basePath = collection.basePath;
    }


    // Fast path: one Vercel request per file (or large-file part), with no
    // GitHub branch write or intermediate commit. Four files may stage in parallel.
    if (action === 'stage-blob') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryId = String(body?.entryId || body?.uploadId || '').trim();
      const workPath = resolveUploadPath(body?.uploadPath, settings.basePath, entryId);
      const filePath = resolveUploadPath(body?.path, settings.basePath, entryId);
      const contentBase64 = String(body?.contentBase64 || '').trim().replace(/^data:[^;]+;base64,/i, '');
      if (!entryId || !workPath || !filePath || !filePath.startsWith(workPath + '/') ||
          !contentBase64 || contentBase64.length > STAGE_BASE64_LIMIT ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
        return response.status(400).json({ error: 'Invalid staged asset' });
      }
      const bytes = Buffer.from(contentBase64, 'base64').length;
      const sha256 = sha256HexFromBase64(contentBase64);
      const blob = await githubApi(settings, 'POST',
        `/repos/${settings.owner}/${settings.repo}/git/blobs`,
        { content: contentBase64, encoding: 'base64' });
      const blobSha = String(blob?.sha || '');
      if (!/^[a-f0-9]{40}$/i.test(blobSha)) throw new Error('GitHub did not return a valid blob SHA');
      return response.status(200).json({
        ok: true, path: filePath, uploadPath: workPath, blobSha, bytes, sha256,
        signature: stageReceiptSignature(settings.token, entryId, filePath, blobSha, bytes, sha256),
      });
    }

    if (action === 'background-upload') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const uploadId = String(body?.uploadId || '').trim();
      const uploadPathBg = resolveUploadPath(body?.uploadPath, settings.basePath, uploadId);
      const uploadedAt = String(body?.uploadedAt || '').trim();
      const fileName = String(body?.fileName || '').trim();
      const fileBase64 = String(body?.fileBase64 || '').trim();
      if (!uploadId || !uploadPathBg || !fileName || !fileBase64) {
        return response.status(400).json({ error: 'Missing background upload field' });
      }
      const filePath = joinRepoPath(uploadPathBg, fileName.replace(/^\.+\//, ''));
      const message = `${commitPrefix}: ${fileName} (single)`;
      const contentBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '');
      const existingFile = await getGitHubContent(settings, filePath);
      const writeResult = await putGitHubContent(settings, filePath, contentBase64, message, existingFile?.sha, origin);
      return response.status(200).json({
        ok: true,
        path: filePath,
        bytes: Buffer.from(contentBase64.replace(/\s/g, ''), 'base64').byteLength,
        sha256: sha256HexFromBase64(contentBase64),
        github: publicGitHubWrite(writeResult),
      });
    }

    if (action === 'background-upload-chunk') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const uploadId = String(body?.uploadId || '').trim();
      const uploadPathBg = resolveUploadPath(body?.uploadPath, settings.basePath, uploadId);
      const fileName = String(body?.fileName || '').trim();
      const chunkIndex = Number(body?.chunkIndex);
      const chunkCount = Number(body?.chunkCount);
      // Accept both the canonical Base64 payload and legacy data-URLs from
      // already-open clients. GitHub Contents API expects valid Base64 only;
      // passing the `data:image/...;base64,` prefix causes a 422 response.
      const chunkBase64 = String(body?.chunkBase64 || '').trim().replace(/^data:[^;]+;base64,/i, '');
      const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
      if (!uploadId || !uploadPathBg || !fileName || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkIndex < 0 || chunkIndex >= chunkCount) {
        return response.status(400).json({ error: 'Missing or invalid chunk field' });
      }
      if (!chunkBase64 || !validBase64.test(chunkBase64)) {
        return response.status(400).json({ error: `Invalid Base64 payload for chunk ${chunkIndex}` });
      }
      const chunkDir = `${uploadPathBg}/${fileName}.__chunks`;
      const chunkPath = `${chunkDir}/${String(chunkIndex).padStart(5, '0')}`;
      const message = `${commitPrefix}: chunk ${chunkIndex} of ${fileName}`;
      // Write the chunk before looking up its sha. A fresh chunk path does not
      // exist yet, so GitHub creates it in one round trip; the extra GET first
      // doubled the calls per chunk and, on a 21-chunk file, was the difference
      // between ~1.8s and ~3.6s per chunk. GitHub rejects a blind write with 422
      // when the blob is already there, and only then do we pay for the lookup
      // and replay with the sha, so replays stay safe and idempotent.
      let writeResult;
      try {
        writeResult = await putGitHubContent(settings, chunkPath, chunkBase64, message, '', origin);
      } catch (err) {
        if (Number(err?.status) !== 422) throw err;
        // The blob already exists, so GitHub wants the current sha. If the blob
        // is being written by something else at the same moment our sha is
        // stale and the replay 422s too, so re-read and retry: a chunk that has
        // already been stored correctly must not fail the whole upload.
        let lastChunkError = err;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const existingChunk = await getGitHubContent(settings, chunkPath);
          try {
            writeResult = await putGitHubContent(settings, chunkPath, chunkBase64, message, existingChunk?.sha || '', origin);
            lastChunkError = null;
            break;
          } catch (retryErr) {
            lastChunkError = retryErr;
            if (Number(retryErr?.status) !== 422) throw retryErr;
            await new Promise((r) => setTimeout(r, githubRetryDelay(attempt)));
          }
        }
        if (lastChunkError) throw lastChunkError;
      }
      return response.status(200).json({ ok: true, chunkPath, chunkIndex, sha256: sha256HexFromBase64(chunkBase64), github: publicGitHubWrite(writeResult) });
    }

    if (action === 'background-upload-reassemble') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const uploadId = String(body?.uploadId || '').trim();
      const uploadPathBg = resolveUploadPath(body?.uploadPath, settings.basePath, uploadId);
      const fileName = String(body?.fileName || '').trim();
      const chunkCount = Number(body?.chunkCount);
      if (!uploadId || !uploadPathBg || !fileName || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 1000) {
        return response.status(400).json({ error: 'Missing or invalid reassemble field' });
      }

      const chunkDir = `${uploadPathBg}/${fileName}.__chunks`;
      const chunkPaths = Array.from({ length: chunkCount }, (_, index) =>
        `${chunkDir}/${String(index).padStart(5, '0')}`,
      );
      // Fetch staged chunks concurrently, then publish the reconstructed file
      // and remove all temporary chunks in one Git Data API commit. The former
      // Contents-API loop made several sequential GitHub round trips per chunk.
      const parts = await Promise.all(chunkPaths.map((path) => getGitHubContent(settings, path)));
      let fullBase64 = '';
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (!part || part.encoding !== 'base64') {
          throw new Error(`Chunk ${index} not found at ${chunkPaths[index]}`);
        }
        fullBase64 += String(part.content).replace(/\s/g, '');
      }

      const filePath = joinRepoPath(uploadPathBg, fileName.replace(/^\.+\//, ''));
      const commit = await commitGitHubChanges(settings, {
        writes: [{ path: filePath, contentBase64: fullBase64 }],
        deletions: chunkPaths,
        message: `${commitPrefix}: reassembled ${fileName}`,
        origin,
      });
      return response.status(200).json({
        ok: true,
        path: filePath,
        bytes: Buffer.from(fullBase64, 'base64').byteLength,
        github: { commitSha: String(commit?.sha || ''), commitUrl: String(commit?.html_url || '') },
      });
    }

    // Home-page uploads stage in parallel and become visible together.
    // Unlike the legacy flow, no per-file commits or 60 KB chunk commits.
    if (action === 'background-finalize-fast') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const uploadId = String(body?.uploadId || '').trim();
      const workPath = resolveUploadPath(body?.uploadPath, settings.basePath, uploadId);
      const uploadedAt = String(body?.uploadedAt || '').trim();
      if (!uploadId || !workPath) return response.status(400).json({ error: 'Missing uploadId or work path' });
      const prepared = await prepareStagedAssets(settings, uploadId, workPath,
        Array.isArray(body?.stagedBlobs) ? body.stagedBlobs : [],
        Array.isArray(body?.stagedAssemblies) ? body.stagedAssemblies : []);
      if (!prepared.committed.length) return response.status(400).json({ error: 'No staged Spine files' });
      // Validate server-side as well as in the browser: remote clients and
      // agents can stage arbitrary blobs without running the drag/drop checks.
      // A binary payload named .atlas otherwise becomes control-character
      // texture URLs in the public Web Player.
      if (body?.entry?.sourceKind !== 'spine-project') {
        for (const asset of prepared.committed) {
          if (!/\.atlas(?:\.txt|\.docx)?$/i.test(asset.path)) continue;
          if (asset.bytes < 24 || asset.bytes > 2_000_000) {
            return response.status(422).json({ error: 'Invalid Spine atlas size or format' });
          }
          const blob = await githubApi(settings, 'GET',
            '/repos/' + settings.owner + '/' + settings.repo + '/git/blobs/' + asset.sha);
          if (blob?.encoding !== 'base64' || !blob.content) {
            return response.status(422).json({ error: 'Staged Spine atlas could not be validated' });
          }
          const bytes = Buffer.from(String(blob.content).replace(/\s/g, ''), 'base64');
          if (bytes.byteLength !== asset.bytes ||
              createHash('sha256').update(bytes).digest('hex') !== asset.sha256 ||
              !isValidSpineAtlasHeader(bytes.toString('utf8'))) {
            return response.status(422).json({
              error: 'Invalid Spine atlas: expected text page declarations and image filenames',
              acceptance: 'rejected-corrupt-atlas',
            });
          }
        }
      }
      const relativeFiles = prepared.receipts.map(item =>
        item.path.startsWith(workPath + '/') ? item.path.slice(workPath.length + 1) : '');
      const isEditorProject = body?.entry?.sourceKind === 'spine-project';
      // Source import is NOT a playable project without all three required
      // asset classes. Never create a public entry for an isolated .skel.
      const assetAcceptance = isEditorProject ? null : inspectRuntimeAssetSet(relativeFiles);
      if (assetAcceptance && !assetAcceptance.accepted) {
        return response.status(422).json({
          error: 'Spine file acceptance failed: ' + assetAcceptance.missing.join(', '),
          acceptance: 'rejected-incomplete-runtime-bundle',
          required: ['skeleton', 'atlas', 'texture'],
        });
      }
      // Do not report an export as queued unless the public licensed Spine
      // Editor workflow is enabled. The public storage repository processes
      // the repository_dispatch event; failures are returned to the uploader.
      // Allow an explicit emergency kill switch; do not rely on a disabled-by-default flag.
      const editorExportEnabled = process.env.SPINE_PROJECT_EXPORT_ENABLED !== 'false';
      const projectFile = String(body?.entry?.projectFile || '');
      if (isEditorProject && (!/^[^/\\]+\.spine$/i.test(projectFile) ||
          !relativeFiles.includes(projectFile) ||
          !relativeFiles.some(path => /^images\/.+\.(png|jpe?g|webp|dds)$/i.test(path)) ||
          relativeFiles.some(path => !path || path.split('/').some(part => !part || part === '.' || part === '..')))) {
        return response.status(400).json({ error: 'Spine Editor import requires a .spine project and images/ textures' });
      }
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      let nextEntry = null;
      let commit;
      for (let attempt = 0; attempt < 3; attempt++) {
        const index = await getGitHubContent(settings, indexPath);
        const currentEntries = index?.content && index.encoding === 'base64'
          ? JSON.parse(base64ToText(index.content)) : [];
        const existing = currentEntries.find(item => item.id === uploadId);
        if (existing && !canEditEntry(existing, googlePayload, anonymousAccount)) throw unauthorized('Only the owner can replace this entry', 403);
        nextEntry = applyOwnerMetadata({
          ...body?.entry,
          files: relativeFiles,
          id: uploadId, uploadedAt, previewPath: workPath,
          ...(isEditorProject ? {
            sourceKind: 'spine-project', projectFile,
            imagesRoot: 'images',
            conversionStatus: editorExportEnabled ? 'pending' : 'needs-editor',
            webmStatus: 'waiting-for-editor',
            skeleton: '', atlas: '', animations: [],
          } : {}),
        }, googlePayload, anonymousAccount, existing, existing?.publicOwnerId);
        nextEntry.webmStatus = isEditorProject ? 'waiting-for-editor' :
          existing?.webmStatus === 'ready' ? 'ready' : 'pending';
        nextEntry.dispatchStatus = isEditorProject
          ? editorExportEnabled ? 'project-export-pending' : 'editor-unavailable'
          : 'pending';
        const nextEntries = [nextEntry, ...currentEntries.filter(item => item.id !== uploadId)];
        try {
          commit = await commitGitHubChanges(settings, {
            writes: [{ path: indexPath, contentBase64: textToBase64(JSON.stringify(nextEntries, null, 2)) }],
            stagedBlobs: prepared.committed,
            message: commitPrefix + ': four-file parallel upload',
            origin,
          });
          break;
        } catch (error) {
          if (attempt === 2 || ![409, 422].includes(Number(error?.status))) throw error;
        }
      }
      // Serverless invocations do not guarantee fire-and-forget network calls
      // survive the response. Await the GitHub dispatch and expose its actual
      // outcome rather than falsely telling the user preview generation began.
      const dispatch = isEditorProject
        ? editorExportEnabled
          ? await dispatchSpineProjectExport(settings, nextEntry, origin)
          : { status: 'unavailable', error: 'Spine Editor export disabled' }
        : await dispatchSpineExportWebm(settings, nextEntry, origin);
      if (dispatch?.status === 'failed') {
        console.error('[UPLOAD] Preview dispatch failed for committed upload', uploadId,
          String(dispatch.error || '').slice(0, 300));
      }
      return response.status(200).json({
        ok: true, path: workPath, indexed: true,
        dispatch,
        requiresSpineExport: isEditorProject,
        files: prepared.receipts.map((item, i) => ({ ...item, name: relativeFiles[i] })),
        github: { commitSha: String(commit?.commit?.sha || commit?.sha || '') },
      });
    }

    if (action === 'background-finalize-index') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const uploadId = String(body?.uploadId || '').trim();
      const uploadPathBg = resolveUploadPath(body?.uploadPath, settings.basePath, uploadId);
      const uploadedAt = String(body?.uploadedAt || '').trim();
      if (!uploadId) return response.status(400).json({ error: 'Missing uploadId' });
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentIndex = await getGitHubContent(settings, indexPath);
        const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
        const existingEntry = currentEntries.find((c) => c.id === uploadId);
        if (existingEntry && !canEditEntry(existingEntry, googlePayload, anonymousAccount)) throw unauthorized('Only the owner can replace this entry', 403);
        const nextEntry = applyOwnerMetadata({
          ...body?.entry,
          id: uploadId,
          uploadedAt,
          previewPath: uploadPathBg,
          sourceProof: body?.entry?.sourceProof,
        }, googlePayload, anonymousAccount, existingEntry, existingEntry?.publicOwnerId);
        nextEntry.webmStatus = existingEntry?.webmStatus === 'ready' ? 'ready' : 'pending';
        nextEntry.dispatchStatus = 'pending';
        const nextEntries = [nextEntry, ...currentEntries.filter((currentEntry) => currentEntry.id !== uploadId)];
        try {
          await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: update library index`, currentIndex?.sha, origin);
        } catch (error) {
          if (attempt < 2 && [409, 422].includes(Number(error?.status))) continue;
          throw error;
        }
        const dispatch = await dispatchSpineExportWebm(settings, nextEntry, origin);
        return response.status(200).json({ ok: true, indexed: nextEntries.length, dispatch });
      }
    }

    if (action === 'get-metrics') {
      const ids = sanitizeMetricIds(body?.ids);
      const hash = metricsVisitorHash(request, body);
      const merged = await readMetricsAcrossCollections(settings, ids);
      response.setHeader('Cache-Control', 'no-store');
      return response.status(200).json({ ok: true, metrics: metricCountsForIds(merged, ids, hash) });
    }

    if (action === 'track-metric') {
      const metricAction = String(body?.metricAction || '').trim();
      const entryId = sanitizeMetricId(body?.entryId);
      if (!entryId) return response.status(400).json({ error: 'Invalid metrics entry id' });
      const hash = metricsVisitorHash(request, body);
      // Counters are written into the collection that actually holds the work,
      // so tracking a rotated work never creates a new empty collection.
      const metricsPath = await metricsPathForEntry(settings, entryId);
      response.setHeader('Cache-Control', 'no-store');

      if (metricAction === 'view') {
        const now = Date.now();
        const day = new Date(now).toISOString().slice(0, 10);
        const viewKey = `${hash}:${day}`;
        const { metrics, deferred } = await mutateMetrics(settings, metricsPath, `Track Spine preview view ${entryId}`, (draft) => {
          const metricEntry = normalizeEntryMetric(draft, entryId);
          if (!metricEntry) return false;
          pruneRecentViews(metricEntry, now);
          if (metricEntry.recentViews[viewKey]) return false;
          metricEntry.recentViews[viewKey] = new Date(now).toISOString();
          metricEntry.views += 1;
          return true;
        }, origin);
        return response.status(200).json({ ok: true, entryId, metric: metricCountsForIds(metrics, [entryId], hash)[entryId], ...(deferred ? { deferred: true } : {}) });
      }

      if (metricAction === 'like') {
        const liked = Boolean(body?.liked);
        const { metrics, deferred } = await mutateMetrics(settings, metricsPath, `${liked ? 'Like' : 'Unlike'} Spine preview ${entryId}`, (draft) => {
          const metricEntry = normalizeEntryMetric(draft, entryId);
          if (!metricEntry) return false;
          const currentlyLiked = Boolean(metricEntry.likedBy[hash]);
          if (liked && !currentlyLiked) {
            metricEntry.likedBy[hash] = new Date().toISOString();
            metricEntry.likes += 1;
            return true;
          }
          if (!liked && currentlyLiked) {
            delete metricEntry.likedBy[hash];
            metricEntry.likes = Math.max(0, metricEntry.likes - 1);
            return true;
          }
          return false;
        }, origin);
        return response.status(200).json({ ok: true, entryId, metric: metricCountsForIds(metrics, [entryId], hash)[entryId], ...(deferred ? { deferred: true } : {}) });
      }

      return response.status(400).json({ error: 'Invalid metrics action' });
    }

    if (action === 'update-archive-exclusions') {
      if (!googlePayload?.email) throw unauthorized('Sign in with Google before editing archive rules');
      if (!isArchiveAdmin(googlePayload)) throw unauthorized('Only archive administrators can edit these rules', 403);
      const rulesPath = joinRepoPath(settings.basePath, 'archive-exclusions.json');
      const currentRules = await getGitHubContent(settings, rulesPath);
      const nextRules = {
        updatedAt: new Date().toISOString(),
        updatedBy: String(googlePayload.email || ''),
        rules: normalizeArchiveExclusionRules(body?.rules),
      };
      await putGitHubContent(
        settings,
        rulesPath,
        textToBase64(JSON.stringify(nextRules, null, 2)),
        `${commitPrefix}: update archive exclusions`,
        currentRules?.sha,
        origin,
      );
      return response.status(200).json({ ok: true, rules: nextRules.rules, updatedAt: nextRules.updatedAt });
    }

    if (action === 'delete-archive-entries') {
      if (!googlePayload?.email) throw unauthorized('Sign in with Google before deleting archive entries');
      if (!isArchiveAdmin(googlePayload)) throw unauthorized('Only archive administrators can delete archive entries', 403);
      const entryIds = normalizeArchiveEntryIds(body?.entryIds);
      if (!entryIds.length) return response.status(400).json({ error: 'Select at least one archive entry' });
      const entryIdSet = new Set(entryIds);
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      const currentIndex = await getGitHubContent(settings, indexPath);
      const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
      const deletedEntries = [];
      const nextEntries = currentEntries.filter((currentEntry) => {
        const id = String(currentEntry?.id || '');
        if (!entryIdSet.has(id)) return true;
        deletedEntries.push(id);
        return false;
      });
      if (!deletedEntries.length) return response.status(404).json({ error: 'Selected archive entries were not found' });
      await putGitHubContent(
        settings,
        indexPath,
        textToBase64(JSON.stringify(nextEntries, null, 2)),
        `${commitPrefix}: delete archive entries`,
        currentIndex?.sha,
        origin,
      );
      return response.status(200).json({ ok: true, deleted: deletedEntries, indexed: nextEntries.length });
    }

    if (action === 'anchor-source-proof') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const sourceProof = body?.sourceProof && typeof body.sourceProof === 'object' ? body.sourceProof : null;
      if (!sourceProof) return response.status(400).json({ error: 'Invalid source proof payload' });
      const anchorPath = cleanRepoPath(body?.anchorPath || joinRepoPath(body?.uploadPath || sourceProof?.github?.previewPath || '', 'blockchain-anchor.json'));
      if (!anchorPath) return response.status(400).json({ error: 'Invalid blockchain anchor path' });

      const anchor = await createBlockchainAnchor({
        sourceProof,
        uploadedFiles: body?.uploadedFiles,
        body,
        settings,
        googlePayload,
        anonymousAccount,
        origin,
      });
      const currentAnchor = await getGitHubContent(settings, anchorPath);
      const writeResult = await putGitHubContent(
        settings,
        anchorPath,
        textToBase64(JSON.stringify(anchor, null, 2)),
        `${commitPrefix}: blockchain source proof anchor`,
        currentAnchor?.sha,
        origin,
      );
      return response.status(200).json({
        ok: true,
        anchor: {
          ...anchor,
          anchorPath,
          anchorUrl: assetUrlForRepoPath(origin, anchorPath),
          github: {
            ...anchor.github,
            anchorPath,
            anchorUrl: assetUrlForRepoPath(origin, anchorPath),
            anchorCommitSha: String(writeResult?.commit?.sha || ''),
            anchorCommitUrl: String(writeResult?.commit?.html_url || ''),
          },
        },
      });
    }

    if (action === 'put-file') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const path = cleanRepoPath(file?.path || body?.path || '');
      const contentBase64 = String(file?.contentBase64 || body?.contentBase64 || '');
      const message = String(body?.message || `${commitPrefix}: ${path.split('/').pop() || 'file'}`);
      if (!path || !contentBase64) return response.status(400).json({ error: 'Invalid file payload' });
      const existingFile = await getGitHubContent(settings, path);
      const writeResult = await putGitHubContent(settings, path, contentBase64, message, existingFile?.sha, origin);
      return response.status(200).json({
        ok: true,
        path,
        bytes: Buffer.from(contentBase64.replace(/\s/g, ''), 'base64').byteLength,
        sha256: sha256HexFromBase64(contentBase64),
        github: publicGitHubWrite(writeResult),
      });
    }

    if (action === 'multipart-upload-chunk') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const filePath = cleanRepoPath(body?.path || '');
      const chunkIndex = Number(body?.chunkIndex);
      const contentBase64 = String(body?.contentBase64 || '');
      const message = `${commitPrefix}: chunk ${chunkIndex} of ${filePath.split('/').pop() || 'file'}`;
      if (!filePath || !contentBase64 || !Number.isFinite(chunkIndex)) {
        return response.status(400).json({ error: 'Invalid chunk payload' });
      }
      // Accept either the base file path or an already-suffixed chunk path.
      const chunkPath = /(^|\/)[^/]+\.__chunks\/\d{5}$/.test(filePath)
        ? filePath
        : `${filePath}.__chunks/${String(chunkIndex).padStart(5, '0')}`;
      const existingChunk = await getGitHubContent(settings, chunkPath);
      const writeResult = await putGitHubContent(settings, chunkPath, contentBase64, message, existingChunk?.sha, origin);
      return response.status(200).json({
        ok: true,
        chunkIndex,
        chunkPath,
        bytes: Buffer.from(contentBase64.replace(/\s/g, ''), 'base64').byteLength,
        github: publicGitHubWrite(writeResult),
      });
    }

    if (action === 'reassemble-file') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const filePath = cleanRepoPath(body?.path || '');
      const chunkCount = Number(body?.chunkCount);
      if (!filePath || !Number.isFinite(chunkCount) || chunkCount < 1) {
        return response.status(400).json({ error: 'Invalid reassembly payload' });
      }
      let fullBase64 = '';
      const chunkShas = [];
      for (let i = 0; i < chunkCount; i++) {
        const chunkPath = `${filePath}.__chunks/${String(i).padStart(5, '0')}`;
        const chunk = await getGitHubContent(settings, chunkPath);
        if (!chunk || chunk.encoding !== 'base64') {
          return response.status(404).json({ error: `Chunk ${i} not found at ${chunkPath}` });
        }
        fullBase64 += String(chunk.content).replace(/\s/g, '');
        chunkShas.push(chunk.sha);
      }
      const existingFile = await getGitHubContent(settings, filePath);
      const writeResult = await putGitHubContent(settings, filePath, fullBase64, `${commitPrefix}: reassembled ${filePath}`, existingFile?.sha, origin);
      for (let i = 0; i < chunkCount; i++) {
        const chunkPath = `${filePath}.__chunks/${String(i).padStart(5, '0')}`;
        try {
          await deleteGitHubContent(settings, chunkPath, `${commitPrefix}: cleanup chunk ${i} of ${filePath}`, chunkShas[i]);
        } catch { /* ignore cleanup failures */ }
      }
      return response.status(200).json({
        ok: true,
        path: filePath,
        bytes: Buffer.from(fullBase64, 'base64').length,
        sha256: sha256HexFromBase64(fullBase64),
        github: publicGitHubWrite(writeResult),
      });
    }

    if (action === 'update-index') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      if (!entry) return response.status(400).json({ error: 'Invalid index payload' });
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      const currentIndex = await getGitHubContent(settings, indexPath);
      const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
      const existingEntry = currentEntries.find((c) => c.id === entry.id);
      if (existingEntry && !canEditEntry(existingEntry, googlePayload, anonymousAccount)) throw unauthorized('Only the owner can update this library entry', 403);
      const nextEntry = applyOwnerMetadata({
        ...entry,
        ...(entry?.ownerName || googlePayload?.name ? { ownerName: cleanPublicProfileText(entry?.ownerName || googlePayload?.name) } : {}),
        ...(entry?.ownerPicture || googlePayload?.picture ? { ownerPicture: cleanPublicProfileImage(entry?.ownerPicture || googlePayload?.picture) } : {}),
        showOwnerLibrary: Boolean(entry?.showOwnerLibrary),
        portfolioMode: Boolean(entry?.portfolioMode),
        ...(existingEntry?.webmStatus === 'ready' ? { webmStatus: 'ready' } : { webmStatus: 'pending' }),
      }, googlePayload, anonymousAccount, existingEntry, existingEntry?.publicOwnerId);
      const nextEntries = [nextEntry, ...currentEntries.filter((currentEntry) => currentEntry.id !== nextEntry.id)];
      await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: update library index`, currentIndex?.sha, origin);
      const dataScience = await updateDataScienceCatalog(settings, body, nextEntry, commitPrefix, origin);
      const isNewUpload = !existingEntry || existingEntry.webmStatus !== 'ready';
      const dispatch = isNewUpload ? await dispatchSpineExportWebm(settings, nextEntry, origin) : null;
      return response.status(200).json({ ok: true, indexed: nextEntries.length, dataScience, dispatch });
    }


    // One request for a whole publish: files, staged chunks, the source-proof
    // anchor, index.json and the data-science catalog all land in one commit.
    // The client used to make 7-40 sequential calls for the same result, which
    // is why saving a page took tens of seconds.
    if (action === 'publish-entry') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryPayload = entry && typeof entry === 'object' ? entry : null;
      const batchFiles = Array.isArray(body?.files) ? body.files : [];
      const stageChunks = Array.isArray(body?.stageChunks) ? body.stageChunks : [];
      const assembles = Array.isArray(body?.assembles) ? body.assembles : [];
      const stagedBlobs = Array.isArray(body?.stagedBlobs) ? body.stagedBlobs : [];
      const stagedAssemblies = Array.isArray(body?.stagedAssemblies) ? body.stagedAssemblies : [];
      const finalize = Boolean(entryPayload);
      if (!batchFiles.length && !stageChunks.length && !assembles.length &&
          !stagedBlobs.length && !stagedAssemblies.length && !finalize) {
        return response.status(400).json({ error: 'Invalid publish payload' });
      }

      const writes = [];
      const deletions = [];
      const assetPaths = [];

      for (const chunk of stageChunks) {
        const filePath = cleanRepoPath(String(chunk?.path || ''));
        const chunkIndex = Number(chunk?.index);
        const contentBase64 = String(chunk?.contentBase64 || '');
        if (!filePath || !contentBase64 || !Number.isInteger(chunkIndex) || chunkIndex < 0) continue;
        writes.push({ path: `${filePath}.__chunks/${String(chunkIndex).padStart(5, '0')}`, contentBase64 });
      }

      for (const assemble of assembles) {
        const filePath = cleanRepoPath(String(assemble?.path || ''));
        const chunkCount = Number(assemble?.chunkCount);
        if (!filePath || !Number.isInteger(chunkCount) || chunkCount < 1) continue;
        const chunkDir = `${filePath}.__chunks`;
        const parts = await Promise.all(
          Array.from({ length: chunkCount }, (_, index) => getGitHubContent(settings, `${chunkDir}/${String(index).padStart(5, '0')}`)),
        );
        let assembled = '';
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index];
          if (!part || part.encoding !== 'base64') {
            return response.status(400).json({ error: `Chunk ${index} of ${filePath} was not uploaded` });
          }
          assembled += String(part.content).replace(/\s/g, '');
        }
        writes.push({ path: filePath, contentBase64: assembled });
        assetPaths.push(filePath);
        for (let index = 0; index < chunkCount; index += 1) deletions.push(`${chunkDir}/${String(index).padStart(5, '0')}`);
      }

      for (const file of batchFiles) {
        const filePath = cleanRepoPath(String(file?.path || ''));
        const contentBase64 = String(file?.contentBase64 || '');
        if (!filePath || !contentBase64) continue;
        writes.push({ path: filePath, contentBase64 });
        assetPaths.push(filePath);
      }

      const preparedStages = await prepareStagedAssets(settings,
        String(body?.entryId || entryPayload?.id || ''), uploadPath, stagedBlobs, stagedAssemblies);
      assetPaths.push(...preparedStages.receipts.map(item => item.path));

      let nextEntry = null;
      let anchor = null;
      let indexed = 0;
      let dataScience = null;
      let existingEntry = null;
      let dispatch = null;

      if (finalize) {
        const sourceProof = body?.sourceProof && typeof body.sourceProof === 'object' ? body.sourceProof : null;
        const indexPath = joinRepoPath(settings.basePath, 'index.json');
        const currentIndex = await getGitHubContent(settings, indexPath);
        const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
        existingEntry = currentEntries.find((currentItem) => currentItem.id === entryPayload.id);
        if (existingEntry && !canEditEntry(existingEntry, googlePayload, anonymousAccount)) throw unauthorized('Only the owner can publish changes to this entry', 403);
        nextEntry = applyOwnerMetadata({
          ...entryPayload,
          ...(entryPayload?.ownerName || googlePayload?.name
            ? { ownerName: cleanPublicProfileText(entryPayload?.ownerName || googlePayload?.name) }
            : {}),
          ...(entryPayload?.ownerPicture || googlePayload?.picture
            ? { ownerPicture: cleanPublicProfileImage(entryPayload?.ownerPicture || googlePayload?.picture) }
            : {}),
          showOwnerLibrary: Boolean(entryPayload?.showOwnerLibrary),
          portfolioMode: Boolean(entryPayload?.portfolioMode),
          ...(existingEntry?.webmStatus === 'ready' ? { webmStatus: 'ready' } : { webmStatus: 'pending' }),
        }, googlePayload, anonymousAccount, existingEntry, existingEntry?.publicOwnerId);

        // The anchor is optional. Building it here keeps it in the same commit
        // as index.json instead of paying for a second request and a second
        // round trip to GitHub on the critical path.
        const anchorPath = cleanRepoPath(
          String(body?.anchorPath || joinRepoPath(String(entryPayload?.previewPath || ''), 'blockchain-anchor.json')),
        );
        if (sourceProof && anchorPath) {
          try {
            // The commit sha does not exist yet (the anchor is part of this
            // commit), so receipts are derived from the bytes being written.
            // The client no longer makes a request per file and therefore has
            // no per-file commit shas to hand over either.
            const anchorUploads =
              Array.isArray(body?.uploadedFiles) && body.uploadedFiles.length
                ? body.uploadedFiles
                : [
                    ...preparedStages.receipts.map(item => ({ name: item.path.split('/').pop() || '', ...item })),
                    ...writes
                      .filter((write) => assetPaths.includes(write.path))
                      .map((write) => ({
                        name: String(write.path).split('/').pop() || '',
                        path: write.path,
                        bytes: Buffer.from(String(write.contentBase64).replace(/\s/g, ''), 'base64').byteLength,
                        sha256: sha256HexFromBase64(write.contentBase64),
                      })),
                  ];
            const created = await createBlockchainAnchor({ sourceProof, uploadedFiles: anchorUploads, body, settings, googlePayload, anonymousAccount, origin });
            anchor = { ...created, anchorPath, anchorUrl: assetUrlForRepoPath(origin, anchorPath) };
            anchor.github = { ...(anchor.github || {}), anchorPath, anchorUrl: anchor.anchorUrl };
            nextEntry.blockchainAnchor = anchor;
            const anchorFileName = String(anchorPath).split('/').pop() || '';
            const entryFiles = Array.isArray(nextEntry.files) ? nextEntry.files.map(String) : [];
            if (anchorFileName && !entryFiles.includes(anchorFileName)) nextEntry.files = [...entryFiles, anchorFileName];
            writes.push({ path: anchorPath, contentBase64: textToBase64(JSON.stringify(anchor, null, 2)) });
          } catch (error) {
            // A failed anchor never blocked a publish before, and it must not
            // start doing so now that it shares the commit with the index.
            console.error('[UPLOAD] anchor skipped:', error instanceof Error ? error.message : String(error));
          }
        }

        const nextEntries = [nextEntry, ...currentEntries.filter((currentItem) => currentItem.id !== nextEntry.id)];
        writes.push({ path: indexPath, contentBase64: textToBase64(JSON.stringify(nextEntries, null, 2)) });
        indexed = nextEntries.length;

        const preparedCatalog = await prepareDataScienceCatalog(settings, body, nextEntry);
        if (preparedCatalog) {
          writes.push(...preparedCatalog.writes);
          dataScience = preparedCatalog.summary;
        }
      }

      if (!writes.length && !preparedStages.committed.length) {
        return response.status(400).json({ error: 'Nothing to publish' });
      }

      const commit = await commitGitHubChanges(settings, {
        writes,
        stagedBlobs: preparedStages.committed,
        deletions,
        message: String(body?.commitPrefix || 'Add Spine preview'),
        origin,
      });
      const receipts = [
        ...preparedStages.receipts.map(item => ({
          path: item.path, name: item.path.split('/').pop() || '',
          bytes: item.bytes, sha256: item.sha256,
          github: { contentSha: '', commitSha: String(commit?.commit?.sha || commit?.sha || ''), commitUrl: String(commit?.commit?.html_url || ''), downloadUrl: '' },
        })),
        ...publicBatchReceipts(commit,
          writes.filter((write) => assetPaths.includes(write.path))),
      ];

      if (finalize && nextEntry) {
        const isNewUpload = !existingEntry || existingEntry.webmStatus !== 'ready';
        dispatch = isNewUpload ? await dispatchSpineExportWebm(settings, nextEntry, origin) : null;
      }

      return response.status(200).json({
        ok: true,
        indexed,
        entry: nextEntry,
        anchor,
        dataScience,
        dispatch,
        receipts,
        github: { commitSha: String(commit?.sha || ''), commitUrl: String(commit?.html_url || '') },
      });
    }

    if (action === 'update-note') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryId = String(body?.entryId || '').trim();
      if (!entryId) return response.status(400).json({ error: 'Invalid note payload' });
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      const currentIndex = await getGitHubContent(settings, indexPath);
      const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
      const entryIndex = currentEntries.findIndex((currentEntry) => String(currentEntry?.id || '') === entryId);
      if (entryIndex < 0) return response.status(404).json({ error: 'Library entry not found' });
      if (!canEditEntry(currentEntries[entryIndex], googlePayload, anonymousAccount)) throw unauthorized('Only the owner can edit this text', 403);
      const note = normalizeNote(body?.note || '');
      const nextEntry = { ...currentEntries[entryIndex] };
      if (note) nextEntry.note = note;
      else delete nextEntry.note;
      const nextEntries = [...currentEntries];
      nextEntries[entryIndex] = nextEntry;
      await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: update preview text`, currentIndex?.sha, origin);
      return response.status(200).json({ ok: true, entry: { ...publicLibraryEntry(origin, nextEntry), canEdit: canEditEntry(nextEntry, googlePayload, anonymousAccount) } });
    }

    if (action === 'update-layout') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryId = String(body?.entryId || '').trim();
      const layout = body?.layout;
      if (!entryId) return response.status(400).json({ error: 'Invalid layout payload' });
      if (!layout || typeof layout !== 'object') return response.status(400).json({ error: 'Missing layout' });
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      const currentIndex = await getGitHubContent(settings, indexPath);
      const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
      const entryIndex = currentEntries.findIndex((currentEntry) => String(currentEntry?.id || '') === entryId);
      if (entryIndex < 0) return response.status(404).json({ error: 'Library entry not found' });
      if (!canEditEntry(currentEntries[entryIndex], googlePayload, anonymousAccount)) throw unauthorized('Only the owner can edit this layout', 403);
      const nextEntry = { ...currentEntries[entryIndex] };
      const numbers = ['x', 'y', 'width', 'height', 'padLeft', 'padRight', 'padTop', 'padBottom'];
      const layoutOut = {};
      for (const key of numbers) {
        const value = Number(layout[key]);
        if (Number.isFinite(value)) layoutOut[key] = value;
      }
      if (Object.keys(layoutOut).length) nextEntry.layout = layoutOut;
      else delete nextEntry.layout;
      const nextEntries = [...currentEntries];
      nextEntries[entryIndex] = nextEntry;
      await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: update preview layout`, currentIndex?.sha, origin);
      dispatchSpineExportWebm(settings, nextEntry, origin).catch(() => {});
      return response.status(200).json({ ok: true, entry: { ...publicLibraryEntry(origin, nextEntry), canEdit: canEditEntry(nextEntry, googlePayload, anonymousAccount) } });
    }

    if (action === 'update-entry-visibility') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryId = String(body?.entryId || '').trim();
      if (!entryId) return response.status(400).json({ error: 'Invalid visibility payload' });
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      const currentIndex = await getGitHubContent(settings, indexPath);
      const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
      const entryIndex = currentEntries.findIndex((currentEntry) => String(currentEntry?.id || '') === entryId);
      if (entryIndex < 0) return response.status(404).json({ error: 'Library entry not found' });
      if (!canEditEntry(currentEntries[entryIndex], googlePayload, anonymousAccount)) throw unauthorized('Only the owner can hide this entry', 403);
      const hiddenFromPublicLibrary = Boolean(body?.hiddenFromPublicLibrary);
      const nextEntry = { ...currentEntries[entryIndex] };
      if (hiddenFromPublicLibrary) nextEntry.hiddenFromPublicLibrary = true;
      else delete nextEntry.hiddenFromPublicLibrary;
      const nextEntries = [...currentEntries];
      nextEntries[entryIndex] = nextEntry;
      await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: update entry visibility`, currentIndex?.sha, origin);
      return response.status(200).json({ ok: true, entry: { ...publicLibraryEntry(origin, nextEntry), canEdit: canEditEntry(nextEntry, googlePayload, anonymousAccount) } });
    }

    if (action === 'update-library-order') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryId = String(body?.entryId || '').trim();
      const direction = String(body?.direction || '').trim().toLowerCase();
      if (!entryId || !['up', 'down'].includes(direction)) return response.status(400).json({ error: 'Invalid order payload' });
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      const currentIndex = await getGitHubContent(settings, indexPath);
      const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
      const targetEntry = currentEntries.find((currentEntry) => String(currentEntry?.id || '') === entryId);
      if (!targetEntry) return response.status(404).json({ error: 'Library entry not found' });
      if (!canEditEntry(targetEntry, googlePayload, anonymousAccount)) throw unauthorized('Only the owner can reorder this library', 403);
      const ownerEntries = currentEntries
        .filter((currentEntry) => isSameLibraryOwner(currentEntry, targetEntry))
        .sort(compareLibraryEntries);
      const currentPosition = ownerEntries.findIndex((currentEntry) => String(currentEntry?.id || '') === entryId);
      const nextPosition = direction === 'up' ? currentPosition - 1 : currentPosition + 1;
      if (currentPosition < 0 || nextPosition < 0 || nextPosition >= ownerEntries.length) {
        return response.status(200).json({ ok: true, entries: accountLibraryEntries(origin, ownerEntries, googlePayload, anonymousAccount), changed: false });
      }
      const nextOwnerEntries = [...ownerEntries];
      const [movedEntry] = nextOwnerEntries.splice(currentPosition, 1);
      nextOwnerEntries.splice(nextPosition, 0, movedEntry);
      const orderById = new Map(nextOwnerEntries.map((entry, index) => [String(entry.id || ''), index + 1]));
      const nextEntries = currentEntries.map((currentEntry) => {
        const nextOrder = orderById.get(String(currentEntry?.id || ''));
        return nextOrder ? { ...currentEntry, libraryOrder: nextOrder } : currentEntry;
      });
      await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: update public library order`, currentIndex?.sha, origin);
      return response.status(200).json({
        ok: true,
        entries: accountLibraryEntries(origin, nextOwnerEntries.map((entry, index) => ({ ...entry, libraryOrder: index + 1 })), googlePayload, anonymousAccount),
        changed: true,
      });
    }

    if (['update-profile-name', 'update-profile-visibility', 'update-owner-portfolio-mode'].includes(action)) {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const ownerName = cleanPublicProfileText(body.ownerName || googlePayload?.name || '', 80);
      const ownerPicture = cleanPublicProfileImage(body.ownerPicture || googlePayload?.picture || '');
      if (action === 'update-profile-name' && !ownerName) return response.status(400).json({ error: 'Account name is required' });
      const collections = await libraryCollectionIndexes(settings);
      let changed = false;
      for (const collection of collections) {
        for (let attempt = 0; attempt < 3; attempt++) {
          let dirty = false;
          const nextEntries = collection.entries.map(entry => {
            if (!canEditEntry(entry, googlePayload, anonymousAccount)) return entry;
            const next = { ...entry, publicOwnerId: publicOwnerIdFor(googlePayload, anonymousAccount, entry.publicOwnerId) };
            if (googlePayload?.sub) {
              const ownerAccountId = googleOwnerAccountId(googlePayload);
              if (!ownerAccountId) throw new Error('Google owner signing key is not configured');
              next.ownerAccountId = ownerAccountId;
              delete next.ownerEmail;
              delete next.ownerEmailSha256;
              delete next.ownerAnonId;
              delete next.ownerAnonFingerprint;
              delete next.ownerRecoveryHash;
              delete next.ownerRecoveryCreatedAt;
            } else if (anonymousAccount?.id && !entry?.ownerAccountId) {
              next.ownerAnonId = anonymousAccount.id;
            }
            if (ownerName) next.ownerName = ownerName;
            if (ownerPicture) next.ownerPicture = ownerPicture;
            if (action === 'update-profile-visibility') next.showOwnerLibrary = Boolean(body.showOwnerLibrary);
            if (action === 'update-owner-portfolio-mode') next.portfolioMode = Boolean(body.portfolioMode);
            if (JSON.stringify(entry) !== JSON.stringify(next)) dirty = true;
            return next;
          });
          if (!dirty) break;
          try {
            await putGitHubContent(settings, joinRepoPath(collection.basePath, 'index.json'), textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: ${action}`, collection.sha, origin);
            collection.entries = nextEntries;
            changed = true;
            break;
          } catch (error) {
            if (attempt === 2 || ![409, 422].includes(Number(error?.status))) throw error;
            const fresh = await getGitHubContent(settings, joinRepoPath(collection.basePath, 'index.json'));
            collection.entries = JSON.parse(base64ToText(fresh.content));
            collection.sha = fresh.sha;
          }
        }
      }
      const entries = mergeCollectionEntries(collections).filter(entry => canEditEntry(entry, googlePayload, anonymousAccount)).sort(compareLibraryEntries);
      return response.status(200).json({ ok: true, entries: accountLibraryEntries(origin, entries, googlePayload, anonymousAccount), changed });
    }

    if (action === 'delete-entry') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryId = String(body?.entryId || '').trim();
      if (!/^[a-z0-9][a-z0-9._-]{0,180}$/i.test(entryId) || entryId === '..') {
        return response.status(400).json({ error: 'Invalid delete payload' });
      }
      // Portfolio already knows the index containing its card. Read that
      // one index first; the old path scanned every (sometimes huge) archive.
      const hint = String(body?.collectionBasePath || '').trim();
      let collection = null;
      if (/^library(?:_\d+)?$/.test(hint)) {
        const index = await getGitHubContent(settings, joinRepoPath(hint, 'index.json'));
        const entries = index?.encoding === 'base64' && index?.content
          ? JSON.parse(base64ToText(index.content)) : [];
        if (Array.isArray(entries) && entries.some(item => String(item?.id || '') === entryId)) {
          collection = { basePath: hint, entries, sha: index?.sha };
        }
      }
      if (!collection) {
        const collections = await libraryCollectionIndexes(settings);
        collection = collections.find(item => item.entries.some(entry => String(entry?.id || '') === entryId));
      }
      if (!collection) return response.status(404).json({ error: 'Library entry not found' });
      const entry = collection.entries.find(item => String(item?.id || '') === entryId);
      if (!canEditEntry(entry, googlePayload, anonymousAccount)) {
        throw unauthorized('Only the owner can delete this entry', 403);
      }
      const previewPath = cleanRepoPath(entry.previewPath || joinRepoPath(collection.basePath, entryId));
      // Never trust a client-supplied folder for deletion. The path comes
      // from the authorised index and must address exactly this work.
      const pathParts = previewPath.split('/');
      if (!previewPath || pathParts.at(-1) !== entryId ||
          pathParts.some(part => !part || part === '.' || part === '..') ||
          previewPath === collection.basePath || previewPath === 'library') {
        return response.status(409).json({ error: 'Stored preview path is unsafe; no files deleted' });
      }
      const directory = await getGitHubContent(settings, previewPath);
      if (directory && !Array.isArray(directory)) {
        return response.status(409).json({ error: 'Stored preview path is not a folder; no files deleted' });
      }
      // One atomic Git commit removes both the card and the complete asset tree.
      // If GitHub rejects the commit, neither change becomes visible.
      const indexPath = joinRepoPath(collection.basePath, 'index.json');
      const nextEntries = collection.entries.filter(item => String(item?.id || '') !== entryId);
      const commit = await commitGitHubChanges(settings, {
        writes: [{ path: indexPath, contentBase64: textToBase64(JSON.stringify(nextEntries, null, 2)) }],
        deleteTrees: directory ? [previewPath] : [],
        message: `${commitPrefix}: delete work and assets atomically`,
        origin,
      });
      response.setHeader('Cache-Control', 'no-store');
      return response.status(200).json({
        ok: true, deleted: entryId, filesDeleted: Boolean(directory),
        commitSha: String(commit?.sha || ''),
      });
    }

    if (action === 'create-anonymous-recovery-key') {
      response.setHeader('Cache-Control', 'no-store, private');
      response.setHeader('Pragma', 'no-cache');
      if (googlePayload?.email) return response.status(400).json({ error: 'Use your Google account to recover Google-linked uploads' });
      if (!anonymousAccount) throw unauthorized('Anonymous account is required');
      const recoverySecret = createRecoverySecret();
      const recoveryHash = hashRecoverySecret(recoverySecret);
      const createdAt = new Date().toISOString();
      const collections = await libraryCollectionIndexes(settings);
      let updatedEntries = 0;
      for (const collection of collections) {
        const result = await updateLibraryCollectionIndex(
          settings,
          collection,
          entries => addRecoveryHashToOwnedEntries(entries, anonymousAccount.id, recoveryHash, createdAt),
          `${commitPrefix}: create anonymous recovery key`,
          origin,
        );
        updatedEntries += result.changed;
      }
      if (!updatedEntries) return response.status(404).json({ error: 'No anonymous uploads found for this account yet' });
      return response.status(200).json({ ok: true, recoverySecret, updatedEntries });
    }

    if (action === 'recover-anonymous-library') {
      response.setHeader('Cache-Control', 'no-store, private');
      response.setHeader('Pragma', 'no-cache');
      if (googlePayload?.email) return response.status(400).json({ error: 'Use your Google account to open your library' });
      if (!anonymousAccount) throw unauthorized('Anonymous account is required');
      const recoverySecret = normalizeRecoverySecret(body?.recoverySecret);
      if (!recoverySecret) return response.status(400).json({ error: 'Invalid recovery key format' });
      const recoveryHash = hashRecoverySecret(recoverySecret);
      const collections = await libraryCollectionIndexes(settings);
      let recoveredCount = 0;
      for (const collection of collections) {
        const result = await updateLibraryCollectionIndex(
          settings,
          collection,
          entries => recoverEntriesByRecoveryHash(entries, recoveryHash, anonymousAccount.id),
          `${commitPrefix}: restore anonymous library`,
          origin,
        );
        recoveredCount += result.changed;
      }
      if (!recoveredCount) return response.status(401).json({ error: 'Recovery key is invalid or has been revoked' });
      const restoredEntries = mergeCollectionEntries(collections)
        .filter(item => canEditEntry(item, null, anonymousAccount))
        .sort(compareLibraryEntries);
      return response.status(200).json({
        ok: true,
        recoveredCount,
        entries: accountLibraryEntries(origin, restoredEntries, null, anonymousAccount),
      });
    }

    if (action === 'revoke-anonymous-recovery-key') {
      response.setHeader('Cache-Control', 'no-store, private');
      response.setHeader('Pragma', 'no-cache');
      if (googlePayload?.email) return response.status(400).json({ error: 'Use your Google account to manage this library' });
      if (!anonymousAccount) throw unauthorized('Anonymous account is required');
      const collections = await libraryCollectionIndexes(settings);
      let revokedCount = 0;
      for (const collection of collections) {
        const result = await updateLibraryCollectionIndex(
          settings,
          collection,
          entries => revokeRecoveryHashFromOwnedEntries(entries, anonymousAccount.id),
          `${commitPrefix}: revoke anonymous recovery key`,
          origin,
        );
        revokedCount += result.changed;
      }
      return response.status(200).json({ ok: true, revokedCount });
    }

    if (action === 'get-index') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const collections = await libraryCollectionIndexes(settings, { readOnly: true });
      const collectionById = new Map();
      for (const collection of collections) {
        for (const item of collection.entries) {
          const id = String(item?.id || '');
          if (id && !collectionById.has(id)) collectionById.set(id, collection.basePath);
        }
      }
      const currentEntries = mergeCollectionEntries(collections).map(item => ({
        ...item, collectionBasePath: collectionById.get(String(item.id)) || '',
      }));
      const userEmail = String(googlePayload?.email || '').toLowerCase();
      const anonymousId = String(anonymousAccount?.id || '').toLowerCase();
      // "mine" powers the MY PORTFOLIO dialog, which must show only the works
      // the caller owns. The default stays public because the archive and the
      // edit page both look entries up by id across the whole library.
      const scope = String(body?.scope || 'public');
      const ownerScoped = scope === 'mine';
      const entries = currentEntries.filter((currentEntry) => {
        if (ownerScoped) {
          // Own entries only, and hidden ones included: a hidden work belongs in
          // your own portfolio so you can unhide or delete it. Filtering by
          // visibility here would make the portfolio's own "hidden" filter
          // permanently empty.
          return canEditEntry(currentEntry, googlePayload, anonymousAccount);
        }
        const isPublic = currentEntry?.hiddenFromPublicLibrary !== true;
        return isPublic;
      }).sort(compareLibraryEntries);
      // The browser must not decide this on its own: it used to render
      // Edit/Hide/Delete for every card it received, so any anonymous visitor
      // saw owner controls on the whole library. Ownership is decided here,
      // with the same check the mutations use, and only the boolean is sent
      // out. ownerEmail/ownerAnonId are stripped because shipping every
      // user's address to every visitor is its own leak.
      return response.status(200).json({
        ok: true,
        entries: accountLibraryEntries(origin, entries, googlePayload, anonymousAccount),
      });
    }

    if (action === 'get-entry') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const entryId = String(body?.entryId || '').trim();
      if (!entryId) return response.status(400).json({ error: 'Invalid entry payload' });
      // The just-published client already knows its exact collection. Read that
      // index first: scanning old collections before returning can download
      // tens of MB and hold up navigation despite a successful atomic commit.
      const indexPath = joinRepoPath(settings.basePath, 'index.json');
      const currentIndex = await getGitHubContent(settings, indexPath);
      const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64'
        ? JSON.parse(base64ToText(currentIndex.content)) : [];
      let entry = currentEntries.find((item) => String(item?.id || '') === entryId);
      // Old saved links/editors may not know the collection after a rotation.
      // Only they pay the price of a cross-library fallback lookup.
      if (!entry) {
        const collections = await libraryCollectionIndexes(settings, { readOnly: true });
        const collection = collections.find(item => item.entries.some(itemEntry => String(itemEntry?.id || '') === entryId));
        entry = collection?.entries.find(item => String(item?.id || '') === entryId);
      }
      if (!entry) return response.status(404).json({ error: 'Library entry not found' });
      return response.status(200).json({
        ok: true, entry: publicLibraryEntry(origin, entry),
        canEdit: canEditEntry(entry, googlePayload, anonymousAccount),
      });
    }

    if (action === 'merge-anonymous-account') {
      if (!googlePayload?.email) throw unauthorized('Sign in with Google before merging library');
      if (!anonymousAccount) throw unauthorized('Anonymous account is required');
      const anonymousId = anonymousAccount.id.toLowerCase();
      const userEmail = String(googlePayload.email).toLowerCase();
      const ownerAccountId = googleOwnerAccountId(googlePayload);
      if (!ownerAccountId) throw new Error('Google owner signing key is not configured');
      const collections = await libraryCollectionIndexes(settings);
      let merged = false;
      for (const collection of collections) {
        for (let attempt = 0; attempt < 3; attempt++) {
          let changed = false;
          const nextEntries = collection.entries.map(currentEntry => {
            if (String(currentEntry?.ownerAnonId || '').toLowerCase() !== anonymousId) return currentEntry;
            const existingEmail = String(currentEntry.ownerEmail || '').toLowerCase();
            if (existingEmail && existingEmail !== userEmail) return currentEntry;
            if (currentEntry.ownerEmailSha256 && currentEntry.ownerEmailSha256 !== sha256Hex(userEmail)) return currentEntry;
            if (currentEntry.ownerAccountId && currentEntry.ownerAccountId !== ownerAccountId) return currentEntry;
            if (currentEntry.ownerAccountId === ownerAccountId && !existingEmail &&
                !currentEntry.ownerEmailSha256 && !currentEntry.ownerRecoveryHash) return currentEntry;
            changed = true;
            const nextEntry = { ...currentEntry,
              ownerAccountId,
              publicOwnerId: publicOwnerIdFor(googlePayload, anonymousAccount, currentEntry.publicOwnerId),
              ownerName: cleanPublicProfileText(currentEntry.ownerName || body.ownerName || googlePayload.name || ''),
              ownerPicture: cleanPublicProfileImage(currentEntry.ownerPicture || body.ownerPicture || googlePayload.picture || '') };
            delete nextEntry.ownerEmail;
            delete nextEntry.ownerEmailSha256;
            delete nextEntry.ownerAnonId;
            delete nextEntry.ownerAnonFingerprint;
            delete nextEntry.ownerRecoveryHash;
            delete nextEntry.ownerRecoveryCreatedAt;
            return nextEntry;
          });
          if (!changed) break;
          try {
            await putGitHubContent(settings, joinRepoPath(collection.basePath, 'index.json'), textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: merge library account`, collection.sha, origin);
            collection.entries = nextEntries;
            merged = true;
            break;
          } catch (error) {
            if (attempt === 2 || ![409, 422].includes(Number(error?.status))) throw error;
            const fresh = await getGitHubContent(settings, joinRepoPath(collection.basePath, 'index.json'));
            collection.entries = JSON.parse(base64ToText(fresh.content));
            collection.sha = fresh.sha;
          }
        }
      }
      const entries = mergeCollectionEntries(collections).filter(entry => canEditEntry(entry, googlePayload, anonymousAccount)).sort(compareLibraryEntries);
      return response.status(200).json({ ok: true, entries: accountLibraryEntries(origin, entries, googlePayload, anonymousAccount), merged });
    }

    if (action === 'get-admin-settings') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const blockchainEnabled = String(process.env.BLOCKCHAIN_ENABLED || 'false').toLowerCase() === 'true';
      const censorship = await readCensorshipLists(settings);
      return response.status(200).json({ ok: true, blockchainEnabled, addMoreWorkEnabled: true, ...censorship });
    }

    if (action === 'set-admin-settings') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const blockchainEnabled = Boolean(body?.blockchainEnabled);
      return response.status(200).json({ ok: true, blockchainEnabled, message: blockchainEnabled ? 'Blockchain anchoring enabled' : 'Blockchain anchoring disabled' });
    }

    // Списки цензуры: закрытые авторы и исключения к ним.
    if (action === 'get-censorship') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const lists = await readCensorshipLists(settings);
      return response.status(200).json({ ok: true, ...lists });
    }

    if (action === 'set-censorship') {
      if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');
      const saved = await writeCensorshipLists(settings, {
        blocked: normalizeIdList(body?.blocked),
        allowed: normalizeIdList(body?.allowed),
      });
      return response.status(200).json({ ok: true, ...saved });
    }

    if (!settings.owner || !settings.repo || !uploadPath || !entry || !previewHtml || files.length < 3) {
      return response.status(400).json({ error: 'Invalid upload payload' });
    }

    if (!googlePayload && !anonymousAccount) throw unauthorized('Anonymous account is required');

    for (const file of files) {
      const filePath = joinRepoPath(uploadPath, file.name);
      const currentFile = await getGitHubContent(settings, filePath);
      await putGitHubContent(settings, filePath, file.contentBase64, `${commitPrefix}: ${file.name}`, currentFile?.sha, origin);
    }

    const previewPath = joinRepoPath(uploadPath, 'preview.html');
    const manifestPath = joinRepoPath(uploadPath, 'manifest.json');
    const currentPreview = await getGitHubContent(settings, previewPath);
    const currentManifest = await getGitHubContent(settings, manifestPath);
    await putGitHubContent(settings, previewPath, textToBase64(previewHtml), `${commitPrefix}: preview.html`, currentPreview?.sha, origin);
    await putGitHubContent(settings, manifestPath, textToBase64(JSON.stringify(entry, null, 2)), `${commitPrefix}: manifest.json`, currentManifest?.sha, origin);

    const indexPath = joinRepoPath(settings.basePath, 'index.json');
    const currentIndex = await getGitHubContent(settings, indexPath);
    const currentEntries = currentIndex?.content && currentIndex.encoding === 'base64' ? JSON.parse(base64ToText(currentIndex.content)) : [];
    const existingEntry = currentEntries.find((c) => c.id === entry.id);
      if (existingEntry && !canEditEntry(existingEntry, googlePayload, anonymousAccount)) throw unauthorized('Only the owner can update this library entry', 403);
    const nextEntry = applyOwnerMetadata({
      ...entry,
      ...(entry?.ownerName || googlePayload?.name ? { ownerName: cleanPublicProfileText(entry?.ownerName || googlePayload?.name) } : {}),
      ...(entry?.ownerPicture || googlePayload?.picture ? { ownerPicture: cleanPublicProfileImage(entry?.ownerPicture || googlePayload?.picture) } : {}),
      showOwnerLibrary: Boolean(entry?.showOwnerLibrary),
      portfolioMode: Boolean(entry?.portfolioMode),
      ...(existingEntry?.webmStatus === 'ready' ? { webmStatus: 'ready' } : { webmStatus: 'pending' }),
    }, googlePayload, anonymousAccount, existingEntry, existingEntry?.publicOwnerId);
    const nextEntries = [nextEntry, ...currentEntries.filter((currentEntry) => currentEntry.id !== nextEntry.id)];

    await putGitHubContent(settings, indexPath, textToBase64(JSON.stringify(nextEntries, null, 2)), `${commitPrefix}: update library index`, currentIndex?.sha, origin);
    const dataScience = await updateDataScienceCatalog(settings, body, nextEntry, commitPrefix, origin);
    const dispatch = existingEntry?.webmStatus === 'ready' ? null : await dispatchSpineExportWebm(settings, nextEntry, origin);

    return response.status(200).json({
      ok: true,
      repositoryUrl: entry.repositoryUrl,
      previewUrl: `/api/github-preview?path=${encodeURIComponent(entry.previewPath)}`,
       uploaded: files.length + 3,
       dataScience,
       dispatch,
     });
  } catch (error) {
    const rateLimited = Number(error?.statusCode) === 429;
    // A definitive GitHub 4xx is the real answer, not a server fault. Reporting
    // it as a flat 500 threw away the only clue about what went wrong, which is
    // what made this take three attempts to find. Pass the real status through
    // so the client sees "422" instead of a meaningless "500".
    const githubStatus = Number(error?.status);
    const definitiveClientStatus = githubStatus >= 400 && githubStatus < 500 && githubStatus !== 429;
    const statusCode = rateLimited ? 429 : definitiveClientStatus ? githubStatus : (Number(error?.statusCode) || 500);
    const message = error instanceof Error ? error.message : 'Upload failed';
    // GitHub's own wording explains the 422 far better than our summary does.
    const detail = error?.githubMessage && error.githubMessage !== message ? ` (${error.githubMessage})` : '';
    console.error(`[UPLOAD] error (action=${failedAction}):`, message + detail);
    if (error instanceof Error && error.stack) console.error('[UPLOAD] stack:', error.stack);
    // Tell the browser how long GitHub wants us to wait, so it backs off
    // instead of replaying the chunk and losing the whole upload.
    const retryAfter = Number(error?.retryAfter);
    if (rateLimited && Number.isFinite(retryAfter) && retryAfter > 0) response.setHeader('Retry-After', String(retryAfter));
    return response.status(statusCode).json({ error: message + detail, ...(rateLimited ? { retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null } : {}) });
  }
}
