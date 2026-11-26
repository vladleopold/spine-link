/**
 * Normalize Spine JSON mesh attachment fields without assuming a single
 * generation's skin representation. Spine 3.8 uses object-keyed skins; Spine
 * 4.x exports may use an array of named skin records.
 */
export function sanitizeSkeletonJson(json) {
  if (!json || typeof json !== 'object') return json;
  const skins = json.skins;
  const spineVersion = String(json.skeleton?.spine || '');
  // Spine 3.8 runtimes consume the named-skin array representation. Some
  // older 3.8 exports still contain the legacy object keyed by skin name.
  // Normalize only those 3.8 objects; leave 3.7 and other legacy payloads
  // untouched so their matching runtimes retain their native schema.
  if (!Array.isArray(skins) && skins && typeof skins === 'object' &&
      /^3\\.8(?:\\.|$)/.test(spineVersion)) {
    json.skins = Object.entries(skins).map(([name, skin]) => ({
      name,
      attachments: skin && typeof skin === 'object' ? skin : {},
    }));
  }
  const normalizedSkins = json.skins;
  const skinList = Array.isArray(normalizedSkins)
    ? normalizedSkins.map((skin) => skin && typeof skin === 'object' && skin.attachments &&
        typeof skin.attachments === 'object' ? skin.attachments : skin)
    : normalizedSkins && typeof normalizedSkins === 'object'
      ? Object.values(normalizedSkins)
      : [];
  const attachments = skinList.flatMap((skin) => Object.values(skin || {}));
  for (const slotAttachments of attachments) {
    if (!slotAttachments || typeof slotAttachments !== 'object') continue;
    for (const attachment of Object.values(slotAttachments)) {
      if (!attachment || typeof attachment !== 'object') continue;
      const type = attachment.type;
      if (type === 'mesh' || type === 'linkedmesh') {
        if (!attachment.source) {
          if (!Array.isArray(attachment.uvs)) attachment.uvs = [];
          if (!Array.isArray(attachment.vertices)) attachment.vertices = [];
          if (!Array.isArray(attachment.triangles)) attachment.triangles = [];
        }
      }
    }
  }
  return json;
}
