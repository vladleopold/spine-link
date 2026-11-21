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

function fileStem(value) {
  return fileName(value).replace(/\.(?:skel|bytes|json|atlas(?:\.txt|\.docx)?)$/i, '').toLowerCase();
}

function isRuntimeSkeletonFile(file) {
  const name = fileName(file?.name);
  if (!/\.(?:skel|bytes|json)$/i.test(name)) return false;
  return !/^(?:config|metadata|manifest|settings|package|player-config)\.json$/i.test(name);
}

function isAtlasFile(file) {
  return /\.atlas(?:\.txt|\.docx)?$/i.test(fileName(file?.name));
}

// Resolve a source pair from index metadata first. Without indexed names, a
// directory is eligible only when one skeleton and one atlas are unambiguous.
export function resolveIndexedSpineSourceFiles(files, entry) {
  const items = (Array.isArray(files) ? files : []).filter((file) =>
    file && typeof file.name === 'string' && (file.type === undefined || file.type === 'file')
  );
  const skeletons = items.filter(isRuntimeSkeletonFile);
  const atlases = items.filter(isAtlasFile);
  const requestedSkeleton = fileName(entry?.skeleton || entry?.skeletonFile).toLowerCase();
  const requestedAtlas = fileName(entry?.atlas || entry?.atlasFile).toLowerCase();

  let skeletonCandidates = requestedSkeleton
    ? skeletons.filter((file) => fileName(file.name).toLowerCase() === requestedSkeleton)
    : skeletons;
  let atlasCandidates = requestedAtlas
    ? atlases.filter((file) => fileName(file.name).toLowerCase() === requestedAtlas)
    : atlases;

  if (requestedSkeleton && skeletonCandidates.length !== 1) return null;
  if (requestedAtlas && atlasCandidates.length !== 1) return null;

  if (!requestedSkeleton && requestedAtlas) {
    const stem = fileStem(atlasCandidates[0].name);
    const matching = skeletons.filter((file) => fileStem(file.name) === stem);
    skeletonCandidates = matching.length ? matching : skeletons.length === 1 ? skeletons : [];
  } else if (requestedSkeleton && !requestedAtlas) {
    const stem = fileStem(skeletonCandidates[0].name);
    const matching = atlases.filter((file) => fileStem(file.name) === stem);
    atlasCandidates = matching.length ? matching : atlases.length === 1 ? atlases : [];
  }

  if (!requestedSkeleton && !requestedAtlas &&
      (skeletons.length !== 1 || atlases.length !== 1)) return null;
  if (skeletonCandidates.length !== 1 || atlasCandidates.length !== 1) return null;
  return { skeleton: skeletonCandidates[0], atlas: atlasCandidates[0] };
}

// Resolve only the one skeleton/atlas pair named by the index. Basenames are
// retained for legacy index compatibility; ambiguity and missing references
// fail closed. A sole discovered set is safe only when no source names exist.
export function resolveIndexedPreviewSet(sets, entry) {
  const skeleton = fileName(entry?.skeleton || entry?.skeletonFile);
  const atlas = fileName(entry?.atlas || entry?.atlasFile);
  const available = Array.isArray(sets) ? sets : [];
  if (!skeleton && !atlas) return available.length === 1 ? available[0] : null;

  const matches = available.filter((set) => {
    const skeletonMatches = !skeleton || fileName(set?.skeleton) === skeleton;
    const atlasMatches = !atlas || fileName(set?.atlasUrl || set?.atlas) === atlas;
    return skeletonMatches && atlasMatches;
  });
  return matches.length === 1 ? matches[0] : null;
}
