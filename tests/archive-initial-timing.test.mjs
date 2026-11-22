import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyArchiveCardMediaState } from '../lib/archive-card-media-state.mjs';

const workflow = readFileSync(new URL('../.github/workflows/archive-live-speed.yml', import.meta.url), 'utf8');

test('initial archive poster timing excludes intentional prefetch warm-up', () => {
  const firstPoster = workflow.indexOf('const initialPosterMs=Date.now()-started;');
  const warmup = workflow.indexOf('await page.waitForTimeout(1900);');
  const evidence = workflow.indexOf('initialMs:initialPosterMs');
  assert.ok(firstPoster > 0, 'missing first-poster timing checkpoint');
  assert.ok(warmup > firstPoster, 'first-poster timing includes warm-up delay');
  assert.ok(evidence > firstPoster && evidence < warmup, 'logged metric must use the captured checkpoint before warm-up');
  assert.ok(!workflow.includes('initialMs:Date.now()-started'), 'old inflated metric must not return');
});

test('first available archive poster decodes within one second after a real deployment', () => {
  assert.match(workflow,/release_gate:/,
    'live proof must have a deployment gate');
  assert.match(workflow,/Deploy to Vercel/);
  assert.match(workflow,/needs\.release_gate\.outputs\.deployed == 'true'/,
    'a cooldown skip must not count as a production release');
  assert.doesNotMatch(workflow,/^\s+schedule:/m,
    'live proof must not repeatedly benchmark stale production during quota cooldown');
  assert.doesNotMatch(workflow,/^\s+push:/m,
    'live proof must not race the production deploy on main push');
  assert.match(workflow,/const img=document\.querySelector\('\.feed-card img'\)/,
    'measure the first available poster, not an arbitrary later image');
  assert.match(workflow,/await page\.locator\('\.feed-card img'\)\.first\(\)\.evaluate\(img=>img\.decode\(\)\)/,
    'wait for actual browser image decoding');
  assert.match(workflow,/assert\.ok\(initialPosterMs<=1000/,
    'the one-second first-poster requirement must be a hard gate');
  assert.match(workflow,/responseStartMs:[\s\S]*posterEndMs:[\s\S]*posterTransferBytes:/,
    'capture navigation and poster network timings to isolate a regression');
  assert.match(workflow,/newest20Blocked/);
  assert.match(workflow,/newest20UnexpectedMissing/);
  assert.match(workflow,/Every newest-20 missing preview must have an explicit blocked status/);
  assert.doesNotMatch(workflow,/older20Missing\.map\(x=>x\.id\)|JSON\.stringify\(newest20Missing\.map\(x=>x\.id\)\)/,
    'public CI logs must not disclose private work identifiers');
});

const lifecycleWorkflow = readFileSync(new URL('../.github/workflows/keep-pull-requests-empty.yml', import.meta.url), 'utf8');
test('repository lifecycle workflow cannot close or mutate pull requests', () => {
  assert.match(lifecycleWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(lifecycleWorkflow, /pull_request_target:|schedule:|pull-requests:\s*write|issues:\s*write|pulls\.update/,
    'automatic PR closure and write permissions must remain disabled');
});

test('first archive poster is preloaded before noncritical visual enhancements', () => {
  const source = readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');
  const start = source.indexOf('function archiveHtml(');
  const end = source.indexOf('function humanizeEntryTitle(', start);
  assert.ok(start >= 0 && end > start, 'archive HTML renderer must exist');
  const archive = source.slice(start, end);
  assert.match(archive, /const firstPoster = initialItems\.find\(\(item\) => item\.poster\)\?\.poster \|\| ''/);
  assert.match(archive, /const firstPosterPreload = firstPoster/);
  assert.match(archive, /rel="preload" as="image" href="\$\{escapeHtml\(firstPoster\)\}" fetchpriority="high"/,
    'the actual first generated WebP must be preloaded from the document head');
  assert.doesNotMatch(archive, /<link rel="stylesheet" href="\/page-transitions\.css"/,
    'decorative transition CSS must not block the first poster');
  assert.doesNotMatch(archive, /<script src="\/(?:spine-embers\.js|page-transitions\.js)/,
    'decorative scripts must not delay initial DOMContentLoaded');
  assert.match(archive, /function deferOptionalEnhancementsUntilPoster\(\)/);
  assert.match(archive, /firstPoster\.addEventListener\('load',schedule/);
  assert.match(archive, /firstPoster\.addEventListener\('error',schedule/);
  assert.match(archive, /requestIdleCallback\(loadOptionalEnhancements/);
  assert.match(archive, /deferOptionalEnhancementsUntilPoster\(\);/);
});

test('every archive pagination batch enforces one-second append and poster decoding', () => {
  assert.ok(workflow.includes('const batchTimings=[];'));
  assert.ok(workflow.includes('const batchStarted=Date.now();'));
  assert.ok(workflow.includes('assert.ok(appendMs<=1000'));
  assert.ok(workflow.includes('assert.ok(posterDecodeMs<=1000'));
  assert.ok(workflow.includes('maxAppendMs:'));
  assert.ok(workflow.includes('maxPosterDecodeMs:'));
});

test('archive cards bind the selected animation fingerprint to the exact player URL', () => {
  const source = readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');
  assert.match(source, /animationHash: name \? createHash\('sha256'\)\.update\(name\)\.digest\('hex'\) : ''/);
  assert.match(source, /animationHash: selectedPreview\?\.animationHash \|\| ''/);
  assert.match(source, /data-animation-hash=/);
  assert.match(source, /card\.dataset\.animationHash=item\.animationHash\|\|''/);
  assert.doesNotMatch(source, /data-animation-name=/,
    'the raw animation name must not be duplicated into public card metadata');
  assert.ok(workflow.includes("import { createHash } from 'node:crypto';"));
  assert.match(workflow, /expectedAnimationHash!==row\.animationHash/,
    'the live all-pages audit must compare the exact player query with the card fingerprint');
});

test('archive cards expose source-level blocked status without exposing preview error text', () => {
  const source = readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');
  assert.match(source, /sourceWebmStatus: String\(entry\?\.webmStatus \|\| ''\)\.trim\(\)/);
  assert.match(source, /sourcePreviewStatus: String\(entry\?\.previewStatus \|\| ''\)\.trim\(\)/);
  assert.match(source, /data-source-webm-status=/);
  assert.match(source, /data-source-preview-status=/);
  assert.doesNotMatch(source, /data-preview-error=/,
    'private source error details must not be copied into public card markup');
});


test('all archive pages require exact source status before accepting blank or populated cards', () => {
  const blocked = { poster: '', video: '', sourceWebmStatus: 'blocked-missing-source', sourcePreviewStatus: 'blocked' };
  const failed = { poster: '', video: '', sourceWebmStatus: 'failed', sourcePreviewStatus: 'failed' };
  assert.equal(classifyArchiveCardMediaState(blocked), 'blocked');
  assert.equal(classifyArchiveCardMediaState(failed), 'failed');
  assert.equal(classifyArchiveCardMediaState({ ...blocked, sourceWebmStatus: 'ready', sourcePreviewStatus: 'ready' }), 'missing');
  assert.equal(classifyArchiveCardMediaState({ ...blocked, sourceWebmStatus: 'pending', sourcePreviewStatus: 'pending' }), 'missing');
  assert.equal(classifyArchiveCardMediaState({ ...blocked, poster: 'poster.webp' }), 'partial');
  assert.equal(classifyArchiveCardMediaState({ ...blocked, poster: 'poster.webp', video: 'preview.webm' }), 'stale-media');
  assert.equal(classifyArchiveCardMediaState({ poster: 'poster.webp', video: 'preview.webm', sourceWebmStatus: 'ready', sourcePreviewStatus: 'ready' }), 'ready');
  assert.match(workflow, /sourceWebmStatus:card\.dataset\.sourceWebmStatus/);
  assert.match(workflow, /sourcePreviewStatus:card\.dataset\.sourcePreviewStatus/);
  assert.match(workflow, /classifyArchiveCardMediaState\(row\)/);
});

test('live archive verification traverses every page and validates every displayed poster/video pair', () => {
  assert.match(workflow,/const blockArchiveFeed = url =>/);
  assert.match(workflow,/await page\.unroute\(blockArchiveFeed\)/,
    'the initial 40-card embedded proof must not prevent later API pages from loading');
  assert.match(workflow,/const expectedTotal = await page\.evaluate/);
  assert.match(workflow,/while\(scannedCards<expectedTotal\)/);
  assert.match(workflow,/await image\.decode\(\)/);
  assert.match(workflow,/httpStatus===200/);
  assert.match(workflow,/Range:'bytes=0-63'/);
  assert.match(workflow,/videoSamples/);
  assert.match(workflow,/player\.searchParams\.get\('animation'\)/);
  assert.match(workflow,/Not all archive pages were traversed/);
  assert.match(readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8'),
    /card\.dataset\.playerUrl=item\.playerUrl\|\|''/,
    'dynamic cards must expose the same exact player URL used by the click handler');
});
