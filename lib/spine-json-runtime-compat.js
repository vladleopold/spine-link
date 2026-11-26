import { sanitizeSkeletonJson } from './spine-json-sanitize.js';

const SPINE_38_VERSION = /^3\.8(?:[.-]|$)/;

export function normalizeSpineJsonForLegacy38Runtime(source) {
  const isBuffer = Buffer.isBuffer(source);
  const original = isBuffer ? source.toString('utf8') : String(source ?? '');
  const data = JSON.parse(original);
  const version = String(data?.skeleton?.spine || '').trim();

  // Never rewrite native 4.x or unknown JSON. The compatibility transform is
  // deliberately scoped to the versioned 3.8 preview-asset URL.
  if (!SPINE_38_VERSION.test(version)) return source;

  const before = JSON.stringify(data);
  sanitizeSkeletonJson(data);

  const skins = data.skins;
  if (skins && !Array.isArray(skins) && typeof skins === 'object') {
    data.skins = Object.entries(skins).map(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid Spine 3.8 skin map entry');
      }
      const name = typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : key;
      if (!name) throw new Error('Spine 3.8 skin map entry has no name');
      return { ...value, name };
    });
  }

  const normalized = JSON.stringify(data);
  if (normalized === before) return source;
  return isBuffer ? Buffer.from(normalized, 'utf8') : normalized;
}
