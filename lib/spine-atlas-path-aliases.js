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
        const path = String(attachment.path || attachment.name || attachmentName || '').trim();
        if (!path.includes('/') || seenPaths.has(path)) continue;
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
    if (!basename || regionGroups.has(path)) continue;
    const paths = pathsByBasename.get(basename) || [];
    paths.push(path);
    pathsByBasename.set(basename, paths);
  }

  let changed = false;
  for (const [basename, paths] of pathsByBasename) {
    const matches = regionGroups.get(basename);
    if (!matches?.length) continue;
    paths.forEach((path, index) => {
      if (regionGroups.has(path)) return;
      // When an atlas contains repeated basenames, keep their packed regions
      // separate and pair them with qualified paths in skeleton encounter order.
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
