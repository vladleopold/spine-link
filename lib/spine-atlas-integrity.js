/** Conservative text-atlas integrity gate. Never decode a random binary blob as
 * a Spine page filename: this caused bogus control-character URLs on 019.atlas.
 * This check is intentionally not a replacement for native rendering.
 */
export function extractAtlasPageNames(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n').map((line) => line.trim());
  const pages = [];
  for (let i = 0; i < lines.length; i += 1) {
    const name = lines[i];
    if (!name || !/\.(png|jpg|jpeg|webp|dds)$/i.test(name) ||
        /^https?:/i.test(name)) continue;
    let next = i + 1;
    while (next < lines.length && !lines[next]) next += 1;
    if (next < lines.length && /^(?:size|format|filter|repeat|pma)\s*:/i.test(lines[next])) {
      pages.push(name);
    }
  }
  return pages;
}

export function atlasPageMatchesTexture(texturePath, pageName) {
  const texture = String(texturePath || '').replace(/\\/g, '/').trim().toLowerCase();
  const page = String(pageName || '').replace(/\\/g, '/').trim().toLowerCase();
  if (!texture || !page) return false;
  const textureBase = texture.split('/').pop();
  const pageBase = page.split('/').pop();
  return Boolean(textureBase && pageBase && textureBase === pageBase &&
    (!page.includes('/') || texture === page || texture.endsWith('/' + page)));
}

export function isValidSpineAtlasHeader(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  if (!source || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(source)) return false;
  return extractAtlasPageNames(source).length > 0;
}

/**
 * Match every atlas page to one distinct source texture. Partial or ambiguous
 * mappings are blocked; callers must not invent transparent placeholder pages.
 */
export function matchAtlasPagesToTextures(atlasPages, textures, matchesPage) {
  if (!Array.isArray(atlasPages) || atlasPages.length === 0 ||
      !Array.isArray(textures) || typeof matchesPage !== 'function') return null;
  const used = new Set();
  const matches = [];
  for (const page of atlasPages) {
    const candidates = textures.filter((texture) => matchesPage(texture, page));
    if (candidates.length !== 1 || used.has(candidates[0])) return null;
    used.add(candidates[0]);
    matches.push(candidates[0]);
  }
  return matches;
}
