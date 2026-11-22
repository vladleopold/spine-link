// Classify an archive card from its own media and the source index status.
// A blank card is valid only when the source explicitly records a blocked/failed
// preview; "ready" or "pending" source metadata must never disappear silently.
export function classifyArchiveCardMediaState(card = {}) {
  const hasPoster = typeof card.poster === 'string' && card.poster.trim().length > 0;
  const hasVideo = typeof card.video === 'string' && card.video.trim().length > 0;
  const webmStatus = typeof card.sourceWebmStatus === 'string' ? card.sourceWebmStatus.trim() : '';
  const previewStatus = typeof card.sourcePreviewStatus === 'string' ? card.sourcePreviewStatus.trim() : '';

  if (!hasPoster && !hasVideo) {
    const explicitlyBlocked = (webmStatus === 'blocked' || webmStatus.startsWith('blocked-')) &&
      previewStatus === 'blocked';
    if (explicitlyBlocked) return 'blocked';
    const explicitlyFailed = (webmStatus === 'failed' || webmStatus === 'error') &&
      (previewStatus === 'failed' || previewStatus === 'error');
    if (explicitlyFailed) return 'failed';
    return 'missing';
  }

  if (hasPoster !== hasVideo) return 'partial';
  if (webmStatus !== 'ready' || previewStatus !== 'ready') return 'stale-media';
  return 'ready';
}
