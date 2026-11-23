import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { choosePreviewAnimation } from '../scripts/preview-animation-choice.mjs';
import { chooseSourceSet } from '../scripts/lib/source-set-choice.mjs';
import { chooseSourceSkeleton } from '../scripts/source-skeleton-choice.mjs';
import { chooseAtlasForSkeleton } from '../scripts/atlas-pages.mjs';

const require = createRequire(import.meta.url);
const { resolvePreviewWorkPath } = require('../scripts/lib/preview-work-path.cjs');
const { hasSelectedPreviewMedia } = require('../scripts/lib/preview-export-status.cjs');
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('selected animation is preserved exactly; an absent selection is never guessed', () => {
  assert.equal(choosePreviewAnimation(['idle', 'run'], 'Run'), 'Run');
  assert.equal(choosePreviewAnimation(['idle', 'run'], 'Missing'), 'Missing');
  assert.equal(choosePreviewAnimation(['idle', 'run'], ''), '');
});

test('source set must uniquely match the index-selected skeleton', () => {
  const first = { name: 'first', files: ['first.skel'] };
  const target = { name: 'target', files: ['Target Rig.skel'] };
  assert.equal(chooseSourceSet([first, target], 'Target Rig.skel'), target);
  assert.equal(chooseSourceSet([first, target], ''), null);
  assert.equal(chooseSourceSet([first, target], 'missing.skel'), null);
  assert.equal(chooseSourceSet([target], ''), target);
});

test('skeleton and atlas must belong to the selected source set', () => {
  const files = ['Other.json', 'Target Rig.skel', 'Target Rig.json', 'Other.atlas', 'Target Rig.atlas', 'page.png'];
  const validJson = (name) => name === 'Target Rig.json';
  assert.equal(chooseSourceSkeleton('Target Rig.skel', files, validJson), 'Target Rig.json');
  assert.equal(chooseAtlasForSkeleton('Target Rig.json', files), 'Target Rig.atlas');
  assert.throws(() => chooseSourceSkeleton('Missing.skel', files, validJson), /SOURCE_SKELETON_MISSING_OR_AMBIGUOUS/);
  assert.equal(chooseAtlasForSkeleton('hero.skel', ['one.atlas', 'two.atlas']), null);
});

test('preview readiness requires at least one same-quality WebM/WebP pair', () => {
  assert.equal(hasSelectedPreviewMedia(null), false);
  assert.equal(hasSelectedPreviewMedia({ webmPreview: 'https://cdn.example/preview.webm' }), false);
  assert.equal(hasSelectedPreviewMedia({
    webmPreviewMedium: 'https://cdn.example/preview-medium.webm',
    webpPosterMedium: 'https://cdn.example/preview-medium.webp',
  }), true);
  assert.equal(hasSelectedPreviewMedia({
    webmPreview: 'https://cdn.example/preview.webm',
    webpPosterMedium: 'https://cdn.example/preview-medium.webp',
  }), false);
});

test('export work paths stay beside the source and reject traversal', () => {
  assert.equal(resolvePreviewWorkPath('library_02', 'work', 'library_02/work'), 'library_02/work');
  assert.equal(resolvePreviewWorkPath('library_02', 'legacy', 'legacy'), 'legacy');
  assert.throws(() => resolvePreviewWorkPath('library_02', 'work', '../../other'), /UNSAFE_PREVIEW_PATH/);
});

test('exporter refuses to infer source set, skeleton, or animation', () => {
  const exporter = read('../scripts/spine-export-webm.mjs');
  assert.match(exporter, /chooseSourceSet\(sets, requestedSkeleton/);
  assert.match(exporter, /chooseSourceSkeleton\(requestedSkeleton/);
  assert.match(exporter, /chooseAtlasForSkeleton\(skeletonFile, setFiles\)/);
  assert.match(exporter, /choosePreviewAnimation\(availableAnimations, requestedAnimation\)/);
  assert.match(exporter, /if \(!targetAnimation\)/);
  assert.match(exporter, /if \(!availableAnimations\.includes\(targetAnimation\)\)/);
  assert.doesNotMatch(exporter, /const firstSet = sets\[0\]/);
  assert.doesNotMatch(exporter, /availableAnimations\s*\[\s*0\s*\]/);
  assert.match(exporter, /const captureAnimation = targetAnimation/);
  assert.doesNotMatch(exporter, /__spineScenario|scenarioEntry|scenarioIdle/);
});

test('full export never rewrites defaultAnimation and blocks a missing selected media pair', () => {
  const workflow = read('../.github/workflows/spine-export-full.yml');
  assert.match(workflow, /const chosenAnim = typeof indexData\[entryIndex\]\?\.defaultAnimation === 'string'/);
  assert.match(workflow, /const chosenPreview = chosenAnim \? allAnimPreviews\[chosenAnim\] : null/);
  assert.match(workflow, /const hasChosenExport = hasSelectedPreviewMedia\(chosenPreview\)/);
  assert.match(workflow, /previewStatus: 'blocked'/);
  assert.match(workflow, /webmStatus: blockedStatus/);
  assert.doesNotMatch(workflow, /effectiveDefault|animOrder|defaultAnimation:\s*effective/);
});
