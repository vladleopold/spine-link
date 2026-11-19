import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderAnimationList()');
const end = source.indexOf('function syncPreviewLike()', start);
assert.ok(start >= 0 && end > start, 'renderAnimationList source must exist');
const render = source.slice(start, end);

test('desktop animation menu preserves scroll unless the active row is clipped', () => {
  assert.match(render, /const previousScrollTop = animationMenu\.scrollTop/);
  assert.match(render, /animationMenu\.scrollTop = previousScrollTop/);
  assert.match(render, /const selected = animationMenu\.querySelector\("button\.active"\)/);
  assert.match(render, /selected && window\.innerWidth > 1000/);
  assert.match(render, /selectedBox\.top < listBox\.top/);
  assert.match(render, /selectedBox\.bottom > listBox\.bottom/);
  assert.match(render, /animationMenu\.scrollTop -= listBox\.top - selectedBox\.top/);
  assert.match(render, /animationMenu\.scrollTop \+= selectedBox\.bottom - listBox\.bottom/);
  assert.match(render, /animationMenu\.scrollTop \+= selectedBox\.top - listBox\.top/);
});

test('first render still centers the URL-selected animation without scrolling the page', () => {
  assert.match(render, /else if \(window\.innerWidth > 1000 && animationMenu\.scrollHeight > animationMenu\.clientHeight\)/);
  assert.match(render, /animationMenu\.scrollTop \+= selectedBox\.top - listBox\.top/);
});
