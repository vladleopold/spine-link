import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexedFilePath, previewIndexPath } from '../lib/github-preview-index.js';

test('normalizes both legacy string file manifests and structured file records', () => {
  assert.equal(indexedFilePath('library_01/work/rig.skel'), 'library_01/work/rig.skel');
  assert.equal(indexedFilePath({ path: 'library_01/work/rig.skel', name: 'rig.skel' }), 'library_01/work/rig.skel');
  assert.equal(indexedFilePath({ name: 'rig.skel' }), 'rig.skel');
  assert.equal(indexedFilePath(null), '');
});

test('routes historical library_01 lookups to a small prefix shard', () => {
  assert.equal(previewIndexPath('library_01', 'Hero_2026'), 'library_01/preview-index/h.json');
  assert.equal(previewIndexPath('library_02', 'Arackulele'), 'library_02/index.json');
});

test('preview renderer uses compact index shards and avoids serializing the full index again', () => {
  const source = readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');
  assert.match(source, /previewIndexPath\(basePath, id\)/);
  assert.match(source, /indexedFilePath\(file\)/);
  assert.match(source, /Promise\.all\(\[/);
  assert.doesNotMatch(source, /JSON\.stringify\(entryRecord\.entries\)/);
});
