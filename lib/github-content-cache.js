const textCache = globalThis.__spineLinkGithubTextCache || {
  entries: new Map(),
  bytes: 0,
};
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

function cacheKey(settings, path) {
  return [settings.owner, settings.repo, settings.branch, cleanRepoPath(path)].join('\n');
}

function forgetEntry(key) {
  const cached = textCache.entries.get(key);
  if (!cached) return;
  textCache.bytes = Math.max(0, textCache.bytes - cached.bytes);
  textCache.entries.delete(key);
}

function getEntry(key) {
  const cached = textCache.entries.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    forgetEntry(key);
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
  // ttlMs: 0 is a hard freshness requirement for lookups immediately after
  // publishing. Do not return another invocation's 90-second-old index.
  if (ttlMs > 0) {
    const cached = getEntry(key);
    if (cached !== null) return cached;
  } else {
    // Never leave the obsolete index cached after a forced refresh.
    forgetEntry(key);
  }

  const encodedPath = encodeURIComponent(path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')).replace(/%2F/g, '/');
  const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings.token),
  });
  if (!response.ok) return '';
  const data = await response.json();

  let text = '';
  if (data?.encoding === 'base64' && data?.content) {
    text = base64ToText(data.content);
  } else {
    // The Contents API drops file content above 1 MB (encoding: none).
    // Resolve the same immutable blob by SHA before trying the raw download,
    // so collection indexes keep working as the library grows.
    if (data?.sha) {
      try {
        const blobResponse = await fetch(
          `https://api.github.com/repos/${settings.owner}/${settings.repo}/git/blobs/${encodeURIComponent(data.sha)}`,
          { headers: githubHeaders(settings.token) },
        );
        if (blobResponse.ok) {
          const blob = await blobResponse.json();
          if (blob?.encoding === 'base64' && blob?.content) text = base64ToText(blob.content);
        }
      } catch {
        // Raw download remains the fallback.
      }
    }
    if (!text && data?.download_url) {
      const rawResponse = await fetch(data.download_url, { headers: githubHeaders(settings.token) });
      if (rawResponse.ok) text = await rawResponse.text();
    }
  }
  if (text && ttlMs > 0) putEntry(key, text, ttlMs);
  return text;
}
