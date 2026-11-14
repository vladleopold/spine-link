/**
 * Spine Editor project import. Project .spine is SOURCE, never a runtime
 * .skel: the licensed Spine Editor exporter must generate JSON+atlas first.
 * Relative image paths are retained so original attachment names survive.
 */
const relativePaths = new WeakMap();

export function rememberProjectFilePath(file, path) {
  if (file && typeof file === 'object') relativePaths.set(file, String(path || ''));
  return file;
}

export function projectFilePath(file) {
  return relativePaths.get(file) || String(file?.webkitRelativePath || file?.name || '');
}

export function isSpineProjectFile(file) {
  return /\.spine$/i.test(String(file?.name || ''));
}

export function isSpineImageFile(file) {
  return /\.(png|jpe?g|webp)$/i.test(String(file?.name || ''));
}

function safeParts(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || /[\0-\x1f]/.test(part))) {
    throw new Error('Invalid relative image path');
  }
  return parts;
}

export function normalizeProjectPath(file, relativePath = projectFilePath(file)) {
  if (isSpineProjectFile(file)) {
    const name = safeParts(file.name).pop();
    if (!name) throw new Error('Invalid Spine project name');
    return name;
  }
  if (!isSpineImageFile(file)) throw new Error('Only image assets can be used inside images/');
  const parts = safeParts(relativePath);
  if (!parts.length) throw new Error('Missing image path');
  const root = parts.findIndex(part => part.toLowerCase() === 'images');
  const suffix = root >= 0 ? parts.slice(root + 1) : parts.length > 1 ? parts.slice(1) : parts;
  if (!suffix.length) throw new Error('Empty images folder');
  const normalized = ['images', ...suffix].join('/');
  if (normalized.length > 500) throw new Error('Image path is too long');
  return normalized;
}

export function validateProjectSelection(files) {
  const projectFiles = files.filter(isSpineProjectFile);
  const images = files.filter(isSpineImageFile);
  if (projectFiles.length !== 1) throw new Error('Select exactly one .spine project');
  if (!images.length) throw new Error('Select the images folder containing textures');
  const seen = new Set();
  const normalized = [projectFiles[0], ...images];
  for (const file of normalized) {
    const path = normalizeProjectPath(file);
    if (seen.has(path)) throw new Error('Duplicate texture path: ' + path);
    seen.add(path);
  }
  return normalized;
}

async function readEntry(entry, hierarchy = []) {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    rememberProjectFilePath(file, [...hierarchy, entry.name].join('/'));
    return [file];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const children = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  const paths = await Promise.all(children.map(child => readEntry(child, [...hierarchy, entry.name])));
  return paths.flat();
}

export async function readDroppedProjectEntries(entries) {
  const groups = await Promise.all(Array.from(entries || []).map(entry => readEntry(entry)));
  return groups.flat();
}
