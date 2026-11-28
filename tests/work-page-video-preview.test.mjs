import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const preview = fs.readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');

test('Spine work page renders a visible standalone video preview when a verified clip exists', () => {
  const start = preview.indexOf('<aside id="sidebar">');
  const sidebar = preview.slice(start, preview.indexOf('</aside>', start));
  assert.match(sidebar, /preview-video-card/);
  assert.match(sidebar, /video\?\.contentUrl/);
  assert.match(sidebar, /video\?\.thumbnailUrl/);
  assert.match(sidebar, /controls/);
  assert.match(sidebar, /autoplay/);
  assert.match(sidebar, /muted/);
  assert.match(sidebar, /loop/);
  assert.match(sidebar, /playsinline/);
  assert.match(preview, /\.preview-video-card video\s*\{/);
});

test('video preview is conditionally omitted when the selected animation has no verified WebM', () => {
  const start = preview.indexOf('<aside id="sidebar">');
  const sidebar = preview.slice(start, preview.indexOf('</aside>', start));
  assert.match(sidebar, /video\?\.contentUrl/);
});

test('video preview is placed immediately after the animation picker on desktop and mobile', () => {
  assert.match(preview, /#sidebar > #animation-card \{ order: 1; \}/);
  assert.match(preview, /#sidebar > \.preview-video-card \{ order: 2; \}/);
  assert.match(preview, /#sidebar > #animation-card \{ order: 2 !important;[^}]*\}/);
  assert.match(preview, /#sidebar > \.preview-video-card \{ order: 3 !important; \}/);
});
