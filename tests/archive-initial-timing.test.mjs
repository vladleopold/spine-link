import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

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

test('hourly archive audit is deployment-gated for deploy events and still checks production on schedule', () => {
  assert.match(workflow,/schedule:\s*\n\s+- cron:\s*'17 \* \* \* \*'/,
    'the full archive must be checked hourly without triggering a deployment');
  assert.match(workflow,/workflow_run:/);
  assert.match(workflow,/release_gate:/);
  assert.match(workflow,/Deploy to Vercel/);
  assert.match(workflow,/needs\.release_gate\.outputs\.deployed == 'true'/,
    'a workflow_run cooldown skip must not count as a production release');
  assert.match(workflow,/github\.event_name != 'workflow_run'/,
    'scheduled audits must run independently of deployment events');
  assert.doesNotMatch(workflow,/^\s+push:/m,
    'live proof must not race the production deploy on main push');
  assert.match(workflow,/const img=document\.querySelector\('\.feed-card img'\)/,
    'measure the first available poster, not an arbitrary later image');
  assert.match(workflow,/await page\.locator\('\.feed-card img'\)\.first\(\)\.evaluate\(img=>img\.decode\(\)\)/,
    'wait for actual browser image decoding');
  assert.match(workflow,/assert\.ok\(initialPosterMs<=1000/);
  assert.match(workflow,/responseStartMs:[\s\S]*posterEndMs:[\s\S]*posterTransferBytes:/);
});

test('hourly archive audit traverses every page and checks real poster/video media', () => {
  assert.match(workflow,/await page\.unroute\(archiveFeedMatcher,archiveFeedAbort\)/,
    'only the embedded first page may be isolated from the feed API');
  assert.match(workflow,/End of archive/);
  assert.match(workflow,/expectedTotal/);
  assert.match(workflow,/allCards\.length,expectedTotal/);
  assert.match(workflow,/ARCHIVE_ALL_CARDS_EVIDENCE/);
  assert.match(workflow,/createImageBitmap/,'every card WebP must be decoded from real bytes');
  assert.match(workflow,/inspectWebmPrefix/,'every card WebM must be checked from real response bytes');
  assert.match(workflow,/video\.play\(\)/,'representative videos must load and play');
  assert.match(workflow,/posterDiff/,'representative poster must match its own WebM first frame');
  assert.match(workflow,/motionDiff/,'representative playback must show changing frames');
  assert.match(workflow,/frameHashes\.size>=8/,'representative videos must expose eight distinct frames');
  assert.match(workflow,/nonzeroFrames>=8/,'representative videos must expose eight nonzero frames');
  assert.match(workflow,/lazyOrderFailures/,'WebM must not be requested before its own poster');
  assert.match(workflow,/reportedCardHashes/,'the 18 known reported works and exact priority work must be targeted without public identifiers');
  assert.match(workflow,/reportedCardIndexes/);
  assert.match(workflow,/reportedPlayableIndexes/);
  assert.match(workflow,/reportedPlaybackFailures/);
  assert.match(workflow,/priorityPlayback\?\.ok===true/);
  assert.match(workflow,/createHash\('sha256'\)/);
  assert.match(workflow,/archiveIds/);
  assert.match(workflow,/reportedUnexpectedMissing/);
  assert.doesNotMatch(workflow,/\\b[A-Za-z0-9_]+-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\b/,
    'private work identifiers must not be embedded in the public live workflow');
  assert.match(workflow,/unexpectedMissing/,'missing previews must have explicit blocked/failed status');
  assert.match(workflow,/maxAppendMs<=1000/,'each archive page batch must meet the one-second target');
  assert.doesNotMatch(workflow,/JSON\.stringify\(allCards|console\.log\([^\n]*entryId/,
    'public CI logs must not disclose private work identifiers');
});

test('reported preview identities stay opaque and live browser script syntax is checked', () => {
  const block = workflow.match(/const reportedCardHashes = new Set\\(\\[([\\s\\S]*?)\\]\\);/);
  assert.ok(block, 'all reported work hashes must be declared');
  const hashes = [...block[1].matchAll(/'([a-f0-9]{64})'/g)].map(match => match[1]);
  assert.equal(hashes.length, 19, 'the audit must target all 18 reported works plus the priority work');
  assert.equal(new Set(hashes).size, 19, 'reported work hashes must be unique');
  const priority = workflow.match(/const priorityCardHash = '([a-f0-9]{64})';/);
  assert.ok(priority && hashes.includes(priority[1]), 'the priority work must be in the opaque identity set');
  const command = workflow.indexOf("node --input-type=module <<'NODE'");
  assert.ok(command >= 0, 'the live browser script must exist');
  const scriptStart = workflow.indexOf('\\n', command) + 1;
  const scriptEnd = workflow.indexOf('\\n          NODE', scriptStart);
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart, 'the browser script heredoc must be closed');
  const script = workflow.slice(scriptStart, scriptEnd).split('\\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : line).join('\\n');
  execFileSync(process.execPath, ['--check', '--input-type=module'], {
    input: script, encoding: 'utf8',
  });
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

test('archive cards expose source-level blocked status without exposing preview error text', () => {
  const source = readFileSync(new URL('../api/github-archive.js', import.meta.url), 'utf8');
  assert.match(source, /sourceWebmStatus: String\(entry\?\.webmStatus \|\| ''\)\.trim\(\)/);
  assert.match(source, /sourcePreviewStatus: String\(entry\?\.previewStatus \|\| ''\)\.trim\(\)/);
  assert.match(source, /data-source-webm-status=/);
  assert.match(source, /data-source-preview-status=/);
  assert.doesNotMatch(source, /data-preview-error=/,
    'private source error details must not be copied into public card markup');
});
