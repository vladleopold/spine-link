// Resolve the preview for the exact URL-selected animation. An explicit query
// always wins; if its media is absent, return no preview instead of substituting
// the indexed default animation.
export function resolvePreviewAnimationTarget(entry = {}, requestedAnimation = '') {
  const name = typeof requestedAnimation === 'string' && requestedAnimation !== ''
    ? requestedAnimation
    : typeof entry?.defaultAnimation === 'string'
      ? entry.defaultAnimation
      : '';
  const previews = entry?.allAnimationPreviews && typeof entry.allAnimationPreviews === 'object'
    ? entry.allAnimationPreviews
    : null;
  const candidate = name && previews ? previews[name] : null;
  return {
    name,
    preview: candidate && typeof candidate === 'object' ? candidate : null,
  };
}
