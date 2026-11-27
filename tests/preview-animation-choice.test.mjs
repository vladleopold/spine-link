import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePreviewAnimation } from '../scripts/preview-animation-choice.mjs';

test('preserves an explicit selected animation exactly', () => {
  assert.equal(choosePreviewAnimation(['idle', 'Walk'], 'Walk'), 'Walk');
});

test('preserves explicit animation identity for exact validation after runtime load', () => {
  assert.equal(choosePreviewAnimation(['idle', 'Walk'], 'run'), 'run');
});

test('chooses exact idle as the safe default when no animation is selected', () => {
  assert.equal(choosePreviewAnimation(['Walk', 'Idle', 'Hit'], ''), 'Idle');
});

test('uses the sole runtime animation when no default is indexed', () => {
  assert.equal(choosePreviewAnimation(['appear'], ''), 'appear');
});

test('does not guess when multiple animations exist without idle', () => {
  assert.equal(choosePreviewAnimation(['appear', 'hit', 'disappear'], ''), '');
});

test('does not guess when runtime animation discovery returns no tracks', () => {
  assert.equal(choosePreviewAnimation([], ''), '');
});

test('resolves the Spine-Link automatic animation sentinel to a valid default track', () => {
  assert.equal(choosePreviewAnimation(['walk', 'Idle', 'hit'], '__SPINE_AUTO__', 'Idle'), 'Idle');
});

test('uses a valid indexed default before automatic fallback tracks', () => {
  assert.equal(choosePreviewAnimation(['walk', 'hit'], '__SPINE_AUTO__', 'hit'), 'hit');
});

test('falls back to the first real runtime track for automatic playback', () => {
  assert.equal(choosePreviewAnimation(['walk', 'hit'], '__SPINE_AUTO__', 'missing'), 'walk');
});

test('does not return the automatic sentinel when the skeleton has no tracks', () => {
  assert.equal(choosePreviewAnimation([], '__SPINE_AUTO__', ''), '');
});
