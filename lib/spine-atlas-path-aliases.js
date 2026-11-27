/**
 * Spine 4.3 exports may retain folder-qualified attachment paths in skeleton
 * JSON while the packed atlas contains only each image's basename. The native
 * runtime performs exact region-name lookup, so add lossless atlas aliases for
 * those paths instead of rewriting skeleton data or fabricating attachments.
 *
 * The parser intentionally preserves page and region property lines verbatim.
 */
export function addSpineAtlasPathAliases(atlasText, skeletonJson) {
  const source = String(atlasText || '');
  if (!source || !skeletonJson || typeof skeletonJson !== 'object') return source;

  const requestedPaths = [];
  const seenPaths = new Set();
  const skins = Array.isArray(skeletonJson.skins)
    ? skeletonJson.skins
    : Object.values(skeletonJson.skins || {});
  for (const skin of skins) {
    const attachments = skin && typeof skin === 'object' ? skin.attachments : null;
    if (!attachments || typeof attachments !== 'object') continue;
    for (const slotAttachments of Object.values(attachments)) {
      if (!slotAttachments || typeof slotAttachments !== 'object') continue;
      for (const [attachmentName, attachment] of Object.entries(slotAttachments)) {
        if (!attachment || typeof attachment !== 'object') continue;
        const path = String(attachment.path || attachmentName || '').trim();
        if (!path || seenPaths.has(path)) continue;
        seenPaths.add(path);
        requestedPaths.push(path);
      }
    }
  }
  if (!requestedPaths.length) return source;

  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const pages = [];
  let page = null;
  let region = null;
  let inPageProperties = false;

  const finishRegion = () => {
    if (!region || !page) return;
    page.regions.push(region);
    region = null;
  };
  const finishPage = () => {
    finishRegion();
    if (page) pages.push(page);
    page = null;
    inPageProperties = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      finishPage();
      continue;
    }
    const isProperty = /^[^:]+:\s*.*$/.test(trimmed);
    if (!page) {
      page = { header: line, pageProperties: [], regions: [] };
      inPageProperties = true;
      continue;
    }
    if (inPageProperties && isProperty) {
      page.pageProperties.push(line);
      continue;
    }
    inPageProperties = false;
    if (isProperty && region) {
      region.properties.push(line);
      continue;
    }
    if (isProperty && !region) {
      // A page property after region parsing has begun is malformed atlas text;
      // retain it as page metadata rather than dropping it.
      page.pageProperties.push(line);
      continue;
    }
    finishRegion();
    region = { name: trimmed, header: line, properties: [] };
  }
  finishPage();
  if (!pages.length) return source;

  const regionGroups = new Map();
  for (const currentPage of pages) {
    for (const currentRegion of currentPage.regions) {
      const group = regionGroups.get(currentRegion.name) || [];
      group.push({ page: currentPage, region: currentRegion });
      regionGroups.set(currentRegion.name, group);
    }
  }

  const pathsByBasename = new Map();
  for (const path of requestedPaths) {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (!basename) continue;
    let atlasName = basename;
    let matches = regionGroups.get(atlasName);
    if (!matches?.length) {
      const caseMatches = [...regionGroups.keys()].filter((name) => name.toLowerCase() === basename.toLowerCase());
      if (caseMatches.length === 1) {
        atlasName = caseMatches[0];
        matches = regionGroups.get(atlasName);
      }
    }
    if (!matches?.length || (!path.includes('/') && matches.length === 1)) continue;
    const paths = pathsByBasename.get(atlasName) || [];
    paths.push(path);
    pathsByBasename.set(atlasName, paths);
  }

  let changed = false;
  for (const [basename, paths] of pathsByBasename) {
    const matches = regionGroups.get(basename);
    if (!matches?.length) continue;

    // If every duplicate packed region has a corresponding attachment path,
    // rename the ambiguous basename records internally and expose a unique
    // alias for every actual skeleton path, including unqualified names.
    // This is needed when multiple skin folders contain e.g. l_leg_upper.
    const canDisambiguateAll = matches.length > 1 && paths.length >= matches.length;
    if (canDisambiguateAll) {
      matches.forEach((match, index) => {
        const internalName = '__spine_link_atlas_source_' + index + '_' + basename;
        match.region.name = internalName;
        match.region.header = internalName;
      });
      regionGroups.delete(basename);
    }

    paths.forEach((path, index) => {
      if (regionGroups.has(path)) return;
      // Repeated basenames are paired with skin paths in skeleton encounter
      // order; a single basename match is safely shared by all folder aliases.
      const match = matches[Math.min(index, matches.length - 1)];
      const alias = {
        name: path,
        header: path,
        properties: [...match.region.properties],
      };
      match.page.regions.push(alias);
      regionGroups.set(path, [{ page: match.page, region: alias }]);
      changed = true;
    });
  }
  if (!changed) return source;

  return pages.map((currentPage) => [
    currentPage.header,
    ...currentPage.pageProperties,
    ...currentPage.regions.flatMap((currentRegion) => [
      currentRegion.header || currentRegion.name,
      ...currentRegion.properties,
    ]),
  ].join('\n')).join('\n\n') + (source.endsWith('\n') ? '\n' : '');
}
