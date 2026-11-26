export function indexedFilePath(file) {
  if (typeof file === 'string') return file;
  if (!file || typeof file !== 'object') return '';
  return String(file.path || file.relativePath || file.filePath || file.name || '');
}

export function previewIndexPath(basePath, entryId) {
  const base = String(basePath || '').replace(/^\/+|\/+$/g, '');
  const id = String(entryId || '').trim();
  if (base === 'library_01') {
    const prefix = id.slice(0, 1).toLowerCase() || '_';
    return `${base}/preview-index/${prefix}.json`;
  }
  return `${base}/index.json`;
}
