#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryForUpload } from './resolve-library.mjs';

const failed = (reason) => ({ found: false, reason });

export function validateWebmDispatch(repoRoot, uploadId, animation) {
  if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(uploadId)) {
    return failed('invalid-upload-id');
  }
  if (typeof animation !== 'string' || !animation.trim() || animation.length > 160 || /[\r\n]/.test(animation)) {
    return failed('invalid-animation');
  }

  const root = path.resolve(repoRoot);
  const indexed = entryForUpload(root, uploadId);
  if (!indexed) return failed('upload-not-indexed');

  const uploadRelative = indexed.entry.previewPath || path.posix.join(indexed.basePath, uploadId);
  const uploadDirectory = path.resolve(root, uploadRelative);
  const relativeUpload = path.relative(root, uploadDirectory);
  if (!relativeUpload || relativeUpload.startsWith('..') || path.isAbsolute(relativeUpload)) {
    return failed('upload-path-invalid');
  }

  let setDirectories;
  try {
    setDirectories = fs.readdirSync(uploadDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return failed('upload-directory-missing');
  }

  let sawSkeleton = false;
  let sawBinarySkeleton = false;
  for (const setName of setDirectories) {
    const setDirectory = path.join(uploadDirectory, setName);
    let files;
    try {
      files = fs.readdirSync(setDirectory);
    } catch {
      continue;
    }
    const images = files.filter((name) => /\.(png|jpe?g|webp)$/i.test(name));
    const atlases = files.filter((name) => /\.atlas(?:\.txt)?$/i.test(name));
    if (!images.length || !atlases.length) continue;

    for (const name of files.filter((file) => /\.json$/i.test(file))) {
      let skeleton;
      try {
        skeleton = JSON.parse(fs.readFileSync(path.join(setDirectory, name), 'utf8'));
      } catch {
        continue;
      }
      if (!Array.isArray(skeleton?.bones)) continue;
      sawSkeleton = true;
      if (!Object.hasOwn(skeleton?.animations ?? {}, animation)) continue;

      const skeletonAbsolute = path.join(setDirectory, name);
      const skeletonRelative = path.relative(root, skeletonAbsolute).split(path.sep).join('/');
      return {
        found: true,
        basePath: indexed.basePath,
        uploadPath: path.relative(root, uploadDirectory).split(path.sep).join('/'),
        skeletonPath: skeletonRelative,
      };
    }

    // Binary Spine skeletons cannot be inspected without the matching Spine
    // runtime. Accept the dispatch candidate here; spine-export-webm performs
    // the authoritative animation-name validation after loading the .skel.
    for (const name of files.filter((file) => /\\.skel$/i.test(file))) {
      sawSkeleton = true;
      sawBinarySkeleton = true;
      const skeletonAbsolute = path.join(setDirectory, name);
      const skeletonRelative = path.relative(root, skeletonAbsolute).split(path.sep).join('/');
      return {
        found: true,
        basePath: indexed.basePath,
        uploadPath: path.relative(root, uploadDirectory).split(path.sep).join('/'),
        skeletonPath: skeletonRelative,
        binary: true,
      };
    }
  }

  return failed(sawBinarySkeleton ? 'binary-animation-runtime-validation-required' : sawSkeleton ? 'animation-not-found' : 'source-files-missing');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const result = validateWebmDispatch(process.cwd(), process.env.UPLOAD_ID || '', process.env.ANIMATION || '');
  const output = [
    'found=' + String(result.found),
    ...(result.found
      ? [
          'basePath=' + result.basePath,
          'uploadPath=' + result.uploadPath,
          'skeletonPath=' + result.skeletonPath,
        ]
      : ['reason=' + result.reason]),
  ];
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, output.join('\n') + '\n');
  }
  console.log(result.found
    ? 'WEBM_DISPATCH_VALIDATED ' + result.uploadPath
    : 'WEBM_DISPATCH_SKIPPED ' + result.reason);
}
