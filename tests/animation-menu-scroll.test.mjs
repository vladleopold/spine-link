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


const heightSyncStart = source.indexOf('const playerElement = document.getElementById("player")');
const heightSyncEnd = source.indexOf('const pinchDistance', heightSyncStart);
const heightSync = source.slice(heightSyncStart, heightSyncEnd);
test('desktop menu max-height follows the actual player element and resizes with it', () => {
  assert.match(heightSync, /playerElement\.getBoundingClientRect\(\)\.height/);
  assert.match(heightSync, /new ResizeObserver\(syncAnimationMenuHeight\)\.observe\(playerElement\)/);
  assert.match(heightSync, /window\.addEventListener\("resize", syncAnimationMenuHeight/);
  assert.match(heightSync, /window\.innerWidth <= 1000/);
  assert.match(heightSync, /removeProperty\("--animation-menu-player-height"\)/);
  const desktopCss = source.slice(source.indexOf('@media (min-width: 1001px)'), source.indexOf('</style>'));
  assert.match(desktopCss, /height: auto !important;[\s\S]*max-height: var\(--animation-menu-player-height[\s\S]*overflow-y: auto !important/);
  const mobileCss = source.slice(source.indexOf('@media (max-width: 1000px)'), source.indexOf('</style>'));
  assert.match(mobileCss, /\.animation-menu, \.animation-card\.is-open \.animation-menu \{ max-height: none !important; height: auto !important; overflow: visible !important; \}/);
});

test('all secondary sidebar sections remain below the animation menu in normal flow', () => {
  const responsiveCss = source.slice(source.indexOf('/* Responsive /p pages'), source.indexOf('</style>'));
  assert.match(responsiveCss, /#app \{ height: auto !important;[\s\S]*overflow: visible !important;/);
  assert.match(responsiveCss, /#sidebar \{ height: auto !important;[\s\S]*overflow: visible !important;/);
  for (const rule of [
    /#sidebar > #animation-card \{ order: 1 !important; \}/,
    /#sidebar > \.animation-download-block \{ order: 2 !important; \}/,
    /#sidebar > \.video-watch-panel--below-list \{ order: 3 !important; \}/,
    /#sidebar > \.proof-card \{ order: 4 !important; \}/,
    /#sidebar > #owner-library \{ order: 5 !important; \}/,
    /#sidebar > #set-card, #sidebar > \.note-card \{ order: 6 !important; \}/,
  ]) assert.match(responsiveCss, rule);
});

const browserWorkflow = fs.readFileSync(new URL('../.github/workflows/spine-link-browser-smoke.yml', import.meta.url), 'utf8');
test('live animation-menu scroll gate stays strict and runs only after production deploy', () => {
  assert.ok(browserWorkflow.includes('  workflow_run:'));
  assert.ok(browserWorkflow.includes('workflows: ["Vercel deploy and alias"]'));
  assert.ok(!browserWorkflow.includes('  pull_request:'),
    'a PR must not run production browser checks against the old production deployment');
  assert.ok(!browserWorkflow.includes('  push:'),
    'the smoke must wait for the deployment workflow, not race it on main push');
  assert.ok(browserWorkflow.includes('release_gate:'));
  assert.ok(browserWorkflow.includes('Deploy to Vercel'));
  assert.ok(browserWorkflow.includes("needs.release_gate.outputs.deployed == 'true'"));
  assert.ok(browserWorkflow.includes('farSelectionVisible'));
  assert.ok(browserWorkflow.includes('A newly selected off-screen animation must be revealed'));
});

const uploadWorkflow = fs.readFileSync(new URL('../.github/workflows/spine-link-upload-e2e.yml', import.meta.url), 'utf8');
test('production upload/delete e2e requires a real successful Chromium job', () => {
  assert.ok(uploadWorkflow.includes('release_gate:'));
  assert.ok(uploadWorkflow.includes('select(.name == "chromium" and .conclusion == "success")'));
  assert.ok(uploadWorkflow.includes("needs.release_gate.outputs.verified == 'true'"));
});
