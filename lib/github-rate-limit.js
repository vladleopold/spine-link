export function isGitHubRateLimitResponse(response, message = '') {
  const status = Number(response?.status) || 0;
  if (status === 429) return true;
  if (status !== 403) return false;

  const headers = response?.headers;
  const remaining = headers?.get?.('x-ratelimit-remaining');
  const retryAfter = headers?.get?.('retry-after');
  const detail = String(message || '').toLowerCase();

  return remaining === '0' ||
    (retryAfter !== null && retryAfter !== undefined && String(retryAfter).trim() !== '') ||
    /rate limit exceeded|secondary rate limit|abuse detection/.test(detail);
}

export function githubRetryAfterSeconds(response, nowMs = Date.now()) {
  const headers = response?.headers;
  const retryAfter = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);

  const reset = Number(headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.ceil(reset - nowMs / 1000));
  }
  return null;
}

export function shouldRetryGitHubResponse(response, message = '') {
  if (!response || isGitHubRateLimitResponse(response, message)) return false;
  return [408, 500, 502, 503, 504].includes(Number(response.status));
}

export function githubErrorForResponse({ verb, path, response, message: detail = '', nowMs = Date.now() }) {
  const status = Number(response?.status) || 0;
  const error = new Error(`Storage ${verb} failed for ${path}: ${status}`);
  if (isGitHubRateLimitResponse(response, detail)) {
    error.statusCode = 429;
    const retryAfter = githubRetryAfterSeconds(response, nowMs);
    if (retryAfter !== null) error.retryAfter = retryAfter;
  } else {
    error.statusCode = status >= 400 ? status : 500;
  }
  return error;
}
