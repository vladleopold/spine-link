const textCache = globalThis.__spineLinkGithubTextCache || {
  entries: new Map(),
  bytes: 0,
  generations: new Map(),
};
if (!(textCache.generations instanceof Map)) textCache.generations = new Map();
globalThis.__spineLinkGithubTextCache = textCache;

const defaultTtlMs = 90 * 1000;
const maxEntries = 96;
const maxBytes = 16 * 1024 * 1024;
const maxObjectBytes = 4 * 1024 * 1024;

function cleanRepoPath(value = '') {
  return String(value).trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function base64ToText(base64) {
  return Buffer.from(String(base64).replace(/\s/g, ''), 'base64').toString('utf8');
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
  // Public Spine assets remain readable even if the configured PAT is
  // temporarily rate-limited or its read scope is stale. Retry anonymously.
  if (!response.ok && token && (response.status === 401 || response.status === 403)) {
    response = await fetch(url, { headers: githubHeaders('') });
  }
  return response;
}

function cacheKey(settings, path) {
  return [settings.owner, settings.repo, settings.branch, cleanRepoPath(path)].join('\n');
}

function withCacheBust(url, enabled) {
  if (!enabled) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

function forgetEntry(key) {
  const cached = textCache.entries.get(key);
  if (!cached) return;
  textCache.bytes = Math.max(0, textCache.bytes - cached.bytes);
  textCache.entries.delete(key);
}

function currentGeneration(key) {
  return textCache.generations.get(key) || 0;
}

function invalidateEntry(key) {
  textCache.generations.set(key, currentGeneration(key) + 1);
  forgetEntry(key);
}

function putEntryIfCurrent(key, value, ttlMs, generation) {
  if (currentGeneration(key) === generation) putEntry(key, value, ttlMs);
}

function getEntry(key) {
  const cached = textCache.entries.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    invalidateEntry(key);
    return null;
  }
  textCache.entries.delete(key);
  textCache.entries.set(key, cached);
  return cached.value;
}

function putEntry(key, value, ttlMs) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxObjectBytes) return;
  forgetEntry(key);
  textCache.entries.set(key, {
    bytes,
    value,
    expiresAt: Date.now() + ttlMs,
  });
  textCache.bytes += bytes;

  while (textCache.entries.size > maxEntries || textCache.bytes > maxBytes) {
    const oldestKey = textCache.entries.keys().next().value;
    if (!oldestKey) break;
    forgetEntry(oldestKey);
  }
}

export async function cachedGithubText(settings, path, options = {}) {
  const ttlMs = options.ttlMs === undefined ? defaultTtlMs : Math.max(0, Number(options.ttlMs) || 0);
  const key = cacheKey(settings, path);
  if (ttlMs > 0) {
    const cached = getEntry(key);
    if (cached !== null) return cached;
  } else {
    // A forced refresh also fences off older in-flight reads.
    invalidateEntry(key);
  }
  const generation = currentGeneration(key);
  const encodedPath = encodeURIComponent(cleanRepoPath(path)).replace(/%2F/g, '/');
  if (options.preferRaw === true) {
    const rawUrl = withCacheBust('https://raw.githubusercontent.com/' + settings.owner + '/' + settings.repo + '/' + encodeURIComponent(settings.branch).replace(/%2F/g, '/') + '/' + encodedPath, options.cacheBust === true);
    try {
      const rawResponse = await fetch(rawUrl, { signal: AbortSignal.timeout(12000) });
      if (rawResponse.ok) {
        const text = await rawResponse.text();
        if (text && ttlMs > 0) putEntryIfCurrent(key, text, ttlMs, generation);
        return text;
      }
    } catch { /* Continue with the Contents API fallback. */ }
  }
  const apiUrl = 'https://api.github.com/repos/' + settings.owner + '/' + settings.repo + '/contents/' + encodedPath + '?ref=' + encodeURIComponent(settings.branch);
  const response = await githubApiFetch(apiUrl, settings.token);
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    const rawUrl = withCacheBust('https://raw.githubusercontent.com/' + settings.owner + '/' + settings.repo + '/' + encodeURIComponent(settings.branch) + '/' + encodedPath, options.cacheBust === true);
    const rawResponse = await fetch(rawUrl, { signal: AbortSignal.timeout(12000) });
    if (!rawResponse.ok) return '';
    const text = await rawResponse.text();
    if (text && ttlMs > 0) putEntryIfCurrent(key, text, ttlMs, generation);
    return text;
  }
  if (!response.ok) return '';
  const data = await response.json();
  let text = '';
  if (data?.encoding === 'base64' && data?.content) {
    text = base64ToText(data.content);
  } else {
    if (data?.sha) {
      try {
        const blobResponse = await githubApiFetch('https://api.github.com/repos/' + settings.owner + '/' + settings.repo + '/git/blobs/' + encodeURIComponent(data.sha), settings.token);
        if (blobResponse.ok) {
          const blob = await blobResponse.json();
          if (blob?.encoding === 'base64' && blob?.content) text = base64ToText(blob.content);
        }
      } catch { /* Raw download remains the fallback. */ }
    }
    if (!text) {
      const rawUrl = withCacheBust(data?.download_url || ('https://raw.githubusercontent.com/' + settings.owner + '/' + settings.repo + '/' + encodeURIComponent(settings.branch).replace(/%2F/g, '/') + '/' + encodedPath), options.cacheBust === true);
      let rawResponse = await fetch(rawUrl, { headers: githubHeaders(settings.token), signal: AbortSignal.timeout(12000) });
      if (!rawResponse.ok && settings.token && (rawResponse.status === 401 || rawResponse.status === 403)) rawResponse = await fetch(rawUrl, { signal: AbortSignal.timeout(12000) });
      if (rawResponse.ok) text = await rawResponse.text();
    }
  }
  if (text && ttlMs > 0) putEntryIfCurrent(key, text, ttlMs, generation);
  return text;
}

/** Remove a cached public file after a successful GitHub write. */
export function invalidateCachedGithubText(settings, path) {
  invalidateEntry(cacheKey(settings, path));
}
