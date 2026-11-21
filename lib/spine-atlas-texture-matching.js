// Resolve every atlas page to one distinct source texture. A sole texture
// may serve a sole page when the page name is unavailable, but never multiple
// pages. Ambiguous and missing matches fail closed.
export function matchAtlasPageTextures(atlasPages, textures, imageMatchesAtlasPage) {
  if (!Array.isArray(atlasPages) || atlasPages.length === 0 ||
      !Array.isArray(textures) || textures.length === 0 ||
      typeof imageMatchesAtlasPage !== "function") return null;

  const used = new Set();
  const matched = [];
  for (const pageName of atlasPages) {
    const candidates = textures.filter((texture) =>
      texture && typeof texture.name === "string" &&
      imageMatchesAtlasPage(texture.name, pageName)
    );
    let selected = null;
    if (candidates.length === 1) selected = candidates[0];
    else if (candidates.length === 0 && atlasPages.length === 1 && textures.length === 1) {
      selected = textures[0];
    }
    if (!selected) return null;

    const identity = String(selected.path || selected.name || "");
    if (!identity || used.has(identity)) return null;
    used.add(identity);
    matched.push(selected);
  }
  return matched;
}
