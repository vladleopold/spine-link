import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  assert.ok(startup.includes('...(requestedAnimation ? { animation: requestedAnimation } : {})'));
  const missingTrackGuard = startup.indexOf('if (requestedAnimation && !names.includes(requestedAnimation))');
  const blocked = startup.indexOf('markPreviewBlocked("SELECTED_SPINE_ANIMATION_UNAVAILABLE")', missingTrackGuard);
  const blockedReturn = startup.indexOf('return;', blocked);
  const playback = startup.indexOf('playActiveAnimationFromStart()');
  assert.ok(missingTrackGuard >= 0 && blocked > missingTrackGuard && blockedReturn > blocked && playback > blockedReturn,
    'missing requested tracks must be blocked before playback starts');
  assert.doesNotMatch(startup, /(?:names|animations|filteredNames)\s*\[\s*0\s*\]/);
});

test('URL-selected animations are resolved across all skeleton sets before blocking', () => {
  assert.match(preview, /const attemptedAnimationSets = new Set\(\)/);
  assert.match(preview, /attemptedAnimationSets\.add\(animationSetKey\(activeSet\.value\)\)/);
  const startup = section(preview, 'async function createPlayer()', 'function renderAnimationList()');
  assert.match(startup, /const nextSet = sets\.find\(\(set\) => !attemptedAnimationSets\.has\(animationSetKey\(set\)\)\)/);
  assert.match(startup, /activeSet\.value = nextSet/);
  assert.match(startup, /createPlayer\(\)/);
  assert.match(startup, /attemptedAnimationSets\.clear\(\)/);
});

test('player does not pass an empty or incomplete selectable-animation list to Spine Player', () => {
  const startup = section(preview, 'async function createPlayer()', 'function renderAnimationList()');
  assert.match(startup, /const playerSet = \{ \.\.\.activeSet\.value \}/);
  assert.match(startup, /if \(requestedAnimation\) \{/);
  assert.match(startup, /new Set\(\[\.\.\.indexedAnimations, requestedAnimation\]\)/);
  assert.match(startup, /delete playerSet\.animation/);
  assert.match(startup, /delete playerSet\.animations/);
  assert.match(startup, /\.\.\.playerSet,/);
  assert.match(startup, /names\.includes\(requestedAnimation\)/,
    'the loaded skeleton remains the source of truth for whether the track exists');
});

test('viewport healing measures only the selected animation', () => {
  const refit = section(preview, 'function refitToContent(', 'function measuredAnimationBounds(');
  const measured = section(preview, 'function measuredAnimationBounds(', 'let healAttempts');
  assert.match(refit, /const active = typeof activeAnimation\.name === 'string' \? activeAnimation\.name : ''/);
  assert.match(refit, /if \(!active \|\| !names\.includes\(active\)\) return false/);
  assert.doesNotMatch(refit, /names\[0\]/);
  assert.match(measured, /findAnimation\(animationName\)/);
  assert.match(measured, /if \(!animationName\) return null/);
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

test('binary skeletons use the indexed animation list when server-side JSON parsing is unavailable', () => {
  const dynamic = section(preview, 'const runtimeAnimationNames = animationNamesFromJson(skeletonJson);', "const defaultAnimation = typeof entry?.defaultAnimation === 'string' ? entry.defaultAnimation : '';");
  assert.match(dynamic, /Array\.isArray\(entry\?\.animations\)/);
  assert.match(dynamic, /skeleton\.name\.toLowerCase\(\)\.endsWith\('\.skel'\)/);
  assert.match(dynamic, /runtimeAnimationNames\.length\s*\?\s*runtimeAnimationNames/);
  assert.match(dynamic, /indexedAnimationNames/);
  assert.match(preview, /const defaultAnimation = typeof entry\?\.defaultAnimation === 'string' \? entry\.defaultAnimation : ''/);
});

test('missing index default loads the verified skeleton and exposes its runtime animation list', () => {
  const startup = section(preview, 'async function createPlayer()', 'function renderAnimationList()');
  assert.doesNotMatch(startup, /if \(!activeAnimation\.name\)/);
  assert.match(startup, /if \(requestedAnimation && !names\.includes\(requestedAnimation\)\)/);
  assert.match(startup, /requestedAnimation \? \{ animation: requestedAnimation \} : \{\}/);
  assert.match(startup, /if \(requestedAnimation\) \{[\s\S]*playActiveAnimationFromStart\(\)/);
  const playback = section(preview, 'function playActiveAnimationFromStart()', 'function togglePlayback()');
  assert.match(playback, /if \(!player \|\| !activeAnimation\.name\) return false/);
});

test('stale indexed default is recoverable but an explicit missing URL selection stays blocked', () => {
  const startup = section(preview, 'async function createPlayer()', 'function renderAnimationList()');
  const mismatch = startup.indexOf('if (requestedAnimation && !names.includes(requestedAnimation))');
  const recovery = startup.indexOf('if (!queryValue("animation"))', mismatch);
  const blocked = startup.indexOf('markPreviewBlocked("SELECTED_SPINE_ANIMATION_UNAVAILABLE")', mismatch);
  assert.ok(mismatch >= 0 && recovery > mismatch && blocked > recovery);
  assert.match(startup.slice(recovery, blocked), /activeAnimation\.name = ""/);
  assert.match(startup.slice(recovery, blocked), /renderAnimationList\(\)/);
});

test('Spine Player 3.8 void setAnimation return is handled via AnimationState current track', () => {
  const playback = section(preview, 'function playAnimationEntry(name)', 'function playActiveAnimationFromStart()');
  assert.match(playback, /const setResult = player\.setAnimation\(name, loopEnabled\.value\)/);
  assert.match(playback, /const entry = setResult \|\| player\.animationState\?\.getCurrent\?\.\(0\)/);
  assert.match(playback, /if \(!entry\)/);
  assert.match(playback, /entry\.listener =/);
});

test('missing default does not pass empty animation strings or silently select the first track', () => {
  const startup = section(preview, 'async function createPlayer()', 'function renderAnimationList()');
  assert.match(startup, /if \(requestedAnimation\) \{[\s\S]*playerSet\.animation = requestedAnimation/);
  assert.match(startup, /else \{[\s\S]*delete playerSet\.animation;[\s\S]*delete playerSet\.animations/);
  assert.match(startup, /\.\.\.\(requestedAnimation \? \{ animation: requestedAnimation \} : \{\}\)/);
});

test('known-bad Spine 3.8.75 exports are identified before runtime initialization', () => {
  const startup = section(preview, 'async function createPlayer()', 'function renderAnimationList()');
  assert.match(startup, /String\(activeSet\.value\.skeletonVersion \|\| ""\) === "3\.8\.75"/);
  assert.match(startup, /markPreviewBlocked\("UNSUPPORTED_SPINE_3_8_75"\)/);
  assert.match(preview, /Re-export the original Spine project with Spine 3\.8\.99/);
});

test('empty animation names are guarded before Spine 4.3 findAnimation viewport measurement', () => {
  const measured = section(preview, 'function measuredAnimationBounds(', 'let healAttempts');
  assert.match(measured, /const animationName = typeof activeAnimation\.name === "string" \? activeAnimation\.name\.trim\(\) : ""/);
  assert.match(measured, /if \(!animationName\) return null/);
  assert.match(measured, /findAnimation\(animationName\)/);
  assert.doesNotMatch(measured, /findAnimation\(activeAnimation\.name\)/);
});

test('binary Spine skeletons mislabeled with a .json extension use the binary runtime URL', () => {
  const loader = section(preview, 'let skeletonJson = null;', 'const runtimeAnimationNames = animationNamesFromJson(skeletonJson);');
  assert.match(loader, /let skeletonIsBinary = \/\\.\(\?:skel\|bytes\)\$\/i\.test\(skeleton\.name\)/);
  assert.match(loader, /const binaryVersion = spineBinaryVersionFromBase64\(await githubFileHead\(settings, skeleton\.path, 256\)\)/);
  assert.match(loader, /if \(binaryVersion\) \{\s*skeletonVersion = binaryVersion;\s*skeletonIsBinary = true;/);
  assert.match(preview, /skeletonIsBinary \? \{ skelUrl: skeletonUrl \} : \{ jsonUrl: skeletonUrl \}/);
});

test('missing default animation uses an explicit safe viewport for Spine 4.1 setup pose', () => {
  assert.match(preview, /viewport: requestedAnimation\s*\? measuredViewport\(activeSet\.value\)\s*:\s*\{ \.\.\.measuredViewport\(activeSet\.value\), x: -4096, y: -4096, width: 8192, height: 8192 \}/);
});

test('preview builds Spine set file lists from the indexed file manifest when GitHub directory listing is throttled', () => {
  const discovery = section(preview, 'async function findSpineSetDirectories(', '// Download buttons');
  assert.match(discovery, /Array\.isArray\(indexedEntry\?\.files\)/);
  assert.match(discovery, /descendantTextures/);
  assert.match(discovery, /path: joinRepoPath\(uploadPath, filePath\)/);
  const dynamic = section(preview, 'async function createDynamicPreview(', '// Finds the folder of a work by id');
  assert.match(dynamic, /findSpineSetDirectories\(settings, uploadPath, 3, entry\)/);
  assert.match(dynamic, /Array\.isArray\(directory\.items\) \? directory\.items : await githubList/);
});

test('Spine version preflight accepts supported major.minor strings without a patch number', () => {
  assert.match(preview, /\^\(\?:3\\\.\(\?:7\|8\)\(\?:\\\.\|\$\)\|4\\\.\[0-3\]\(\?:\\\.\|\$\)\)/);
});
