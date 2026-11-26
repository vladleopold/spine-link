import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/spine-export-all.yml', import.meta.url), 'utf8');

function artifactWriters() {
  const matches = [...workflow.matchAll(/const uploadedUrls = \{\};/g)];
  return matches.map((match, index) => ({
    index,
    block: workflow.slice(match.index, matches[index + 1]?.index ?? workflow.length),
  }));
}

test('every artifact-index writer marks an export ready only when a WebM file exists', () => {
  const writers = artifactWriters();
  assert.equal(writers.length, 2, 'both artifact-index writers must be covered');

  for (const { index, block } of writers) {
    assert.match(block, /const hasWebmPreview = Boolean\(uploadedUrls\.webmPreview \|\| uploadedUrls\.webmPreviewMedium \|\| uploadedUrls\.webmPreviewLow\)/,
      `writer ${index + 1} must detect an actual WebM artifact`);
    assert.match(block, /const exportError = videoMeta\.error \|\| \(!hasWebmPreview \? 'No WebM preview artifact was produced' : ''\)/,
      `writer ${index + 1} must treat a missing WebM as an export failure`);
    assert.match(block, /webmStatus: exportError \? 'error' : 'ready'/,
      `writer ${index + 1} must not mark an empty export ready`);
    assert.match(block, /\.\.\.\(exportError \? \{\} : uploadedUrls\)/,
      `writer ${index + 1} must not index partial media from a failed export`);
    assert.ok(block.includes("const webmPreviewPath = (uploadedUrls.webmPreview || uploadedUrls.webmPreviewMedium || uploadedUrls.webmPreviewLow || '').replace(origin + '/assets/', '')"),
      `writer ${index + 1} must store the path of the actual selected WebM tier`);
  }
});

test('failed or empty exports clear stale preview asset URLs from the index', () => {
  const writers = artifactWriters();
  for (const { index, block } of writers) {
    assert.match(block, /if \(exportError\)\s*\{[\s\S]*?delete indexData\[entryIndex\]\.webmPreview/,
      `writer ${index + 1} must clear stale video URLs after a failed export`);
    assert.match(block, /delete indexData\[entryIndex\]\.webpPoster/,
      `writer ${index + 1} must clear stale poster URLs after a failed export`);
  }
});
