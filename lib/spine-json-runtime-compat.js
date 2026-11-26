import { sanitizeSkeletonJson } from './spine-json-sanitize.js';

const SPINE_38_VERSION = /^3\\.8(?:[.-]|$)/;

export function normalizeSpineJsonForLegacy38Runtime(source) {
  const isBuffer = Buffer.isBuffer(source);
  const original = isBuffer ? source.toString('utf8') : String(source ?? '');
  const data = JSON.parse(original);
  const version = String(data?.skeleton?.spine || '').trim();

  // Never rewrite native 4.x or unknown JSON. The compatibility transform is
  // deliberately scoped to the versioned 3.8 preview-asset URL.
  if (!SPINE_38_VERSION.test(version)) return source;

  const before = JSON.stringify(data);
  const skins = data.skins;
  if (skins && !Array.isArray(skins) && typeof skins === 'object') {
    for (const [key, value] of Object.entries(skins)) {
      if (!key || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid Spine 3.8 skin map entry');
      }
    }
  }

  // The shared sanitizer converts legacy object-keyed skins into the official
  // 3.8 [{name, attachments}] representation and fills missing mesh arrays.
  sanitizeSkeletonJson(data);
  const normalized = JSON.stringify(data);
  if (normalized === before) return source;
  return isBuffer ? Buffer.from(normalized, 'utf8') : normalized;
}
