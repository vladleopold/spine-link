export function inspectRuntimeAssetSet(files) {
  const names = Array.isArray(files) ? files.map((f) => String(f || '').toLowerCase()) : [];
  const skeleton = names.some((f) => /\.(?:json|skel)$/i.test(f));
  const atlas = names.some((f) => /\.atlas(?:\.txt)?$/i.test(f));
  const textures = names.some((f) => /\.(?:png|jpe?g|webp|dds)$/i.test(f));
  const invalidPaths = names.some((file) =>
    !file || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..'));
  return {
    accepted: skeleton && atlas && textures && !invalidPaths,
    skeleton, atlas, textures, invalidPaths,
    missing: [
      ...(!skeleton ? ['skeleton'] : []),
      ...(!atlas ? ['atlas'] : []),
      ...(!textures ? ['texture'] : []),
      ...(invalidPaths ? ['unsafe-path'] : []),
    ],
  };
}
