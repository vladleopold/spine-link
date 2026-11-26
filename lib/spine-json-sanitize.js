/**
 * Normalize Spine JSON mesh attachment fields without assuming a single
 * generation's skin representation. Spine 3.8 uses object-keyed skins; Spine
 * 4.x exports use array skin records. The official 3.8 runtime requires each
 * legacy map entry to become {name, attachments}, not a spread of slot keys.
 */
const SPINE_38_VERSION = /^3\\.8(?:[.-]|$)/;
const SKIN_METADATA_KEYS = new Set(['bones', 'ik', 'transform', 'path', 'physics']);

function legacy38SkinRecord(key, value) {
  if (!key || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Spine 3.8 skin map entry');
  }
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim()
    : key;
  const attachments = {};
  const metadata = {};
  for (const [property, child] of Object.entries(value)) {
    if (property === 'name') continue;
    if (property === 'attachments') {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        throw new Error('Invalid Spine 3.8 skin attachments');
      }
      Object.assign(attachments, child);
    } else if (SKIN_METADATA_KEYS.has(property)) {
      metadata[property] = child;
    } else {
      attachments[property] = child;
    }
  }
  return { ...metadata, name, attachments };
}

export function sanitizeSkeletonJson(json) {
  if (!json || typeof json !== 'object') return json;
  const version = String(json?.skeleton?.spine || '').trim();
  const skins = json.skins;
  if (SPINE_38_VERSION.test(version) && skins && !Array.isArray(skins) &&
      typeof skins === 'object') {
    json.skins = Object.entries(skins).map(([key, value]) => legacy38SkinRecord(key, value));
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
