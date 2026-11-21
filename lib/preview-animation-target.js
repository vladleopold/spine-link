// Resolve the preview for the exact URL-selected animation. An explicit query
// always wins; if its media is absent, return no preview instead of substituting
// the indexed default animation.
export function resolvePreviewAnimationTarget(entry = {}, requestedAnimation = '') {
  // Missing/empty query uses the indexed default. An explicit multi-valued or
  // non-string query is ambiguous and must block instead of falling back.
  const hasExplicitSelection = requestedAnimation !== '' &&
    requestedAnimation !== undefined &&
    requestedAnimation !== null;
  const name = hasExplicitSelection
    ? (typeof requestedAnimation === 'string' ? requestedAnimation : '')
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


// Preserve the complete query cardinality. URLSearchParams.get() silently
// selects the first repeated value, which could make an ambiguous URL appear
// to have a valid selected animation.
export function requestedAnimationFromRequest(request = {}, origin = 'https://spine-link.invalid') {
  const queryValue = request?.query?.animation;
  if (queryValue !== undefined) return queryValue;
  const values = new URL(request?.url || '/', origin).searchParams.getAll('animation');
  return values.length > 1 ? values : (values[0] ?? '');
}
