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

test('first visible archive card decodes its WebP within one second and runs hourly', () => {
  assert.match(workflow,/schedule:\s*\n\s+- cron: '7 \* \* \* \*'/,
    'archive live proof must run hourly');
  assert.match(workflow,/const img=document\.querySelector\('\.feed-card img'\)/,
    'measure the first card, not any later image');
  assert.match(workflow,/await page\.locator\('\.feed-card img'\)\.first\(\)\.evaluate\(img=>img\.decode\(\)\)/,
    'wait for actual browser image decoding');
  assert.match(workflow,/assert\.ok\(initialPosterMs<=1000/,
    'the one-second first-card requirement must be a hard gate');
  assert.match(workflow,/responseStartMs:[\s\S]*posterEndMs:[\s\S]*posterTransferBytes:/,
    'capture navigation and poster network timings to isolate a regression');
  assert.doesNotMatch(workflow,/older20Missing\.map\(x=>x\.id\)|JSON\.stringify\(newest20Missing\.map\(x=>x\.id\)\)/,
    'public CI logs must not disclose private work identifiers');
});
