import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const previewSource = readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');
const assetSource = readFileSync(new URL('../api/github-asset.js', import.meta.url), 'utf8');

test('Spine 3.8 previews use the official pinned runtime and compatible atlas response', () => {
  assert.match(
    previewSource,
    /@8b4844bd4b193ba9e54487ed397a777993cbad56\/spine-ts\//,
  );
  assert.match(previewSource, /spine38-atlas-compat-v1/);
  assert.match(previewSource, /spineRuntime=3\.8/);
  assert.match(assetSource, /function stripPmaMetadataForSpine38\(/);
  assert.match(assetSource, /request\.query\?\.spineRuntime/);
});

test('Spine 3.7 previews use the official branch runtime pinned to its commit', () => {
  assert.match(
    previewSource,
    /@9639bcc81722d7178fd9d1cdc1a3d55a4c91f989\/spine-ts\//,
  );
});

test('Spine skeleton JSON and binary URLs are versioned to avoid stale CDN exports', () => {
  assert.match(
    previewSource,
    /const skeletonUrl = versionedAssetUrl\(origin, skeleton, assetVersion\);/,
  );
});
