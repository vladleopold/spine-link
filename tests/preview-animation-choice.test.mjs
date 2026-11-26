import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePreviewAnimation } from '../scripts/preview-animation-choice.mjs';

test('preserves an explicit selected animation exactly', () => {
  assert.equal(choosePreviewAnimation(['idle', 'Walk'], 'Walk'), 'Walk');
});

test('blocks an explicit animation that is not in the discovered runtime list', () => {
  assert.equal(choosePreviewAnimation(['idle', 'Walk'], 'run'), '');
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
