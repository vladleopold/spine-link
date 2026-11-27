const SPINE_VERSION_PATTERN = /\\?"spine\\?"\\s*:\\s*\\?"(\\d+\\.\\d+(?:\\.\\d+)?)/;

export function spineUnityTextAssetVersionFromBase64(base64 = '') {
  const text = Buffer.from(String(base64).replace(/\\s/g, ''), 'base64').toString('utf8');
  if (!/^\\s*TextAsset Base\\b/m.test(text) || !/\\bm_Script\\s*=/.test(text)) return '';
  return text.match(SPINE_VERSION_PATTERN)?.[1] || '';
}

/**
 * Unity text-serialized TextAsset files can wrap a Spine JSON document inside
 * the quoted m_Script field while retaining a misleading .skel extension.
 */
export function extractSpineJsonFromUnityTextAsset(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : Buffer.from(input || []).toString('utf8');
  if (!/^\\s*TextAsset Base\\b/m.test(text)) {
    throw new Error('The asset is not a Unity text-serialized TextAsset.');
  }
  const match = text.match(/\\bm_Script\\s*=\\s*("(?:\\\\.|[^"\\\\])*")/s);
  if (!match) throw new Error('Unity TextAsset does not contain a quoted m_Script payload.');

  let payload;
  let skeleton;
  try {
    payload = JSON.parse(match[1]);
    skeleton = JSON.parse(payload);
  } catch {
    throw new Error('Unity TextAsset m_Script does not contain valid Spine JSON.');
  }
  const version = skeleton?.skeleton?.spine;
  if (!skeleton || typeof skeleton !== 'object' || typeof version !== 'string' || !/^\\d+\\.\\d+(?:\\.\\d+)?$/.test(version)) {
    throw new Error('Unity TextAsset payload is not a versioned Spine skeleton.');
  }
  return JSON.stringify(skeleton);
}
