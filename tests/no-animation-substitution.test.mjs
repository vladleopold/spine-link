import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasSelectedPreviewMedia } = require('../scripts/lib/preview-export-status.cjs');
const { resolvePreviewWorkPath } = require('../scripts/lib/preview-work-path.cjs');
import { choosePreviewAnimation } from '../scripts/preview-animation-choice.mjs';
import { chooseSourceSet } from '../scripts/lib/source-set-choice.mjs';
import { chooseSourceSkeleton } from '../scripts/source-skeleton-choice.mjs';
import { chooseAtlasForSkeleton } from '../scripts/atlas-pages.mjs';
import { safeAnimations, hasExplicitAnimationSelection } from '../lib/agent-animation.js';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('the selector preserves an explicit animation name even when the skeleton does not list it', () => {
  assert.equal(choosePreviewAnimation(['idle', 'run'], 'Requested Animation With Spaces'), 'Requested Animation With Spaces');
  assert.equal(choosePreviewAnimation(['idle', 'run'], 'Missing'), 'Missing');
  assert.equal(choosePreviewAnimation(['idle', 'run'], ''), '');
  assert.equal(choosePreviewAnimation(['idle', 'run'], ' run '), ' run ');
});

test('the exporter never selects the first source set when the index is missing or ambiguous', () => {
  const first = { name: 'first', path: '/work/first', files: ['first.skel', 'first.atlas'] };
  const target = { name: 'target', path: '/work/target', files: ['Target Rig.skel', 'Target Rig.atlas'] };
  assert.equal(chooseSourceSet([first, target], ''), null);
  assert.equal(chooseSourceSet([target], ''), target);
  assert.equal(chooseSourceSet([first, target], 'https://example.invalid/assets/Target%20Rig.json?v=2'), target);
  assert.equal(chooseSourceSet([first, target], 'Missing.skel'), null);
  assert.equal(chooseSourceSet([first, target, { ...target, name: 'duplicate' }], 'Target Rig.skel'), null);
});

test('the exporter chooses only the indexed skeleton and its matching atlas', () => {
  const files = ['Other.json', 'Target Rig.skel', 'Target Rig.json', 'Other.atlas', 'Target Rig.atlas'];
  const validJson = (name) => name === 'Target Rig.json';
  assert.equal(chooseSourceSkeleton('Target Rig.skel', files, validJson), 'Target Rig.json');
  assert.equal(chooseSourceSkeleton('Target Rig.json', files, validJson), 'Target Rig.json');
  assert.equal(chooseSourceSkeleton('Target Rig.skel', ['Target Rig.skel'], validJson), 'Target Rig.skel');
  assert.throws(() => chooseSourceSkeleton('Missing.skel', files, validJson), /SOURCE_SKELETON_MISSING_OR_AMBIGUOUS/);
  assert.throws(() => chooseSourceSkeleton('', ['one.json', 'two.json'], () => true), /SOURCE_SKELETON_MISSING_OR_AMBIGUOUS/);
  assert.equal(chooseAtlasForSkeleton('Target Rig.json', files), 'Target Rig.atlas');
  assert.equal(chooseAtlasForSkeleton('hero.skel', ['first.atlas', 'second.atlas']), null);
});

test('the WebM exporter blocks an absent or unavailable selected animation instead of choosing the first track', () => {
  const exporter = read('../scripts/spine-export-webm.mjs');
  const selector = read('../scripts/preview-animation-choice.mjs');
  assert.match(exporter, /choosePreviewAnimation\(availableAnimations, requestedAnimation\)/);
  assert.match(exporter, /if \(!targetAnimation\)/);
  assert.match(exporter, /if \(!availableAnimations\.includes\(targetAnimation\)\)/);
  assert.doesNotMatch(exporter, /availableAnimations\s*\[\s*0\s*\]/);
  assert.doesNotMatch(exporter, /alternatePreviewAnimations|targetAnimation\s*=\s*candidate/);
  assert.match(selector, /return typeof preferred === 'string' \? preferred : ''/);
});

test('the main and extra players never infer a default from the first runtime animation', () => {
  const app = read('../src/SpineApp.tsx');
  assert.doesNotMatch(app, /names\s*\[\s*0\s*\]|animations\s*\[\s*0\s*\]|names\.find\(\(animationName/);
  assert.match(app, /const requestedAnimation = typeof configuredSpine\.defaultAnimation === "string"/);
  assert.match(app, /const requestedAnimation = typeof prepared\.defaultAnimation === "string"/);
  assert.match(app, /animation: extraSet \? extraSet\.activeAnimation/);
  assert.doesNotMatch(app, /extraSet\?\.activeAnimation\s*\|\|\s*prepared\.defaultAnimation/);
  assert.match(app, /if \(!trackEntry\) return false/);
  assert.doesNotMatch(app, /Automatic preview fallback after publish\/save|publishToGitHub\(preparedSpine, animations, fallback\)/);
});

test('manual skeleton import never infers idle or the first animation as the default', () => {
  const app = read('../src/SpineApp.tsx');
  const preparedSetsStart = app.indexOf('const preparedSets =');
  const start = app.indexOf('const animationNames =', preparedSetsStart);
  const end = app.indexOf('const skinNames =', start);
  assert.ok(preparedSetsStart >= 0 && start > preparedSetsStart && end > start, 'animation-selection block must remain discoverable');
  const selection = app.slice(start, end);
  assert.ok(selection.includes('const defaultAnimation = "";'));
  assert.equal(selection.includes('animationNames.find'), false);
  assert.equal(selection.includes('animationNames[0]'), false);
});

test('WebM export records only the requested animation and never guesses a named skin', () => {
  const exporter = read('../scripts/spine-export-webm.mjs');
  assert.ok(exporter.includes('const captureAnimation = targetAnimation;'));
  for (const forbidden of ['scenarioEntry', 'scenarioExit', 'scenarioIdle', 'scenarioCycle', '__spineScenario']) {
    assert.equal(exporter.includes(forbidden), false, `unexpected animation sequence token: ${forbidden}`);
  }
  assert.ok(exporter.includes('const skinCandidates = [null];'));
  assert.ok(exporter.includes("lastCaptureError = 'DEFAULT_SKIN_NO_VISIBLE_CONTENT';"));
  assert.equal(exporter.includes('skinNames.filter'), false);
  assert.equal(exporter.includes('trying next skin'), false);
});

test('post-publish export keeps the exact indexed animation and blocks a missing selected preview', () => {
  const workflow = read('../.github/workflows/spine-export-full.yml');
  assert.match(workflow, /const chosenAnim = typeof indexData\[entryIndex\]\?\.defaultAnimation === 'string'/);
  assert.match(workflow, /const chosenPreview = chosenAnim \? allAnimPreviews\[chosenAnim\] : null/);
  assert.match(workflow, /fullExportStatus: hasChosenExport \? 'ready' : 'failed'/);
  assert.match(workflow, /const hasChosenExport = hasSelectedPreviewMedia\(chosenPreview\)/);
  assert.match(workflow, /resolvePreviewWorkPath\(basePath, uploadId, entry\.previewPath\)/);
  assert.match(workflow, /path\.join\(workPath, 'animations', safeName\)/);
  assert.match(workflow, /git add "\$BASE_PATH" "\$WORK_PATH\/animations"/);
  assert.doesNotMatch(workflow, /path\.join\(basePath, uploadId, 'animations', safeName\)/);
  assert.match(workflow, /require\('\.\/scripts\/lib\/preview-export-status\.cjs'\)/);
  assert.match(workflow, /previewStatus: 'blocked'/);
  assert.doesNotMatch(workflow, /const hasChosenExport = Boolean\(chosenPreview\)/);
  assert.doesNotMatch(workflow, /effectiveDefault|animOrder|animations\s*\[\s*0\s*\]|defaultAnimation:\s*effective/);
});

test('agent animation names and selection preserve exact whitespace without accepting blank names', () => {
  assert.deepEqual(safeAnimations([' run ', 'run', ' run ', '   ', '']), [' run ', 'run']);
  assert.equal(hasExplicitAnimationSelection(' run ', [' run '], 'runtime'), true);
  assert.equal(hasExplicitAnimationSelection(' run ', ['run'], 'runtime'), false);
  assert.equal(hasExplicitAnimationSelection('   ', ['   '], 'runtime'), false);
  assert.equal(hasExplicitAnimationSelection('', [], 'spine-project'), false);
  assert.equal(hasExplicitAnimationSelection(' Walk ', [], 'spine-project'), true);
});

test('agent and upload APIs preserve the supplied name and do not dispatch without a selection', () => {
  const agent = read('../lib/agent-animation.js');
  const upload = read('../api/github-upload.js');
  assert.match(agent, /const preferred = typeof body\.defaultAnimation === 'string' \? body\.defaultAnimation : ''/);
  assert.match(agent, /animations, defaultAnimation: preferred/);
  assert.match(agent, /hasExplicitAnimationSelection\(preferred, animations, job\.format\)/);
  assert.doesNotMatch(agent, /animations\s*\[\s*0\s*\]|animations\.includes\(preferred\) \? preferred/);
  assert.match(upload, /const defaultAnimation = typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
  assert.match(upload, /NO_DEFAULT_SPINE_ANIMATION/);
  assert.doesNotMatch(upload, /animations\s*\[\s*0\s*\]/);
});

test('cloud conversion and data-science metadata never invent a default animation', () => {
  const cloud = read('../scripts/spine-project-cloud-export.mjs');
  const science = read('../lib/spine-data-science.js');
  assert.match(cloud, /const selectedAnimation = typeof existing\?\.defaultAnimation === 'string' \? existing\.defaultAnimation : ''/);
  assert.match(cloud, /defaultAnimation:selectedAnimation/);
  assert.match(cloud, /if \(status === 'ready' && selectedAnimationAvailable\)/);
  assert.doesNotMatch(cloud, /animations\s*\[\s*0\s*\]/);
  assert.match(science, /defaultAnimation: typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
  assert.doesNotMatch(science, /animations\s*\[\s*0\s*\]/);
});

test('preview skin selection does not substitute the first non-default skin', () => {
  const app = read('../src/SpineApp.tsx');
  const preview = read('../api/github-preview.js');
  assert.match(app, /skinNames\.includes\("default"\) \? "default" : ""/);
  assert.match(preview, /skinNames\.includes\('default'\) \? 'default' : ''/);
  assert.doesNotMatch(app + preview, /skinNames\s*\[\s*0\s*\]/);
});


test('full-export readiness requires a real same-tier opaque WebM and WebP URL pair', () => {
  assert.equal(hasSelectedPreviewMedia(null), false);
  assert.equal(hasSelectedPreviewMedia({ previewDuration: 2 }), false);
  assert.equal(hasSelectedPreviewMedia({ webmPreview: 'https://cdn.example/preview.webm' }), false);
  assert.equal(hasSelectedPreviewMedia({ webpPoster: 'https://cdn.example/preview.webp' }), false);
  assert.equal(hasSelectedPreviewMedia({
    webmPreview: 'https://cdn.example/preview.webm',
    webpPosterMedium: 'https://cdn.example/preview-medium.webp',
  }), false);
  assert.equal(hasSelectedPreviewMedia({
    webmPreviewMedium: 'https://cdn.example/preview-medium.webm?version=1',
    webpPosterMedium: 'https://cdn.example/preview-medium.webp?version=1',
  }), true);
  assert.equal(hasSelectedPreviewMedia({
    webmPreview: 'https://cdn.example/preview.webm',
    webpPoster: 'https://cdn.example/preview.webp',
  }), true);
  assert.equal(hasSelectedPreviewMedia({
    webmPreview: 'not-a-url',
    webpPoster: 'not-a-url',
  }), false);
  assert.equal(hasSelectedPreviewMedia({
    webmPreview: 'https://cdn.example/preview.mp4',
    webpPoster: 'https://cdn.example/preview.webp',
  }), false);
});


test('full export writes beside the indexed source bundle, including legacy root-level paths', () => {
  assert.equal(resolvePreviewWorkPath('library_02', 'legacy-work', 'legacy-work'), 'legacy-work');
  assert.equal(resolvePreviewWorkPath('library_02', 'new-work', 'library_02/new-work'), 'library_02/new-work');
  assert.equal(resolvePreviewWorkPath('library_02', 'new-work', ''), 'library_02/new-work');
  assert.throws(() => resolvePreviewWorkPath('library_02', 'new-work', '../../other'), /UNSAFE_PREVIEW_PATH/);
  assert.throws(() => resolvePreviewWorkPath('library_02', 'new-work', 'library_01/new-work'), /UNSAFE_PREVIEW_PATH/);
  assert.throws(() => resolvePreviewWorkPath('library_02', 'new-work', 'library_02/other-work'), /UNSAFE_PREVIEW_PATH/);
  assert.throws(() => resolvePreviewWorkPath('../library_02', 'new-work', 'new-work'), /UNSAFE_PREVIEW_PATH/);
  assert.throws(() => resolvePreviewWorkPath('library_02', '../other', '../other'), /UNSAFE_PREVIEW_PATH/);
});
