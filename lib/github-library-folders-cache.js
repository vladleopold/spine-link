function isRateLimitError(error) {
  const message = String(error?.message || '') + ' ' + String(error?.githubMessage || '');
  return Number(error?.status) === 429 || Number(error?.statusCode) === 429 || /rate limit|secondary rate|abuse detection/i.test(message);
}

/**
 * Short-lived, per-runtime cache for the list of active Spine library folders.
 * Concurrent requests are coalesced, failed refreshes back off using stale
 * data, and invalidation fences off older in-flight scans.
 */
export function createGithubLibraryFoldersCache({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  const pending = new Map();
  const generations = new Map();
  const currentGeneration = key => generations.get(key) || 0;
  const bumpGeneration = key => generations.set(key, currentGeneration(key) + 1);

  async function read(key, loader) {
    const cacheKey = String(key);
    const cached = entries.get(cacheKey);
    if (cached && cached.expiresAt > now()) return [...cached.value];
    const active = pending.get(cacheKey);
    if (active) return [...await active];
    const generation = currentGeneration(cacheKey);
    let request;
    request = Promise.resolve()
      .then(loader)
      .then(value => {
        const result = Array.isArray(value) ? value.map(String) : [];
        if (currentGeneration(cacheKey) === generation) {
          entries.set(cacheKey, { value: result, expiresAt: now() + Math.max(0, Number(ttlMs) || 0) });
        }
        return result;
      })
      .catch(error => {
        // A stale folder list is safer than failing library reads. Back off
        // the next refresh after a quota error so each request doesn't retry.
        if (cached) {
          if (currentGeneration(cacheKey) === generation) {
            cached.expiresAt = now() + Math.max(1000, Number(ttlMs) || 0);
            entries.set(cacheKey, cached);
          }
          return cached.value;
        }
        throw error;
      })
      .finally(() => {
        if (pending.get(cacheKey) === request) pending.delete(cacheKey);
      });
    pending.set(cacheKey, request);
    return [...await request];
  }

  function invalidate(key) {
    const cacheKey = String(key);
    bumpGeneration(cacheKey);
    entries.delete(cacheKey);
    pending.delete(cacheKey);
  }

  function clear() {
    for (const key of new Set([...generations.keys(), ...entries.keys(), ...pending.keys()])) bumpGeneration(key);
    entries.clear();
    pending.clear();
  }

  return { read, invalidate, clear };
}

const globalKey = '__spineLinkGithubLibraryFoldersCache';
export const githubLibraryFoldersCache = globalThis[globalKey] ||
  (globalThis[globalKey] = createGithubLibraryFoldersCache());
