import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const previewSource = readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');
const assetSource = readFileSync(new URL('../api/github-asset.js', import.meta.url), 'utf8');

test('Spine 3.8 previews use the same-origin official runtime and compatible atlas response', () => {
  assert.ok(previewSource.includes('setPlayerStylesheet("/vendor-spine-player-3.8.css")'));
  assert.ok(previewSource.includes('loadScriptOnce("/vendor-spine-player-3.8.js")'));
  assert.ok(!previewSource.includes('cdn.jsdelivr.net/gh/EsotericSoftware/spine-runtimes@8b4844bd4b193ba9e54487ed397a777993cbad56'));
  assert.ok(previewSource.includes('spine38-runtime-compat-v2'));
  assert.ok(previewSource.includes('&spineRuntime=3.8'));
  assert.ok(assetSource.includes('function stripPmaMetadataForSpine38('));
  assert.ok(assetSource.includes('request.query?.spineRuntime'));
});

test('the shipped Spine 3.8 runtime files match the official pinned upstream artifacts', async () => {
  const {createHash} = await import('node:crypto');
  const {readFileSync, statSync} = await import('node:fs');
  const runtimePath = new URL('../public/vendor-spine-player-3.8.js', import.meta.url);
  const stylesheetPath = new URL('../public/vendor-spine-player-3.8.css', import.meta.url);
  const runtime = readFileSync(runtimePath);
  const stylesheet = readFileSync(stylesheetPath);
  const gitBlobSha = (bytes) => createHash('sha1')
    .update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes]))
    .digest('hex');
  assert.equal(gitBlobSha(runtime), '12dc99ade606a1d6ea4856080d68fd5f78682350');
  assert.equal(gitBlobSha(stylesheet), '736515f1abbe363f16ca90f8a7381fd91fda4f96');
  assert.ok(statSync(runtimePath).size > 400000);
});
test('the shipped Spine 3.8 runtime files match the official pinned upstream artifacts', async () => {
  const {createHash} = await import('node:crypto');
  const {readFileSync, statSync} = await import('node:fs');
  const runtimePath = new URL('../public/vendor-spine-player-3.8.js', import.meta.url);
  const stylesheetPath = new URL('../public/vendor-spine-player-3.8.css', import.meta.url);
  const runtime = readFileSync(runtimePath);
  const stylesheet = readFileSync(stylesheetPath);
  const gitBlobSha = (bytes) => createHash('sha1')
    .update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes]))
    .digest('hex');
  assert.equal(gitBlobSha(runtime), '12dc99ade606a1d6ea4856080d68fd5f78682350');
  assert.equal(gitBlobSha(stylesheet), '736515f1abbe363f16ca90f8a7381fd91fda4f96');
  assert.ok(statSync(runtimePath).size > 400000);
});
test('Spine 3.7 previews use the official branch runtime pinned to its commit', () => {
  assert.match(
    previewSource,
    /@9639bcc81722d7178fd9d1cdc1a3d55a4c91f989\/spine-ts\//,
  );
});

test('Spine skeleton JSON and binary URLs are versioned to avoid stale CDN exports', () => {
  assert.ok(previewSource.includes("const needsSpine37BinaryConversion = skeletonIsBinary && runtimeVersionOverride === '4.3';"));
  assert.ok(previewSource.includes("const needsUnityTextAssetExtraction = skeletonIsUnityTextAsset;"));
  assert.ok(previewSource.includes("versionedAssetUrl(origin, skeleton, assetVersion)"));
  assert.ok(previewSource.includes("path: \`\${skeleton.path}.json\`"));
  assert.ok(previewSource.includes("&spineRuntime=4.2"));
  assert.ok(previewSource.includes("&spineRuntime=4.3"));
});

test('Spine 4.2 and 4.3 JSON URLs keep a query-free extension for the official parser', () => {
  assert.ok(previewSource.includes('const isSpine42Or43 = /^4[.][23](?:[.]|$)/'));
  assert.ok(previewSource.includes('if (isSpine42Or43)'));
  assert.ok(previewSource.includes('playerOptions.jsonUrl = skeletonPath'));
  assert.ok(previewSource.includes('rawDataURIs[skeletonPath] = skeletonSource'));
  assert.ok(previewSource.includes('rawDataURIs[atlasPath] = atlasSource'));
  assert.ok(previewSource.includes('rawDataURIs[textureName] = textureSource'));
  assert.ok(previewSource.includes('playerOptions.rawDataURIs = rawDataURIs'));
});

test('Spine 4.2 binary skeletons use binaryUrl just like 4.0 and 4.1', () => {
  assert.ok(
    previewSource.includes('/^4[.][012](?:[.]|$)/.test(String(activeSet.value?.skeletonVersion || ""))'),
    'Spine 4.2 must be included in the binaryUrl runtime branch',
  );
  assert.ok(previewSource.includes('binaryUrl: activeSet.value.skelUrl || undefined'));
});


test('Spine 4.3 exports use the official 4.3 runtime package', async () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.dependencies['@esotericsoftware/spine-player'], '^4.3.13');
  assert.ok(previewSource.includes('spine-player@4.3.13'));
  assert.ok(previewSource.includes('const key = runtime || "4.3.13"'));
});

test('Spine 4.3 previews adapt folder-qualified attachment paths before atlas parsing', () => {
  assert.ok(previewSource.includes("import { addSpineAtlasPathAliases } from '../lib/spine-atlas-path-aliases.js';"));
  assert.ok(previewSource.includes('const addSpineAtlasPathAliases = ${addSpineAtlasPathAliases.toString()};'));
  assert.ok(previewSource.includes('const compatibleAtlas = addSpineAtlasPathAliases(atlasText, skeletonJson)'));
  assert.ok(previewSource.includes('rawDataURIs[atlasPath] = activeAtlasBlobUrl'));
});

