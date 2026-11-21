import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { choosePreviewAnimation } from '../scripts/preview-animation-choice.mjs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('the selector preserves an explicit animation name even when the skeleton does not list it', () => {
  assert.equal(choosePreviewAnimation(['idle', 'run'], 'Requested Animation With Spaces'), 'Requested Animation With Spaces');
  assert.equal(choosePreviewAnimation(['idle', 'run'], 'Missing'), 'Missing');
  assert.equal(choosePreviewAnimation(['idle', 'run'], ''), '');
  assert.equal(choosePreviewAnimation(['idle', 'run'], ' run '), ' run ');
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

test('post-publish export keeps the exact indexed animation and blocks a missing selected preview', () => {
  const workflow = read('../.github/workflows/spine-export-full.yml');
  assert.match(workflow, /const chosenAnim = typeof indexData\[entryIndex\]\?\.defaultAnimation === 'string'/);
  assert.match(workflow, /const chosenPreview = chosenAnim \? allAnimPreviews\[chosenAnim\] : null/);
  assert.match(workflow, /fullExportStatus: hasChosenExport \? 'ready' : 'failed'/);
  assert.match(workflow, /previewStatus: 'blocked'/);
  assert.doesNotMatch(workflow, /effectiveDefault|animOrder|animations\s*\[\s*0\s*\]|defaultAnimation:\s*effective/);
});

test('agent and upload APIs preserve the supplied name and do not dispatch without a selection', () => {
  const agent = read('../lib/agent-animation.js');
  const upload = read('../api/github-upload.js');
  assert.match(agent, /const preferred = typeof body\.defaultAnimation === 'string' \? body\.defaultAnimation : ''/);
  assert.match(agent, /animations, defaultAnimation: preferred/);
  assert.match(agent, /const hasSelectedAnimation = Boolean\(preferred\)/);
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
