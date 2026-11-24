const DEFAULT_TTL_MS = 15_000;

function cacheKey(settings, path) {
  return [
    String(settings?.owner || ''),
    String(settings?.repo || ''),
    String(settings?.branch || ''),
    String(path || '').trim().replace(/^\/+|\/+$/g, '').replace(/\/+ /g, '/'),
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
  const message = String(error?.message || '');
  return /rate limit|secondary rate|abuse detection/i.test(message);
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

  function invalidate(settings, path) {
    const key = cacheKey(settings, path);
    entries.delete(key);
  }

  function set(settings, path, current, metrics) {
    const key = cacheKey(settings, path);
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
        if (cached && isRateLimitError(error)) return { ...snapshot(cached), stale: true };
        throw error;
      }
    }

    const request = Promise.resolve()
      .then(loader)
      .then((loaded) => {
        const value = {
          current: loaded?.current?.sha ? { sha: String(loaded.current.sha) } : null,
          metrics: cloneJson(loaded?.metrics || { entries: {} }),
          ...(loaded?.stale ? { stale: true } : {}),
        };
        entries.set(key, { ...value, expiresAt: now() + Math.max(0, Number(ttlMs) || 0) });
        return value;
      })
      .finally(() => pending.delete(key));

    pending.set(key, request);
    try {
      return snapshot(await request);
    } catch (error) {
      // Metrics are non-critical to preview playback. If GitHub rate-limits a
      // warm instance, serve its last known counts and let the caller defer
      // writes rather than turning a preview view into a 500 response.
      if (cached && isRateLimitError(error)) return { ...snapshot(cached), stale: true };
      throw error;
    }
  }

  function clear() {
    entries.clear();
    pending.clear();
  }

  return { read, set, invalidate, clear };
}

const globalCacheKey = '__spineLinkGithubMetricsCache';
export const githubMetricsCache = globalThis[globalCacheKey] ||
  (globalThis[globalCacheKey] = createGithubMetricsCache());
