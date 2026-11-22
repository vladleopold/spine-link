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
  assert.ok(browserWorkflow.includes('if [ "$deployed" != "true" ]; then'),
    'a skipped Vercel deploy must fail the production browser-proof gate');
  assert.ok(browserWorkflow.includes('PRODUCTION_BROWSER_PROOF_BLOCKED_NO_REAL_DEPLOYMENT'));
  assert.ok(browserWorkflow.includes('exit 1'));
  assert.ok(browserWorkflow.includes('farSelectionVisible'));
  assert.ok(browserWorkflow.includes('A newly selected off-screen animation must be revealed'));
});

const uploadWorkflow = fs.readFileSync(new URL('../.github/workflows/spine-link-upload-e2e.yml', import.meta.url), 'utf8');
test('production upload/delete e2e requires a real successful Chromium job', () => {
  assert.ok(uploadWorkflow.includes('release_gate:'));
  assert.ok(uploadWorkflow.includes('select(.name == "chromium" and .conclusion == "success")'));
  assert.ok(uploadWorkflow.includes("needs.release_gate.outputs.verified == 'true'"));
});
