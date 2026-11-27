const SPINE_VERSION_PATTERN = /\\?"spine\\?"\s*:\s*\\?"(\d+\.\d+(?:\.\d+)?)/;

export function spineUnityTextAssetVersionFromBase64(base64 = '') {
  const text = Buffer.from(String(base64).replace(/\s/g, ''), 'base64').toString('utf8');
  if (!/^\s*TextAsset Base\b/m.test(text) || !/\bm_Script\s*=/.test(text)) return '';
  return text.match(SPINE_VERSION_PATTERN)?.[1] || '';
}

/**
 * Unity's text-serialized TextAsset dump can contain raw JSON inside the
 * m_Script quoted field (the inner quotes are not escaped). Find the complete
 * JSON value with a string-aware brace scanner instead of parsing the wrapper.
 */
export function extractSpineJsonFromUnityTextAsset(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : Buffer.from(input || []).toString('utf8');
  if (!/^\s*TextAsset Base\b/m.test(text)) {
    throw new Error('The asset is not a Unity text-serialized TextAsset.');
  }
  const scriptField = text.search(/\bm_Script\s*=/);
  if (scriptField < 0) throw new Error('Unity TextAsset does not contain an m_Script field.');
  const start = text.indexOf('{', scriptField);
  if (start < 0) throw new Error('Unity TextAsset m_Script does not contain a JSON object.');

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
      if (depth < 0) break;
    }
  }
  let jsonText = end >= 0 ? text.slice(start, end) : '';
  // Some Unity dumps escape the entire JSON payload as a quoted string.
  // Support that representation too; the raw-object scanner above handles
  // the common TextAsset dump where the inner quotes are not escaped.
  if (!jsonText) {
    const quotedPayload = text.slice(scriptField).match(/\bm_Script\s*=\s*("(?:\\.|[^"\\])*")/s);
    if (quotedPayload) {
      try {
        jsonText = JSON.parse(quotedPayload[1]);
      } catch {
        jsonText = '';
      }
    }
  }
  if (!jsonText) throw new Error('Unity TextAsset m_Script contains incomplete Spine JSON.');

  let skeleton;
  try {
    skeleton = JSON.parse(jsonText);
  } catch {
    throw new Error('Unity TextAsset m_Script does not contain valid Spine JSON.');
  }
  const version = skeleton?.skeleton?.spine;
  if (!skeleton || typeof skeleton !== 'object' || typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error('Unity TextAsset payload is not a versioned Spine skeleton.');
  }
  return JSON.stringify(skeleton);
}
