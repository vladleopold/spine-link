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

test('first poster timing starts at document commit, not after deferred scripts', () => {
  assert.match(workflow,/waitUntil:'commit',timeout:45000/);
  assert.doesNotMatch(workflow,/waitUntil:'domcontentloaded',timeout:45000/);
});

test('first poster is measured before waiting for deferred document scripts', () => {
  const firstPoster = workflow.indexOf('const initialPosterMs=Date.now()-started;');
  const domReady = workflow.indexOf("await page.waitForLoadState('domcontentloaded'");
  const htmlRead = workflow.indexOf('const firstHtml=await page.content();');
  assert.ok(firstPoster > 0 && domReady > firstPoster && htmlRead > domReady,
    'measure the poster as soon as decoded, then wait for full DOM before inspecting all cards');
});

const archiveSource = readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');

test('archive HTML and lazy feed retain the CDN snapshot across cold visitors', () => {
  const cachePolicy = 'public, s-maxage=300, stale-while-revalidate=900';
  assert.equal(archiveSource.split(cachePolicy).length - 1, 2,
    'both archive HTML and JSON feed must use the five-minute CDN cache');
});

test('live archive browser audit runs hourly even when deploy is skipped', () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron: '17 \* \* \* \*'/);
  assert.match(workflow, /github\.event_name != 'workflow_run'/,
    'scheduled runs must not inherit the deployment-only success gate');
  assert.match(workflow, /github\.event_name != 'pull_request'[\s\S]*ARCHIVE_BASE_URL=https:\/\/spine-link\.vercel\.app/,
    'non-PR scheduled runs must audit the production alias');
});

test('first-poster timeout records only sanitized browser evidence', () => {
  assert.ok(workflow.includes('ARCHIVE_FIRST_POSTER_FAILURE'));
  assert.ok(workflow.includes('imageResponses.map'));
  assert.ok(workflow.includes('contentType:x.contentType'));
  assert.ok(workflow.includes('requestFailureCount'));
  const diagnostic = workflow.slice(workflow.indexOf('ARCHIVE_FIRST_POSTER_FAILURE'), workflow.indexOf('throw error;', workflow.indexOf('ARCHIVE_FIRST_POSTER_FAILURE')));
  assert.ok(!diagnostic.includes('url:'), 'failure diagnostic must not expose asset URLs');
});
