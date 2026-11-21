/** Conservative text-atlas integrity gate. Never decode a random binary blob as
 * a Spine page filename: this caused bogus control-character URLs on 019.atlas.
 * This check is intentionally not a replacement for native rendering.
 */
export function isValidSpineAtlasHeader(text) {
  const source=String(text||'').replace(/^\uFEFF/,'');
  if(!source||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(source))return false;
  const lines=source.replace(/\r\n?/g,'\n').split('\n').map(x=>x.trim());
  return lines.some((line,i)=>{
    if(!/\.(png|jpg|jpeg|webp|dds)$/i.test(line)||line.includes('/')&&line.startsWith('http'))return false;
    const following=lines.slice(i+1,i+8).join('\n');
    return /(?:size|format|filter|repeat|pma)\s*:/i.test(following);
  });
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
