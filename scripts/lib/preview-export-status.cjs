const PREVIEW_TIERS = [
  ['webmPreview', 'webpPoster'],
  ['webmPreviewMedium', 'webpPosterMedium'],
  ['webmPreviewLow', 'webpPosterLow'],
];

function isHttpAsset(value, extension) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.pathname.toLowerCase().endsWith(extension);
  } catch {
    return false;
  }
}

/**
 * A full export is ready only when the selected animation has at least one
 * same-quality opaque WebM + WebP poster pair. Alpha-only artifacts, metadata,
 * or an orphaned video/poster must never mark the selected preview ready.
 */
function hasSelectedPreviewMedia(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return false;
  return PREVIEW_TIERS.some(([videoKey, posterKey]) =>
    isHttpAsset(preview[videoKey], '.webm') &&
    isHttpAsset(preview[posterKey], '.webp')
  );
}

module.exports = { hasSelectedPreviewMedia };
