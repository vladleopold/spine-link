function fileName(value) {
  let path = String(value || '');
  try {
    path = new URL(path).pathname;
  } catch {}
  try {
    path = decodeURIComponent(path);
  } catch {}
  return path.split(String.fromCharCode(92)).join('/').split('/').filter(Boolean).pop() || '';
}

// Resolve only the one skeleton/atlas pair named by the index. Basenames are
// retained for legacy index compatibility; ambiguity and missing references
// fail closed. A sole discovered set is safe only when no source names exist.
export function resolveIndexedPreviewSet(sets, entry) {
  const skeleton = fileName(entry?.skeleton);
  const atlas = fileName(entry?.atlas);
  const available = Array.isArray(sets) ? sets : [];
  if (!skeleton && !atlas) return available.length === 1 ? available[0] : null;

  const matches = available.filter((set) => {
    const skeletonMatches = !skeleton || fileName(set?.skeleton) === skeleton;
    const atlasMatches = !atlas || fileName(set?.atlasUrl || set?.atlas) === atlas;
    return skeletonMatches && atlasMatches;
  });
  return matches.length === 1 ? matches[0] : null;
}
