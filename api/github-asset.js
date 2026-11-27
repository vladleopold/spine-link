import { sanitizeSkeletonJsonText } from '../lib/spine-json-sanitize.js';
const defaultOwner = 'vladleopold';
const defaultRepo = 'spine';
const defaultBranch = 'main';
import { cacheProfiles, setCacheHeaders, setNoStoreHeaders } from '../lib/cache-headers.js';
import { ddsToPng } from '../lib/dds-png.js';
import { canReadPublicSpineWithoutToken } from '../lib/github-read-access.js';
import { convertLegacySpineAsset } from '../lib/spine-binary-conversion.js';
import { extractSpineJsonFromUnityTextAsset } from '../lib/spine-unity-textasset.js';

const memoryCache = globalThis.__spineLinkAssetMemoryCache || {
  entries: new Map(),
  bytes: 0,
};
globalThis.__spineLinkAssetMemoryCache = memoryCache;
const memoryCacheMaxBytes = 64 * 1024 * 1024;
const memoryCacheMaxEntries = 160;
const memoryCacheTtlMs = 10 * 60 * 1000;
const memoryCacheMaxObjectBytes = 16 * 1024 * 1024;
const directRangeProxyMinBytes = 16 * 1024 * 1024;

function cleanRepoPath(value = '') {
  return String(value).trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function normalizeRepoPath(value = '') {
  const parts = cleanRepoPath(value).split('/').filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join('/');
}

function base64ToBuffer(base64) {
  return Buffer.from(String(base64).replace(/\s/g, ''), 'base64');
}

async function contentBufferFromGitHubContent(data, token) {
  if (typeof data?.content === 'string' && data.content.trim()) {
    return base64ToBuffer(data.content);
  }

  if (typeof data?.download_url === 'string' && data.download_url) {
    const rawResponse = await githubRawFetch(data.download_url, token);
    if (!rawResponse.ok) throw new Error(`Raw asset did not load: ${rawResponse.status}`);
    return Buffer.from(await rawResponse.arrayBuffer());
  }

  throw new Error('Asset content is empty');
}

function contentTypeFor(path) {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lowerPath.endsWith('.atlas') || lowerPath.endsWith('.atlas.txt') || lowerPath.endsWith('.atlas.docx') || lowerPath.endsWith('.atlas.spine43')) return 'text/plain; charset=utf-8';
  if (lowerPath.endsWith('.png')) return 'image/png';
  // Spine Web Player needs an image, not raw BC3/DXT DDS bytes.
  if (lowerPath.endsWith('.dds')) return 'image/png';
  if (lowerPath.endsWith('.gif')) return 'image/gif';
  if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerPath.endsWith('.webp')) return 'image/webp';
  if (lowerPath.endsWith('.webm')) return 'video/webm';
  if (lowerPath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lowerPath.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (lowerPath.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (lowerPath.endsWith('.skel')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function isVideoPath(path) {
  return String(path || '').toLowerCase().endsWith('.webm');
}

function isIndexableMediaPath(path) {
  return /\.(png|gif|jpe?g|webp|webm)$/i.test(String(path || ''));
}

function cacheProfileForAsset(path, assetVersion) {
  if (assetVersion) return [cacheProfiles.immutable, cacheProfiles.immutableCdn];
  if (path === 'library/index.json') return [cacheProfiles.listBrowser, cacheProfiles.listCdn];
  if (isIndexableMediaPath(path)) return [cacheProfiles.mediaBrowser, cacheProfiles.mediaCdn];
  return [cacheProfiles.assetBrowser, cacheProfiles.assetCdn];
}

function githubContentSize(data) {
  const size = Number(data?.size || 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function requestMatchesEtag(request, etag) {
  return Boolean(etag && String(request.headers['if-none-match'] || '') === etag);
}

function memoryCacheKey({ owner, repo, branch, path, assetVersion }) {
  return [owner, repo, branch, path, assetVersion].join('\n');
}

function forgetMemoryCacheEntry(key) {
  const cached = memoryCache.entries.get(key);
  if (!cached) return;
  memoryCache.bytes = Math.max(0, memoryCache.bytes - cached.buffer.length);
  memoryCache.entries.delete(key);
}

function getMemoryCacheEntry(key) {
  const cached = memoryCache.entries.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    forgetMemoryCacheEntry(key);
    return null;
  }
  memoryCache.entries.delete(key);
  memoryCache.entries.set(key, cached);
  return cached;
}

function putMemoryCacheEntry(key, entry) {
  if (!entry?.buffer?.length || entry.buffer.length > memoryCacheMaxObjectBytes) return;
  forgetMemoryCacheEntry(key);
  memoryCache.entries.set(key, {
    ...entry,
    expiresAt: Date.now() + memoryCacheTtlMs,
  });
  memoryCache.bytes += entry.buffer.length;

  while (memoryCache.entries.size > memoryCacheMaxEntries || memoryCache.bytes > memoryCacheMaxBytes) {
    const oldestKey = memoryCache.entries.keys().next().value;
    if (!oldestKey) break;
    forgetMemoryCacheEntry(oldestKey);
  }
}

function isAtlasPath(path) {
  const lowerPath = path.toLowerCase();
  return lowerPath.endsWith('.atlas') || lowerPath.endsWith('.atlas.txt') || lowerPath.endsWith('.atlas.docx') || lowerPath.endsWith('.atlas.spine43');
}

function isSkeletonJsonPath(path) {
  return String(path || '').toLowerCase().endsWith('.json');
}

function sanitizeSkeletonJsonBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer;
  const source = buffer.toString('utf8');
  const normalized = sanitizeSkeletonJsonText(source);
  return normalized === source ? buffer : Buffer.from(normalized, 'utf8');
}

function byteRangeFromHeader(rangeHeader = '', size = 0) {
  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) return null;
  const startText = match[1];
  const endText = match[2];
  let start = startText ? Number(startText) : 0;
  let end = endText ? Number(endText) : size - 1;

  if (!startText && endText) {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function sanitizeLibraryIndex(buffer) {
  try {
    const entries = JSON.parse(buffer.toString('utf8'));
    if (!Array.isArray(entries)) return buffer;
    const sanitized = entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const next = { ...entry };
      for (const key of ['thumbnail', 'thumbnailPoster', 'webmPreview']) {
        if (typeof next[key] === 'string' && /^data:/i.test(next[key])) next[key] = '';
      }
      return next;
    });
    return Buffer.from(JSON.stringify(sanitized, null, 2), 'utf8');
  } catch {
    return buffer;
  }
}

function withAtlasPageCacheBuster(buffer, version) {
  const text = buffer.toString('utf8');
  if (!version && !/\.dds(?:\?|\r|\n|$)/im.test(text)) return buffer;
  const nextText = text.replace(
    /^([^\r\n:]+?\.(?:png|jpe?g|webp|dds))(?:\?[^\r\n]*)?$/gim,
    (_match, pageName) => {
      const dds = /\.dds$/i.test(pageName);
      if (!version && !dds) return _match;
      const query = [
        ...(version ? ["v=" + encodeURIComponent(version)] : []),
        ...(dds ? ["dds=png-v1"] : []),
      ];
      return pageName + "?" + query.join("&");
    },
  );
  return Buffer.from(nextText, 'utf8');
}

function stripPmaMetadataForSpine38(buffer) {
  // The official 3.8 TextureAtlas parser predates the newer pma page field.
  // Keep the premultipliedAlpha setting on the player config; remove only this
  // unsupported atlas metadata line from the response sent to the 3.8 runtime.
  const text = buffer.toString('utf8');
  const normalized = text.replace(/^[ \t]*pma[ \t]*:[ \t]*(?:true|false)[ \t]*(?:\r?\n|$)/im, '');
  return normalized === text ? buffer : Buffer.from(normalized, 'utf8');
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

async function githubApiFetch(url, token) {
  let response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok && token && (response.status === 401 || response.status === 403)) {
    response = await fetch(url, { headers: githubHeaders('') });
  }
  return response;
}

async function githubRawFetch(url, token, extraHeaders = {}) {
  let response = await fetch(url, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  });
  if (!response.ok && token && (response.status === 401 || response.status === 403)) {
    response = await fetch(url, { headers: extraHeaders });
  }
  return response;
}

async function findFallbackGitHubPath({ owner, repo, branch, token, path }) {
  const basename = path.split('/').filter(Boolean).pop() || '';
  const basenameParts = basename.split('.');
  const extension = basenameParts.length > 1 ? `.${basenameParts.pop()}` : '';
  const stem = basenameParts.join('.');
  const duplicatedPrefix = (() => {
    const parts = stem.split('_');
    for (let size = Math.max(1, Math.floor(parts.length / 2)); size >= 1; size -= 1) {
      const left = parts.slice(0, size).join('_');
      const right = parts.slice(size, size * 2).join('_');
      if (left && right && left === right) return `${left}${extension}`;
    }
    return '';
  })();
  const repeatedStemCandidates = [];
  for (let index = 1; index < stem.length - 1; index += 1) {
    if (stem[index] !== '_') continue;
    const left = stem.slice(0, index);
    const right = stem.slice(index + 1);
    if (left && left === right) repeatedStemCandidates.push(`${left}${extension}`);
  }
  const simplifiedBasename = basename.includes('_') ? basename.slice(basename.lastIndexOf('_') + 1) : '';
  const suffixAfterTextures = path.includes('/textures/')
    ? path.slice(path.indexOf('/textures/') + '/textures/'.length)
    : '';
  const treeResponse = await githubApiFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token,
  );
  if (!treeResponse.ok) return '';
  const treeJson = await treeResponse.json();
  const tree = Array.isArray(treeJson?.tree) ? treeJson.tree : [];
  const candidates = new Set([
    path,
    suffixAfterTextures,
    basename,
    simplifiedBasename,
    ...repeatedStemCandidates,
    duplicatedPrefix,
  ].filter(Boolean));
  // Never fall back to "any file anywhere with this basename". Every broken
  // entry asks for library/<id>/preview.webp, so that matched whichever
  // preview.webp happened to come first in the tree (155 of them, sorted, and
  // the first was a 0_human asset) and every broken card ended up showing the
  // same unrelated image. A wrong picture is worse than no picture: fall back
  // only within the entry's own directory, and otherwise report it missing so
  // the client can render its neutral placeholder instead.
  const ownDirectory = path.slice(0, path.length - basename.length);
  const match = tree.find((item) => item?.type === 'blob' && candidates.has(String(item?.path || '')))
    || tree.find((item) => item?.type === 'blob' && basename
      && String(item?.path || '') === `${ownDirectory}${basename}`
      && ownDirectory.length > 0);
  if (match) return String(match?.path || '');
  return '';
}

function setAssetResponseHeaders(request, response, { path, assetVersion, etag }) {
  const contentType = contentTypeFor(path);
  const isVideo = isVideoPath(path);
  const [browserCache, cdnCache] = cacheProfileForAsset(path, assetVersion);
  response.setHeader('Content-Type', contentType);
  setCacheHeaders(response, browserCache, cdnCache);
  if (isIndexableMediaPath(path)) response.setHeader('X-Robots-Tag', 'index, follow');
  if (isVideo) response.setHeader('Accept-Ranges', 'bytes');
  if (etag) response.setHeader('ETag', etag);
  if (requestMatchesEtag(request, etag)) return response.status(304).end();
  return null;
}

function sendAssetHeadFromMetadata(request, response, { path, assetVersion, data, etag }) {
  if (request.method !== 'HEAD') return null;
  const earlyResponse = setAssetResponseHeaders(request, response, { path, assetVersion, etag });
  if (earlyResponse) return earlyResponse;
  const size = githubContentSize(data);
  // DDS is converted to PNG in GET; original DDS byte length is not PNG length.
  if (size && !/\.dds$/i.test(path)) response.setHeader('Content-Length', String(size));
  response.setHeader('X-Spine-Link-Asset-Head', 'metadata');
  return response.status(200).end();
}

async function sendGitHubRangeAsset(request, response, { path, assetVersion, data, token, etag }) {
  const rangeHeader = request.headers.range;
  const size = githubContentSize(data);
  if (request.method !== 'GET' || !isVideoPath(path) || !rangeHeader || !data?.download_url || size <= directRangeProxyMinBytes) return null;

  const rawResponse = await githubRawFetch(data.download_url, token, { Range: rangeHeader });

  if (rawResponse.status !== 206) return null;

  const chunk = Buffer.from(await rawResponse.arrayBuffer());
  setAssetResponseHeaders(request, response, { path, assetVersion, etag });
  setNoStoreHeaders(response);
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('X-Spine-Link-Asset-Range', 'github');
  response.setHeader('X-Spine-Link-Asset-Cache', 'range');
  const contentRange = rawResponse.headers.get('content-range');
  if (contentRange) response.setHeader('Content-Range', contentRange);
  response.setHeader('Content-Length', String(chunk.length));
  return response.status(206).send(chunk);
}

function sendAssetBuffer(request, response, { path, assetVersion, buffer, etag }) {
  const isVideo = isVideoPath(path);
  const rangeHeader = request.headers.range;
  const shouldServeRange = isVideo && rangeHeader && buffer.length > directRangeProxyMinBytes;
  const earlyResponse = setAssetResponseHeaders(request, response, { path, assetVersion, etag });
  if (earlyResponse) return earlyResponse;
  if (isVideo) response.setHeader('Accept-Ranges', shouldServeRange ? 'bytes' : 'none');
  response.setHeader('X-Spine-Link-Asset-Cache', 'memory');

  if (shouldServeRange) {
    setNoStoreHeaders(response);
    const range = byteRangeFromHeader(rangeHeader, buffer.length);
    if (!range) {
      response.setHeader('Content-Range', `bytes */${buffer.length}`);
      response.setHeader('Content-Length', '0');
      return response.status(416).end();
    }
    const chunk = buffer.subarray(range.start, range.end + 1);
    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${buffer.length}`);
    response.setHeader('Content-Length', String(chunk.length));
    return response.status(206).send(request.method === 'HEAD' ? '' : chunk);
  }

  response.setHeader('Content-Length', String(buffer.length));
  if (request.method === 'HEAD') {
    return response.status(200).end();
  }
  return response.status(200).send(buffer);
}

export default async function handler(request, response) {
  // CORS headers for headless browser (origin: null)
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') {
    return response.status(204).end();
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).send('Method not allowed');
  }

  const token = process.env.GITHUB_TOKEN || '';
  const owner = process.env.GITHUB_OWNER || defaultOwner;
  const repo = process.env.GITHUB_REPO || defaultRepo;
  const branch = process.env.GITHUB_BRANCH || defaultBranch;
  if (!canReadPublicSpineWithoutToken(token, owner, repo)) {
    return response.status(500).send('GITHUB_TOKEN is required for non-public repository access');
  }

  const path = normalizeRepoPath(request.query?.path || '');
  if (!path) return response.status(400).send('Invalid asset path');
  // Keep the requested media path exact. Low quality is permitted only
  // when its matching low-quality WebM is installed; never rewrite a poster
  // to a different tier or substitute another image.
  const assetPath = path;
  const assetVersion = typeof request.query?.v === 'string' ? request.query.v : '';
  const spineRuntimeRequest = String(request.query?.spineRuntime || '');
  const convertTo43 = spineRuntimeRequest === '4.3';
  const extractUnitySkeleton = spineRuntimeRequest === '4.2' && /\.(?:skel|bytes|json)\.json$/i.test(assetPath);
  const convertedSkeleton = convertTo43 && /\.skel\.json$/i.test(assetPath);
  const convertedAtlas = convertTo43 && /\.atlas\.spine43$/i.test(assetPath);
  const sourcePath = convertedSkeleton || extractUnitySkeleton
    ? assetPath.slice(0, -5)
    : convertedAtlas
      ? assetPath.slice(0, -8)
      : assetPath;

  const encodedPath = encodeURIComponent(sourcePath).replace(/%2F/g, '/');
  const cacheKey = memoryCacheKey({ owner, repo, branch, path: assetPath, assetVersion });
  const cachedAsset = getMemoryCacheEntry(cacheKey);
  if (cachedAsset) {
    response.setHeader('X-Spine-Link-Asset-Memory', 'hit');
    return sendAssetBuffer(request, response, {
      path,
      assetVersion,
      buffer: cachedAsset.buffer,
      etag: cachedAsset.etag,
    });
  }

  try {
    let githubResponse = await githubApiFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
      token,
    );
    // Spine atlases exported from DXT5 packs sometimes still reference
    // page.dds although the upload contains page.png of the SAME name.
    // Only try the identical pathname with its extension changed, never
    // redirect to an arbitrary image elsewhere in the library.
    if (!githubResponse.ok && /\.dds$/i.test(assetPath)) {
      const pngPath = assetPath.replace(/\.dds$/i, '.png');
      const pngEncoded = encodeURIComponent(pngPath).replace(/%2F/g, '/');
      const sameFolderPng = await githubApiFetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${pngEncoded}?ref=${encodeURIComponent(branch)}`,
        token,
      );
      if (sameFolderPng.ok) {
        githubResponse = sameFolderPng;
        response.setHeader('X-Spine-Link-DDS-PNG-Alias', 'same-stem');
      }
    }

    if (!githubResponse.ok && (githubResponse.status === 401 || githubResponse.status === 403)) {
      const rawPath = encodeURIComponent(sourcePath).replace(/%2F/g, '/');
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${rawPath}`;
      let rawResponse = await githubRawFetch(rawUrl, token);
      if (!rawResponse.ok && /\\.dds$/i.test(assetPath)) {
        const pngPath = assetPath.replace(/\\.dds$/i, '.png');
        const pngRawPath = encodeURIComponent(pngPath).replace(/%2F/g, '/');
        rawResponse = await githubRawFetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${pngRawPath}`,
          token,
        );
        if (rawResponse.ok) response.setHeader('X-Spine-Link-DDS-PNG-Alias', 'same-stem');
      }
      if (rawResponse.ok) {
        let buffer = Buffer.from(await rawResponse.arrayBuffer());
        if (/\\.dds$/i.test(assetPath)) {
          const alreadyPng = buffer.length >= 8 && buffer.subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          if (!alreadyPng) buffer = ddsToPng(buffer);
          response.setHeader('X-Spine-Link-Texture-Transcoded', 'DXT-to-PNG-v1');
        }
        if (extractUnitySkeleton) {
          buffer = Buffer.from(extractSpineJsonFromUnityTextAsset(buffer), 'utf8');
          response.setHeader('X-Spine-Link-Converted', 'unity-textasset-to-spine-json');
        } else if (convertedSkeleton) {
          const converted = await convertLegacySpineAsset(buffer, 'skeleton');
          buffer = converted.buffer;
          response.setHeader('X-Spine-Link-Converted', 'spine-3.7-to-4.3-json');
          response.setHeader('X-Spine-Link-Conversion-Loss-Count', String(converted.lossCount));
          response.setHeader('X-Spine-Link-Conversion-Max-Impact', converted.maxImpact);
        } else if (convertedAtlas) {
          const converted = await convertLegacySpineAsset(buffer, 'atlas');
          buffer = converted.buffer;
          response.setHeader('X-Spine-Link-Converted', 'spine-atlas-to-4.3');
          response.setHeader('X-Spine-Link-Conversion-Loss-Count', String(converted.lossCount));
          response.setHeader('X-Spine-Link-Conversion-Max-Impact', converted.maxImpact);
        }
        if (isSkeletonJsonPath(assetPath)) buffer = sanitizeSkeletonJsonBuffer(buffer);
        if (isAtlasPath(assetPath)) {
          buffer = withAtlasPageCacheBuster(buffer, assetVersion);
          if (String(request.query?.spineRuntime || '') === '3.8') buffer = stripPmaMetadataForSpine38(buffer);
        }
        if (assetPath === 'library/index.json') buffer = sanitizeLibraryIndex(buffer);
        const etag = rawResponse.headers.get('etag') || '';
        putMemoryCacheEntry(cacheKey, { buffer, etag });
        response.setHeader('X-Spine-Link-Asset-Memory', 'raw-fallback');
        return sendAssetBuffer(request, response, { path: assetPath, assetVersion, buffer, etag });
      }
    }

    if (!githubResponse.ok) {
      const fallbackPath = await findFallbackGitHubPath({ owner, repo, branch, token, path: sourcePath });
      if (!fallbackPath || fallbackPath === sourcePath) return response.status(githubResponse.status).send('Asset not found');
      const fallbackEncodedPath = encodeURIComponent(fallbackPath).replace(/%2F/g, '/');
      githubResponse = await githubApiFetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${fallbackEncodedPath}?ref=${encodeURIComponent(branch)}`,
        token,
      );
      if (!githubResponse.ok) return response.status(githubResponse.status).send('Asset not found');
    }

    const data = await githubResponse.json();
    const etag = data?.sha ? `"github-${data.sha}${assetVersion ? `-${assetVersion}` : ''}${/\.dds$/i.test(assetPath) ? '-dds-rgba-png-v1' : ''}"` : '';
    if (requestMatchesEtag(request, etag)) {
      const earlyResponse = setAssetResponseHeaders(request, response, { path: assetPath, assetVersion, etag });
      if (earlyResponse) return earlyResponse;
    }
    if (!convertedSkeleton && !convertedAtlas && !extractUnitySkeleton) {
      const headResponse = sendAssetHeadFromMetadata(request, response, { path: assetPath, assetVersion, data, etag });
      if (headResponse) return headResponse;
      const rangeResponse = await sendGitHubRangeAsset(request, response, { path: assetPath, assetVersion, data, token, etag });
      if (rangeResponse) return rangeResponse;
    }
    let buffer = await contentBufferFromGitHubContent(data, token);
    if (!buffer.length) return response.status(404).send('Asset is empty');
    if (extractUnitySkeleton) {
      buffer = Buffer.from(extractSpineJsonFromUnityTextAsset(buffer), 'utf8');
      response.setHeader('X-Spine-Link-Converted', 'unity-textasset-to-spine-json');
    } else if (convertedSkeleton) {
      const converted = await convertLegacySpineAsset(buffer, 'skeleton');
      buffer = converted.buffer;
      response.setHeader('X-Spine-Link-Converted', 'spine-3.7-to-4.3-json');
      response.setHeader('X-Spine-Link-Conversion-Loss-Count', String(converted.lossCount));
      response.setHeader('X-Spine-Link-Conversion-Max-Impact', converted.maxImpact);
    } else if (convertedAtlas) {
      const converted = await convertLegacySpineAsset(buffer, 'atlas');
      buffer = converted.buffer;
      response.setHeader('X-Spine-Link-Converted', 'spine-atlas-to-4.3');
      response.setHeader('X-Spine-Link-Conversion-Loss-Count', String(converted.lossCount));
      response.setHeader('X-Spine-Link-Conversion-Max-Impact', converted.maxImpact);
    }
    if (isSkeletonJsonPath(assetPath)) buffer = sanitizeSkeletonJsonBuffer(buffer);
    if (/\.dds$/i.test(assetPath)) {
      try {
        const alreadyPng = buffer.length >= 8 && buffer.subarray(0,8)
          .equals(Buffer.from([137,80,78,71,13,10,26,10]));
        if (!alreadyPng) {
          buffer = ddsToPng(buffer);
          response.setHeader('X-Spine-Link-Texture-Transcoded', 'DXT-to-PNG-v1');
        }
      } catch (error) {
        setNoStoreHeaders(response);
        return response.status(415).send(error instanceof Error ? error.message : 'Unsupported DDS texture');
      }
    }
    if (isAtlasPath(assetPath)) {
      buffer = withAtlasPageCacheBuster(buffer, assetVersion);
      if (String(request.query?.spineRuntime || '') === '3.8') buffer = stripPmaMetadataForSpine38(buffer);
    }
    if (assetPath === 'library/index.json') {
      buffer = sanitizeLibraryIndex(buffer);
    }
    putMemoryCacheEntry(cacheKey, { buffer, etag });
    response.setHeader('X-Spine-Link-Asset-Memory', 'miss');
    return sendAssetBuffer(request, response, { path: assetPath, assetVersion, buffer, etag });
  } catch (error) {
    return response.status(500).send(error instanceof Error ? error.message : 'Asset failed');
  }
}
