import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');

test('public Spine player recalculates viewport from the selected animation on initial load', () => {
  const successStart = source.indexOf('success: (loadedPlayer) =>');
  const successEnd = source.indexOf('error: (_player, reason)', successStart);
  assert.notEqual(successStart, -1, 'Spine Player success callback exists');
  const success = source.slice(successStart, successEnd);
  assert.match(success, /refitToContent\(loadedPlayer\)/);
  assert.ok(success.indexOf('refitToContent(loadedPlayer)') < success.indexOf('rememberBaseViewport()'));
});

test('public Spine player recalculates viewport after every animation switch', () => {
  const playStart = source.indexOf('function playAnimationEntry(name)');
  const playEnd = source.indexOf('function playActiveAnimationFromStart()', playStart);
  assert.notEqual(playStart, -1, 'animation playback function exists');
  const play = source.slice(playStart, playEnd);
  assert.match(play, /requestAnimationFrame\(\(\) =>\s*\{\s*refitToContent\(player\)/);
});

test('automatic viewport fitting does not override an explicitly locked author layout', () => {
  const fitStart = source.indexOf('function refitToContent(targetPlayer)');
  const fitEnd = source.indexOf('function measuredAnimationBounds', fitStart);
  const fit = source.slice(fitStart, fitEnd);
  assert.match(fit, /activeSet\.value\?\.viewport\?\.__locked/);
});

const app = readFileSync(new URL('../src/SpineApp.tsx', import.meta.url), 'utf8');

test('the main app player re-fits the initial animation before caching its viewport', () => {
  assert.match(app, /refitSpinePlayerToAnimation\(player, playableAnimation\)/);
});

test('the main app player re-fits the viewport after animation selection changes', () => {
  assert.match(app, /refitSpinePlayerToAnimation\(playerRef\.current, animationName\)/);
});

test('the modal Spine player uses the same automatic viewport fitting', () => {
  assert.match(app, /refitSpinePlayerToAnimation\(player, initial\)/);
});
