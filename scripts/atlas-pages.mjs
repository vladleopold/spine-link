export function chooseAtlasForSkeleton(skeletonName, atlasNames) {
  const stem = normalizedStem(skeletonName);
  const matches = (Array.isArray(atlasNames) ? atlasNames : [])
    .filter((name) => /\.atlas(?:\.txt|\.docx)?$/i.test(String(name)));
  const exact = matches.find((name) => normalizedStem(name) === stem);
  if (exact) return exact;
  return matches.length === 1 ? matches[0] : null;
}

function normalizedStem(value) {
  let source = String(value || '').trim().replace(/\\/g, '/');
  source = source.split('/').filter(Boolean).pop() || '';
  return source.replace(/\.atlas(?:\.txt|\.docx)?$/i, '').replace(/\.(?:json|skel)$/i, '').toLowerCase();
}
