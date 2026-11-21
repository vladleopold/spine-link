const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const SAFE_COLLECTION = /^library(?:_\d+)?$/;

/**
 * Keep derived media beside the source bundle named by the index.
 * New uploads live under library_NN/<id>; 26 existing indexed works still
 * use the legacy root-level <id> path. No other path shape is accepted.
 */
function resolvePreviewWorkPath(basePath, uploadId, previewPath) {
  const base = String(basePath || '').replace(/^\/+|\/+$/g, '');
  const id = String(uploadId || '');
  const fallback = base + '/' + id;
  const candidate = String(previewPath || fallback).replace(/^\/+|\/+$/g, '');
  if (!SAFE_COLLECTION.test(base) || !SAFE_ID.test(id)) {
    throw new Error('UNSAFE_PREVIEW_PATH');
  }
  if (candidate !== fallback && candidate !== id) {
    throw new Error('UNSAFE_PREVIEW_PATH');
  }
  return candidate;
}

module.exports = { resolvePreviewWorkPath };
