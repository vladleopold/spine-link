import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/spine-export-all.yml', import.meta.url), 'utf8');

test('every artifact-index writer marks an export ready only when a WebM file exists', () => {
  const writers = [...workflow.matchAll(/const uploadedUrls = \{\};/g)];
  assert.equal(writers.length, 2, 'both artifact-index writers must be covered');

  for (const [index, match] of writers.entries()) {
    const block = workflow.slice(match.index, match.index + 6500);
    assert.match(block, /const hasWebmPreview = Boolean\(uploadedUrls\.webmPreview \|\| uploadedUrls\.webmPreviewMedium \|\| uploadedUrls\.webmPreviewLow\)/,
      `writer ${index + 1} must detect an actual WebM artifact`);
    assert.match(block, /const exportError = videoMeta\.error \|\| \(!hasWebmPreview \? 'No WebM preview artifact was produced' : ''\)/,
      `writer ${index + 1} must treat a missing WebM as an export failure`);
    assert.match(block, /webmStatus: exportError \? 'error' : 'ready'/,
      `writer ${index + 1} must not mark an empty export ready`);
  }
});

test('failed or empty exports clear stale preview asset URLs from the index', () => {
  const writers = [...workflow.matchAll(/const uploadedUrls = \{\};/g)];
  for (const [index, match] of writers.entries()) {
    const block = workflow.slice(match.index, match.index + 6500);
    assert.match(block, /if \(exportError\)\s*\{[\s\S]*?delete indexData\[entryIndex\]\.webmPreview/,
      `writer ${index + 1} must clear stale video URLs after a failed export`);
    assert.match(block, /delete indexData\[entryIndex\]\.webpPoster/,
      `writer ${index + 1} must clear stale poster URLs after a failed export`);
  }
});
