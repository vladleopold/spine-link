import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/archive-live-speed.yml', import.meta.url), 'utf8');
const livePreviewWorkflow = readFileSync(new URL('../.github/workflows/spine-link-live-preview-smoke.yml', import.meta.url), 'utf8');
const archiveSource = readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');

test('initial archive poster timing excludes intentional prefetch warm-up when a poster exists', () => {
  const firstPoster = workflow.indexOf('initialPosterMs=Date.now()-started;');
  const warmup = workflow.indexOf('await page.waitForTimeout(1900);');
  const evidence = workflow.indexOf('initialMs:initialPosterMs');
  assert.ok(firstPoster > 0, 'missing first-poster timing checkpoint');
  assert.ok(warmup > firstPoster, 'first-poster timing includes warm-up delay');
  assert.ok(evidence > firstPoster && evidence < warmup, 'logged metric must use the captured checkpoint before warm-up');
  assert.ok(!workflow.includes('initialMs:Date.now()-started'), 'old inflated metric must not return');
});

test('archive continues from embedded cards to API pages while the sentinel remains near the viewport',()=>{
  assert.match(archiveSource,/const embeddedStart=offset-initialItems\.length/);
  assert.match(archiveSource,/if\(embeddedBatch\.length\)/);
  assert.match(archiveSource,/if\(!data\)data=await fetchPage\(offset\)/);
  assert.match(archiveSource,/if\(rect\.top<=window\.innerHeight\+2200\)void loadMore\(\)/);
});

test('first available archive poster decodes within one second when the initial batch has one', () => {
  assert.match(workflow,/release_gate:/,
    'live proof must have a deployment gate');
  assert.match(workflow,/Deploy to Vercel/);
  assert.match(workflow,/needs\.release_gate\.outputs\.deployed == 'true'/,
    'a cooldown skip must not count as a production release');
  assert.doesNotMatch(workflow,/^\s+schedule:/m,
    'live proof must not repeatedly benchmark stale production during quota cooldown');
  assert.match(workflow,/push:\s*branches:\s*\[main\]\s*paths:\s*-\s*'\.github\/workflows\/archive-live-speed\.yml'/,
    'read-only diagnostics may run when this workflow itself changes');
  assert.doesNotMatch(workflow,/push:[\s\S]*?paths:[\s\S]*?api\/github-archive\.js/,
    'application pushes must wait for the production deploy gate');
  assert.match(workflow,/if\(initialPosterCount>0\)/,
    'only measure a first poster when the initial archive batch has an eligible preview');
  assert.match(workflow,/const img=document\.querySelector\('\.feed-card \.feed-media img'\)/,
    'measure the first available media poster');
  assert.match(workflow,/await firstPoster\.evaluate\(img=>img\.decode\(\)\)/,
    'wait for actual browser image decoding');
  assert.match(workflow,/no eligible WebP poster in the first card batch/,
    'media-free initial batches must be reported rather than treated as a broken poster');
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
test('live preview smoke skips cooldown-only deploy workflow runs',()=>{
  assert.match(livePreviewWorkflow,/release_gate:/);
  assert.match(livePreviewWorkflow,/Deploy to Vercel/);
  assert.match(livePreviewWorkflow,/needs\.release_gate\.outputs\.deployed == 'true'/);
  const job=livePreviewWorkflow.split('  production-preview:')[1]||'';
  assert.equal((job.match(/^\s+if:/gm)||[]).length,1,
    'production-preview must have exactly one job condition');
  assert.doesNotMatch(livePreviewWorkflow,/commits\/\$DEPLOY_SHA\/status/,
    'a stale success status must not trigger another production smoke run');
});

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

test('archive cards expose source-level blocked status without exposing preview error text', () => {
  const source = readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');
  assert.match(source, /sourceWebmStatus: String\(entry\?\.webmStatus \|\| ''\)\.trim\(\)/);
  assert.match(source, /sourcePreviewStatus: String\(entry\?\.previewStatus \|\| ''\)\.trim\(\)/);
  assert.match(source, /data-source-webm-status=/);
  assert.match(source, /data-source-preview-status=/);
  assert.doesNotMatch(source, /data-preview-error=/,
    'private source error details must not be copied into public card markup');
});

test('archive lazy-pagination proof observes feed traffic without blocking later pages', () => {
  assert.match(workflow, /const archiveFeedRequests=\[\]/);
  assert.match(workflow, /page\.on\('request'/);
  assert.match(workflow, /serverRenderedCards:/);
  assert.doesNotMatch(workflow, /page\.route\(url=>url\.pathname===['"]\/api\/github-archive/);
  assert.match(workflow, /page\.locator\('#sentinel'\)\.scrollIntoViewIfNeeded\(\)/);
});
