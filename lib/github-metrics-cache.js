const DEFAULT_TTL_MS = 15_000;

function cacheKey(settings, path) {
  return [
    String(settings?.owner || ''),
    String(settings?.repo || ''),
    String(settings?.branch || ''),
    String(path || '').trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/'),
  ].join('\n');
}

function cloneJson(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function snapshot(value) {
  return {
    current: value.current?.sha ? { sha: value.current.sha } : null,
    metrics: cloneJson(value.metrics),
    ...(value.stale ? { stale: true } : {}),
  };
}

function isRateLimitError(error) {
  const message = `${String(error?.message || '')} ${String(error?.githubMessage || '')}`;
  return Number(error?.status) === 429 || /rate limit|secondary rate|abuse detection/i.test(message);
}

/**
 * Per-instance cache for GitHub-backed preview metrics.
 *
 * The metrics file is shared across preview requests. Re-reading it from the
 * GitHub Contents API on every view/like exhausted the user's API quota. Keep
 * a short-lived snapshot (including its SHA) and refresh it after successful
 * writes. A SHA conflict invalidates the snapshot and the caller can retry.
 */
export function createGithubMetricsCache({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  const pending = new Map();
  // A generation fences off in-flight reads started before a write or SHA
  // conflict. Without it, an old Contents response can repopulate the cache
  // after invalidate()/set() and make the next writer reuse an obsolete SHA.
  const generations = new Map();

  function generation(key) {
    return generations.get(key) || 0;
  }

  function bumpGeneration(key) {
    generations.set(key, generation(key) + 1);
  }

  function invalidate(settings, path) {
    const key = cacheKey(settings, path);
    bumpGeneration(key);
    entries.delete(key);
    // A new reader must not join an older in-flight request after a conflict.
    // The old promise may still resolve for its original callers, but cannot
    // repopulate the cache because its captured generation is now stale.
    pending.delete(key);
  }

  function set(settings, path, current, metrics) {
    const key = cacheKey(settings, path);
    bumpGeneration(key);
    // A successful write supersedes every read started before that write.
    pending.delete(key);
    const sha = String(current?.sha || '');
    if (!sha) {
      entries.delete(key);
      return;
    }
    entries.set(key, {
      current: { sha },
      metrics: cloneJson(metrics),
      expiresAt: now() + Math.max(0, Number(ttlMs) || 0),
    });
  }

  async function read(settings, path, loader) {
    const key = cacheKey(settings, path);
    const cached = entries.get(key);
    const time = now();

    if (cached && cached.expiresAt > time) return snapshot(cached);

    if (pending.has(key)) {
      try {
        return snapshot(await pending.get(key));
      } catch (error) {
        const latestCached = entries.get(key);
        if (latestCached && isRateLimitError(error)) return { ...snapshot(latestCached), stale: true };
        throw error;
      }
    }

    const readGeneration = generation(key);
    let request;
    request = Promise.resolve()
      .then(loader)
      .then((loaded) => {
        const value = {
          current: loaded?.current?.sha ? { sha: String(loaded.current.sha) } : null,
          metrics: cloneJson(loaded?.metrics || { entries: {} }),
          ...(loaded?.stale ? { stale: true } : {}),
        };
        // Never let a pre-write/pre-invalidation response overwrite a newer
        // SHA or metrics snapshot.
        if (generation(key) === readGeneration) {
          entries.set(key, { ...value, expiresAt: now() + Math.max(0, Number(ttlMs) || 0) });
        }
        return value;
      })
      .finally(() => {
        // An older request must not delete a newer request installed after
        // invalidate() or set().
        if (pending.get(key) === request) pending.delete(key);
      });

    pending.set(key, request);
    try {
      return snapshot(await request);
    } catch (error) {
      // Metrics are non-critical to preview playback. If GitHub rate-limits a
      // warm instance, serve its last known counts and let the caller defer
      // writes rather than turning a preview view into a 500 response.
      const latestCached = entries.get(key);
      if (latestCached && isRateLimitError(error)) return { ...snapshot(latestCached), stale: true };
      throw error;
    }
  }

  function clear() {
    // In-flight promises can still settle after clear(); bump every known
    // generation so none of them can repopulate the cache.
    for (const key of new Set([...generations.keys(), ...entries.keys(), ...pending.keys()])) {
      bumpGeneration(key);
    }
    entries.clear();
    pending.clear();
  }

  return { read, set, invalidate, clear };
}

const globalCacheKey = '__spineLinkGithubMetricsCache';
export const githubMetricsCache = globalThis[globalCacheKey] ||
  (globalThis[globalCacheKey] = createGithubMetricsCache());
