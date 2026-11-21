import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchAtlasPageTextures } from '../lib/spine-atlas-texture-matching.js';
import { resolveIndexedPreviewSet, resolveIndexedSpineSourceFiles } from '../lib/preview-set-selection.js';

const preview = fs.readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');
const archive = fs.readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');


test('atlas page matching never accepts a suffix-only texture filename', () => {
  const matcher = section(preview, 'function imageMatchesAtlasPage', 'function safePublicVideo');
  assert.match(matcher, /imageBase === pageBase/);
  assert.doesNotMatch(matcher, /endsWith/);
  const exact = (imageName, pageName) =>
    String(imageName).toLowerCase() === String(pageName).toLowerCase();
  const real = { name: 'character.png', path: 'work/character.png' };
  const suffixOnly = { name: 'other-character.png', path: 'work/other-character.png' };
  assert.deepEqual(matchAtlasPageTextures(['character.png'], [real], exact), [real]);
  assert.equal(matchAtlasPageTextures(['character.png'], [
    suffixOnly, { name: 'unrelated.png', path: 'work/unrelated.png' },
  ], exact), null,
    'a similar suffix is not proof that the source texture is the atlas page');
});

test('indexed skeleton and atlas are resolved before API listing order can select a pair', () => {
  const unrelatedSkeleton = { type: 'file', name: 'Other.skel' };
  const unrelatedAtlas = { type: 'file', name: 'Other.atlas' };
  const targetSkeleton = { type: 'file', name: 'Target Rig.skel' };
  const targetAtlas = { type: 'file', name: 'Target Rig.atlas' };
  const files = [unrelatedSkeleton, unrelatedAtlas, targetSkeleton, targetAtlas];
  assert.deepEqual(resolveIndexedSpineSourceFiles(files, {
    skeleton: 'https://spine-link.vercel.app/assets/library/work/Target%20Rig.skel?v=1',
    atlas: 'Target Rig.atlas',
  }), { skeleton: targetSkeleton, atlas: targetAtlas });
  assert.equal(resolveIndexedSpineSourceFiles(files, {
    skeleton: 'Target Rig.skel', atlas: 'Missing.atlas',
  }), null, 'a missing indexed atlas must block instead of choosing the first atlas');
  assert.equal(resolveIndexedSpineSourceFiles(files, {}),
    null, 'multiple source pairs without index names are ambiguous');
  assert.deepEqual(resolveIndexedSpineSourceFiles([
    { type: 'file', name: 'Only.json' },
    { type: 'file', name: 'Only.atlas' },
    { type: 'file', name: 'Only.png' },
  ], {}), {
    skeleton: { type: 'file', name: 'Only.json' },
    atlas: { type: 'file', name: 'Only.atlas' },
  });
});

test('single indexed source filename resolves only its uniquely corresponding counterpart', () => {
  const skeleton = { type: 'file', name: 'Rig.skel' };
  const atlas = { type: 'file', name: 'Rig.atlas' };
  const unrelated = { type: 'file', name: 'Other.atlas' };
  assert.deepEqual(resolveIndexedSpineSourceFiles([skeleton, atlas, unrelated], {
    skeletonFile: 'Rig.skel',
  }), { skeleton, atlas });
  assert.deepEqual(resolveIndexedSpineSourceFiles([skeleton, atlas, {
    type: 'file', name: 'Other.skel',
  }], { atlasFile: 'Rig.atlas' }), { skeleton, atlas });
});

test('preview API resolves the indexed pair before selecting an atlas or skeleton', () => {
  assert.match(preview, /resolveIndexedSpineSourceFiles\(files, entry\)/);
  assert.doesNotMatch(preview, /items\.find\(\(item\) => item\.type === 'file' && isAtlas\(item\.name\)\)/);
});

test('atlas pages require unique source textures and never use synthetic placeholders', () => {
  const matchExact = (imageName, pageName) =>
    String(imageName).toLowerCase() === String(pageName).toLowerCase();
  const first = { name: 'first.png', path: 'work/first.png' };
  const second = { name: 'second.png', path: 'work/second.png' };

  assert.deepEqual(matchAtlasPageTextures(['first.png'], [first], matchExact), [first]);
  assert.deepEqual(matchAtlasPageTextures(['first.png', 'second.png'], [first, second], matchExact),
    [first, second]);
  assert.equal(matchAtlasPageTextures(['first.png', 'second.png'], [first], matchExact), null,
    'one texture must never be reused for multiple atlas pages');
  assert.equal(matchAtlasPageTextures(['missing.png'], [first, second], matchExact), null,
    'a missing atlas page must block the source set');
  assert.equal(matchAtlasPageTextures(['first.png'], [first, { ...first, path: 'work/copy.png' }], matchExact), null,
    'multiple candidate textures must be treated as ambiguous');
  assert.equal(matchAtlasPageTextures(['first.png', 'second.png'], [first, first], matchExact), null,
    'one source texture must not satisfy two different atlas pages');
  assert.deepEqual(matchAtlasPageTextures(['unnamed-page.png'],
    [{ name: 'only.png', path: 'work/only.png' }], () => false),
    [{ name: 'only.png', path: 'work/only.png' }],
    'the one-texture/one-page legacy case remains unambiguous');
  assert.equal(matchAtlasPageTextures(['page-a.png', 'page-b.png'],
    [{ name: 'only.png', path: 'work/only.png' }], () => false), null);
});

test('preview API blocks missing or ambiguous atlas textures instead of creating a 1x1 page', () => {
  const atlasSelection = section(preview,
    'const atlasPages = extractAtlasPages(atlasText);',
    'const defaultAnimation = typeof entry?.defaultAnimation');
  assert.match(atlasSelection,
    /matchAtlasPageTextures\(atlasPages, textures, imageMatchesAtlasPage\)/);
  assert.match(atlasSelection, /if \(!matchedTextures\) continue/);
  assert.doesNotMatch(atlasSelection, /data:image\/png;base64,/);
  assert.doesNotMatch(preview, /data:image\/png;base64,/,
    'no missing atlas page may be disguised by a synthetic texture');
});

test('indexed source set selection never guesses the first discovered skeleton', () => {
  const target = {
    label: 'indexed-source',
    skeleton: 'https://spine-link.vercel.app/assets/library/work/Target%20Rig.skel?v=1',
    atlasUrl: 'https://spine-link.vercel.app/assets/library/work/Target%20Rig.atlas?v=1',
  };
  const unrelated = {
    label: 'unrelated-source',
    skeleton: 'https://spine-link.vercel.app/assets/library/work/Other.skel?v=1',
    atlasUrl: 'https://spine-link.vercel.app/assets/library/work/Other.atlas?v=1',
  };
  assert.equal(resolveIndexedPreviewSet([unrelated, target], {
    skeleton: 'Target Rig.skel', atlas: 'Target Rig.atlas',
  }), target);
  assert.equal(resolveIndexedPreviewSet([target, { ...target, label: 'duplicate' }], {
    skeleton: 'Target Rig.skel', atlas: 'Target Rig.atlas',
  }), null, 'duplicate matching source sets must be treated as ambiguous');
  assert.equal(resolveIndexedPreviewSet([unrelated, target], {
    skeleton: 'Missing.skel', atlas: 'Missing.atlas',
  }), null, 'missing indexed source files must not fall back to another set');
  assert.equal(resolveIndexedPreviewSet([unrelated, target], {}), null,
    'multiple sets without indexed source names must not select the first set');
  assert.equal(resolveIndexedPreviewSet([target], {}), target,
    'one discovered source set is unambiguous when the index has no file names');
});

test('preview player never chooses the first discovered set for an unavailable animation', () => {
  const initialSet = section(preview, 'function initialSet()', 'function initialAnimation(set)');
  assert.match(initialSet, /if \(queryAnimation\) \{/);
  assert.match(initialSet, /const matches = sets\.filter\(\(set\) => setHasAnimation\(set, queryAnimation\)\)/);
  assert.match(initialSet, /return matches\.length === 1 \? matches\[0\] : null/);
  assert.match(initialSet, /return sets\.length === 1 \? sets\[0\] : null/);
  assert.doesNotMatch(initialSet, /sets\[0\] \|\| null/);
  assert.match(preview, /const indexedSet = resolveIndexedPreviewSet\(sets, entry\)/);
  assert.match(preview, /if \(indexedSet\) sets\.splice\(0, sets\.length, indexedSet\);\s*else sets\.length = 0;/);
});

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

test('video target is restricted to the indexed defaultAnimation', () => {
  const resolver = section(preview, 'function resolvePreviewTarget(entry', '// Compact download picker');
  assert.match(resolver, /const chosen = typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : '';/);
  assert.doesNotMatch(resolver, /entry\?\.webmPreview/);
  assert.match(resolver, /lowUrl: shortClip/);
  assert.doesNotMatch(resolver, /for \(const a of animations\)/);
  assert.doesNotMatch(resolver, /candidates\.find|animations\.find/);
  assert.match(resolver, /isFallback: false/);
  const metadata = section(preview, 'function videoMetadataForEntry(', 'function ');
  assert.match(metadata, /const contentUrl = target\.url \? entryVideoAsset\(target\.url, entry, 'webm'\) : ''/);
  assert.match(metadata, /previewAnimation: target\.name/);
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

test('video watch and owner-library previews use only the selected default clip', () => {
  const videoPage = section(preview, 'function createVideoFallbackHtml(', 'function ');
  assert.match(videoPage, /const target = resolvePreviewTarget\(entry, origin\)/);
  assert.match(videoPage, /const video = target\.url \? entryVideoAsset\(target\.url, entry, 'webm'\) : ''/);
  assert.match(preview, /webmPreviewFull: target\.url \? entryVideoAsset\(target\.url, item, 'webm'\) : ''/);
  const owner = section(preview, 'const lowWebm = target.lowUrl', 'return {');
  assert.match(owner, /target\.lowUrl/);
  assert.doesNotMatch(owner, /item\?\.webmPreviewLow/);
  assert.match(preview, /previewAnimation: target\.name \|\| ''/);
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
