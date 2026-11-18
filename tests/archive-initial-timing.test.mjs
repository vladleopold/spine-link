import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/archive-live-speed.yml', import.meta.url), 'utf8');

test('initial archive poster timing excludes intentional prefetch warm-up', () => {
  const firstPoster = workflow.indexOf('const initialPosterMs=Date.now()-started;');
  const warmup = workflow.indexOf('await page.waitForTimeout(1900);');
  const evidence = workflow.indexOf('initialMs:initialPosterMs');
  assert.ok(firstPoster > 0, 'missing first-poster timing checkpoint');
  assert.ok(warmup > firstPoster, 'first-poster timing includes warm-up delay');
  assert.ok(evidence > warmup, 'logged metric must use the captured checkpoint');
  assert.ok(!workflow.includes('initialMs:Date.now()-started'), 'old inflated metric must not return');
});
