/**
 * Short-lived, per-runtime cache for the list of active Spine library folders.
 * It coalesces concurrent requests and keeps the last good snapshot available
 * when GitHub temporarily rate-limits a refresh.
 */
export function createGithubLibraryFoldersCache({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  const pending = new Map();

  async function read(key, loader) {
    const cacheKey = String(key);
    const cached = entries.get(cacheKey);
    if (cached && cached.expiresAt > now()) return [...cached.value];

    const active = pending.get(cacheKey);
    if (active) return [...await active];

    let request;
    request = Promise.resolve()
      .then(loader)
      .then(value => {
        const result = Array.isArray(value) ? value.map(String) : [];
        entries.set(cacheKey, {
          value: result,
          expiresAt: now() + Math.max(0, Number(ttlMs) || 0),
        });
        return result;
      })
      .catch(error => {
        // A stale folder list is safer than failing library reads or routing
        // every upload into a hard-coded fallback during a GitHub outage.
        if (cached) return cached.value;
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
    entries.delete(cacheKey);
    pending.delete(cacheKey);
  }

  function clear() {
    entries.clear();
    pending.clear();
  }

  return { read, invalidate, clear };
}

const globalKey = '__spineLinkGithubLibraryFoldersCache';
export const githubLibraryFoldersCache = globalThis[globalKey] ||
  (globalThis[globalKey] = createGithubLibraryFoldersCache());
