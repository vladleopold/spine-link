import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { previewMediaStatusAllowsPlayback } from '../lib/preview-media-status.js';
import { resolvePreviewAnimationTarget } from '../lib/preview-animation-target.js';

const preview = fs.readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');
const archive = fs.readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('URL-selected animation is preserved even when absent from index animation names', () => {
  const initial = section(preview, 'function initialAnimation(set)', 'const PREVIEW_PAD');
  assert.match(initial, /return queryAnimation \|\| set\?\.animation \|\| ""/);
  assert.doesNotMatch(initial, /setHasAnimation/);
  const initialSet = section(preview, 'function initialSet()', 'function initialAnimation(set)');
  assert.match(initialSet, /if \(querySet\) return sets\.find\(\(set\) => set\.label === querySet\) \|\| null/);
});

test('default animation comes only from the index, never idle or the first runtime track', () => {
  assert.match(preview, /const defaultAnimation = typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : '';/);
  assert.doesNotMatch(preview, /animations\.find\(\(name\) => name\.toLowerCase\(\) === 'idle'\)/);
  assert.doesNotMatch(preview, /animations\.find\(\(name\) => name\.toLowerCase\(\)\.includes\('idle'\)\)/);
  assert.doesNotMatch(preview, /skeleton\.data\.animations\[0\]/);
});

test('URL-selected video preview is exact and never falls back to the indexed default', () => {
  const entry = {
    defaultAnimation: 'Run',
    allAnimationPreviews: {
      Run: { webmPreview: '/run.webm' },
      Walk: { webmPreview: '/walk.webm' },
    },
  };
  assert.deepEqual(resolvePreviewAnimationTarget(entry, 'Walk'), {
    name: 'Walk', preview: entry.allAnimationPreviews.Walk,
  });
  assert.deepEqual(resolvePreviewAnimationTarget(entry, 'Missing'), {
    name: 'Missing', preview: null,
  }, 'a missing explicit animation must not fall back to the indexed default');
  assert.equal(resolvePreviewAnimationTarget(entry, '').name, 'Run');
  assert.equal(resolvePreviewAnimationTarget(entry, ' Walk ').name, ' Walk ',
    'animation names are byte-for-byte exact');

  const resolver = section(preview, 'function resolvePreviewTarget(entry', '// Compact download picker');
  assert.match(resolver, /resolvePreviewAnimationTarget\\(entry, requestedAnimation\\)/);
  assert.match(resolver, /previewMediaStatusAllowsPlayback\\(entry\\)/);
  assert.doesNotMatch(resolver, /entry\\?\\.webmPreview/);
  assert.match(resolver, /lowUrl: shortClip/);
  assert.match(resolver, /isFallback: false/);

  const metadata = section(preview, 'function videoMetadataForEntry(', 'function ');
  assert.match(metadata, /resolvePreviewTarget\\(entry, origin, requestedAnimation\\)/);
  assert.match(metadata, /previewAnimation: target\\.name/);
  const fallback = section(preview, 'function createVideoFallbackHtml(', 'async function createDynamicPreview(');
  assert.match(fallback, /resolvePreviewTarget\\(entry, origin, requestedAnimation\\)/);
  const dynamic = section(preview, 'async function createDynamicPreview(', '// Finds the folder of a work');
  assert.match(dynamic, /videoMetadataForEntry\\([^;]*requestedAnimation\\)/);
  assert.match(dynamic, /createVideoFallbackHtml\\([^;]*requestedAnimation\\)/);
  const handler = preview.slice(preview.indexOf('export default async function handler('));
  assert.match(handler, /request\\.query\\?\\.animation/);
  assert.match(handler, /createDynamicPreview\\(settings, path, origin, entryRecord, requestedAnimation\\)/);
});

test('failed or blocked preview media cannot leak stale WebM/WebP URLs', () => {
  const resolver = section(preview, 'function resolvePreviewTarget(entry', '// Compact download picker');
  assert.match(resolver, /previewMediaStatusAllowsPlayback\(entry\)/);
  assert.match(resolver, /const selected = previewMediaStatusAllowsPlayback\(entry\) && chosen\.trim\(\) && previews \? previews\[chosen\] : null/);
  assert.match(resolver, /name: chosen/);

  assert.equal(previewMediaStatusAllowsPlayback({ previewStatus: 'failed', webmStatus: 'ready' }), false);
  assert.equal(previewMediaStatusAllowsPlayback({ previewStatus: 'blocked', webmStatus: 'ready' }), false);
  assert.equal(previewMediaStatusAllowsPlayback({ previewStatus: 'ready', webmStatus: 'pending' }), false);
  assert.equal(previewMediaStatusAllowsPlayback({ previewStatus: 'ready', webmStatus: 'ready' }), true);
  assert.equal(previewMediaStatusAllowsPlayback({}), true);
  assert.equal(previewMediaStatusAllowsPlayback({ webmStatus: 'ready' }), true);
});

test('player keeps the exact requested animation and marks missing tracks blocked', () => {
  const playback = section(preview, 'function playAnimationEntry(name)', 'function togglePlayback()');
  assert.match(playback, /findAnimation\?\.\(name\)/);
  assert.match(playback, /player\.setAnimation\(name, loopEnabled\.value\)/);
  assert.doesNotMatch(playback, /names\[0\]|animations\[0\]|filteredNames\[0\]/);
  const player = section(preview, 'function markPreviewBlocked(code)', 'function renderAnimationList()');
  assert.match(player, /animation: requestedAnimation/);
  assert.match(player, /names\.includes\(requestedAnimation\)/);
  assert.match(player, /SELECTED_SPINE_ANIMATION_UNAVAILABLE/);
  assert.doesNotMatch(preview, /syncScenario|scenarioState|playNextScenarioStep|isScenarioStep/);
});

test('player startup never replaces the requested track with the first runtime track', () => {
  const startup = section(preview, 'async function createPlayer()', 'function renderAnimationList()');
  assert.ok(startup.includes('const requestedAnimation = activeAnimation.name'));
  assert.ok(startup.includes('animation: requestedAnimation'));
  const missingTrackGuard = startup.indexOf('if (!names.includes(requestedAnimation))');
  const blocked = startup.indexOf('markPreviewBlocked("SELECTED_SPINE_ANIMATION_UNAVAILABLE")', missingTrackGuard);
  const blockedReturn = startup.indexOf('return;', blocked);
  const playback = startup.indexOf('playActiveAnimationFromStart()');
  assert.ok(missingTrackGuard >= 0 && blocked > missingTrackGuard && blockedReturn > blocked && playback > blockedReturn,
    'missing requested tracks must be blocked before playback starts');
  assert.doesNotMatch(startup, /(?:names|animations|filteredNames)\s*\[\s*0\s*\]/);
});

test('viewport healing measures only the selected animation', () => {
  const refit = section(preview, 'function refitToContent(', 'function measuredAnimationBounds(');
  const measured = section(preview, 'function measuredAnimationBounds(', 'let healAttempts');
  assert.match(refit, /const active = typeof activeAnimation\.name === 'string' \? activeAnimation\.name : ''/);
  assert.match(refit, /if \(!active \|\| !names\.includes\(active\)\) return false/);
  assert.doesNotMatch(refit, /names\[0\]/);
  assert.match(measured, /findAnimation\(activeAnimation\.name\)/);
  assert.doesNotMatch(measured, /animations\[0\]/);
});

test('loading video is hidden and can play only when it names the selected animation', () => {
  assert.match(preview, /preload="none" hidden data-animation=/);
  assert.match(preview, /video\.dataset\.animation !== activeAnimation\.name/);
  assert.doesNotMatch(preview, /preview-loading-video[^\n]*autoplay/);
});

test('archive cards use only the indexed default animation and its exact media pair', () => {
  const feed = section(archive, 'function archiveFeedEntry(', 'function lightweightCardHtml(');
  assert.match(feed, /hasDefaultAnimation = typeof entry\?\.defaultAnimation === 'string' && entry\.defaultAnimation\.trim\(\)\.length > 0/);
  assert.match(feed, /selectedPreview = hasDefaultAnimation \? selectedAnimationVideo\(entry\) : null/);
  assert.match(feed, /video: selected\?\.video \|\| ''/);
  assert.match(feed, /isGeneratedWebmUrl\(candidate\.video, entry\)/);
  assert.match(feed, /isGeneratedWebpPosterUrl\(candidate\.poster, entry\)/);
  const selected = section(archive, 'function selectedAnimationVideo(', 'function safeAsset(');
  assert.match(selected, /allAnimationPreviews/);
  assert.match(selected, /defaultAnimation/);
  assert.doesNotMatch(selected, /entry\?\.webmPreview/);
  const home = section(archive, 'function homepageFeedEntries(', 'function mergeArchiveEntries(');
  assert.match(home, /entryVideoLowSrc\(origin, entry\)/);
  assert.match(home, /previewAnimation: selectedPreview\.name/);
  assert.doesNotMatch(home, /entryVideoAsset\(entry\?\.webmPreview/);
});

test('video watch uses the exact URL selection while owner-library cards keep their own defaults', () => {
  const videoPage = section(preview, 'function createVideoFallbackHtml(', 'async function createDynamicPreview(');
  assert.match(videoPage, /resolvePreviewTarget\\(entry, origin, requestedAnimation\\)/);
  assert.match(videoPage, /const video = target\\.url \\? entryVideoAsset\\(target\\.url, entry, 'webm'\\) : ''/);
  assert.match(preview, /webmPreviewFull: target\\.url \\? entryVideoAsset\\(target\\.url, item, 'webm'\\) : ''/);
  const owner = section(preview, 'const lowWebm = target.lowUrl', 'return {');
  assert.match(owner, /target\\.lowUrl/);
  assert.doesNotMatch(owner, /item\\?\\.webmPreviewLow/);
  assert.match(preview, /previewAnimation: target\\.name \\|\\| ''/);
});

test('indexed animation names remain byte-for-byte exact in URLs, media lookup and viewport refit', () => {
  const playerUrl = section(preview, 'function playerUrlForEntry(', 'function archiveUrlForEntry(');
  assert.match(playerUrl, /const animation = typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
  assert.match(playerUrl, /animation\.trim\(\) \?/);
  assert.match(playerUrl, /encodeURIComponent\(animation\)/);

  const archiveUrl = section(archive, 'function previewUrl(', 'function archiveItemUrl(');
  assert.match(archiveUrl, /const animation = typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
  assert.match(archiveUrl, /animation\.trim\(\) \?/);
  assert.match(archiveUrl, /encodeURIComponent\(animation\)/);

  const selected = section(archive, 'function selectedAnimationVideo(', 'function safeAsset(');
  assert.match(selected, /const name = typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
  assert.match(selected, /previews\[name\]/);
  assert.doesNotMatch(selected, /String\(entry\?\.defaultAnimation \|\| ''\)\.trim\(\)/);
});
