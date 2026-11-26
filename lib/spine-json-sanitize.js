/**
 * Normalize Spine JSON mesh attachment fields without assuming a single
 * generation's skin representation. Spine 3.8 uses object-keyed skins; Spine
 * 4.x exports may use an array of named skin records.
 */
export function sanitizeSkeletonJson(json) {
  if (!json || typeof json !== 'object') return json;
  const skins = json.skins;
  const skinList = Array.isArray(skins)
    ? skins
    : skins && typeof skins === 'object'
      ? Object.values(skins)
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
