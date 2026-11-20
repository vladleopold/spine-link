import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findMatchingVercelProject } from '../scripts/resolve-vercel-preview-comment.mjs';

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

test('hourly production archive audit stays read-only during deployment cooldown', () => {
  assert.match(workflow,/release_gate:/,
    'post-deploy live proof must retain its deployment gate');
  assert.match(workflow,/Deploy to Vercel/);
  assert.match(workflow,/needs\.release_gate\.outputs\.deployed == 'true'/,
    'a cooldown skip must not count as a production release');
  assert.match(workflow,/^\s+schedule:/m,
    'the public archive must still receive its hourly read-only production audit during quota cooldown');
  assert.match(workflow,/cron: '43 \* \* \* \*'/);
  assert.match(workflow,/SITE: https:\/\/spine-link\.vercel\.app/,
    'scheduled audits must inspect the current public production alias');
  assert.match(workflow,/github\.event_name != 'workflow_run'/,
    'scheduled audits must run without pretending a deployment occurred');
  assert.ok(workflow.includes("if(/\\.webp(?:\\?|$)/i.test(url))"),
    'poster HTTP monitoring must match real WebP URLs, not a literal backslash');
  assert.ok(workflow.includes("if(/\\.(?:webm|webp)(?:\\?|$)/i.test(url)"),
    'asset HTTP monitoring must match actual media extensions');
  assert.doesNotMatch(workflow,/^\s+run:\s*vercel\s+(?:deploy|alias)\b/im,
    'the hourly browser audit must never deploy or mutate production');
  assert.doesNotMatch(workflow,/^\s+push:/m,
    'live proof must not race the production deploy on main push');
  assert.match(workflow,/const img=document\.querySelector\('\.feed-card img'\)/,
    'measure the first available poster, not an arbitrary later image');
  assert.match(workflow,/await page\.locator\('\.feed-card img'\)\.first\(\)\.evaluate\(img=>img\.decode\(\)\)/,
    'wait for actual browser image decoding');
  assert.match(workflow,/if\(initialPosterMs>1000\)failures\.push\('initial-poster-slow'\)/,
    'the one-second first-poster requirement must add a hard failure');
  assert.match(workflow,/assert\.equal\(failures\.length,0/,
    'recorded browser audit failures must fail the job');
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
  assert.match(archive, /let eligiblePosterIndex = 0/);
  assert.match(archive, /item\.poster && item\.video \? eligiblePosterIndex\+\+ : -1/,
    'poster priority must count eligible same-work pairs, not blocked card positions');
  assert.match(source, /posterIndex >= 0 && posterIndex < 4/);
  assert.match(source, /posterIndex >= 0 && posterIndex < 2/);
  assert.match(archive, /const posterPreloads = initialItems[\s\S]*?\.slice\(0, 4\)/);
  assert.match(archive, /href="\$\{escapeHtml\(item\.poster\)\}" fetchpriority="\$\{index < 2 \? 'high' : 'low'\}"/,
    'the first four eligible WebP posters must be preloaded before client script execution');
  assert.match(archive, /\$\{posterPreloads\}/);
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


test('Vercel resolver skips newer failed comments and matches the exact commit status URL', () => {
  const inspectorUrl = 'https://vercel.example/deployment/exact-head';
  const previewUrl = 'https://spine-link-git-test-leopoldus-projects.vercel.app';
  const payload = Buffer.from(JSON.stringify({projects:[{
    name:'spine-link',inspectorUrl,previewUrl,nextCommitStatus:'DEPLOYED'
  }]})).toString('base64');
  const comments = [
    {user:{login:'vercel[bot]'},body:'[vc]: #signature:'+payload+'\nDeployment ready'},
    {user:{login:'vercel[bot]'},body:'Deployment failed: build rate limit'},
    {user:{login:'unrelated-user'},body:'[vc]: #signature:'+payload},
  ];
  const match = findMatchingVercelProject(comments, inspectorUrl);
  assert.equal(match?.previewUrl, previewUrl);
  assert.equal(match?.nextCommitStatus, 'DEPLOYED');
  assert.equal(findMatchingVercelProject(comments, 'https://vercel.example/other-head'), null);
});

test('PR live proof uses only the successful Vercel preview for the exact head SHA', () => {
  assert.ok(workflow.includes('pull_request:'), 'archive changes must receive a live preview browser check');
  assert.ok(workflow.includes('EXPECTED_SHA: $' + '{{ github.event.pull_request.head.sha }}'),
    'the preview lookup must be tied to the PR head SHA');
  assert.ok(workflow.includes("'/statuses/' + expectedSha"),
    'read the Vercel status for that exact commit');
  assert.ok(workflow.includes('inspector') && workflow.includes('target'),
    'reject stale preview comments whose deployment inspector does not match the commit status');
  assert.ok(workflow.includes("deploymentStatus === 'DEPLOYED'") && workflow.includes("vercelStatus.state === 'success'"),
    'require both Vercel deployment payload and commit status to be successful');
  assert.ok(workflow.includes("appendFileSync(process.env.GITHUB_ENV, 'SITE=' + previewUrl.origin"),
    'run Playwright against the verified preview URL, not production');
  assert.ok(workflow.includes("const site=(process.env.SITE||'https://spine-link.vercel.app').replace(/\\/+$/,'')"));
  assert.ok(workflow.includes("page.goto(site+'/world-spine-archive'"));
  const resolverStart = workflow.indexOf('name: Resolve the ready Vercel preview for this exact PR commit');
  const resolverEnd = workflow.indexOf('name: Install Playwright', resolverStart);
  const resolverStep = workflow.slice(resolverStart, resolverEnd);
  assert.ok(resolverStep.includes('        shell: bash'),
    'the resolver must use Bash for predictable shell semantics');
  assert.ok(resolverStep.includes('node --input-type=module'),
    'resolve preview metadata with the Node runtime already present in the Playwright image');
  assert.ok(!resolverStep.includes('gh api'),
    'the Playwright container does not include the GitHub CLI');
  assert.ok(resolverStep.includes('api.github.com'),
    'the resolver must read Vercel status and comments through the GitHub API');
  assert.ok(resolverStep.includes("findMatchingVercelProject(comments, vercelStatus?.target_url)"),
    'select a Vercel payload matching the exact SHA status, not the latest arbitrary bot comment');
  assert.ok(resolverStep.includes("vercelStatus?.state === 'failure'"),
    'an explicit failed Vercel status for the exact head SHA must stop polling immediately');
  assert.ok(resolverStep.includes("includes('build-rate-limit')") &&
    resolverStep.includes('VERCEL_PREVIEW_BLOCKED='),
    'report the Vercel quota blocker instead of a misleading five-minute timeout');
});


test('hourly archive browser scripts are syntax-checked without a Vercel preview',()=>{
  const blocks=[...workflow.matchAll(/node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/g)];
  assert.equal(blocks.length,2,'both preview resolver and full-library browser script must be present');
  const directory=mkdtempSync(join(tmpdir(),'spine-archive-live-'));
  try{
    for(let index=0;index<blocks.length;index++){
      const source=blocks[index][1].split(/\r?\n/).map(line=>line.startsWith('          ')?line.slice(10):line).join('\n')+'\n';
      const path=join(directory,'workflow-'+index+'.mjs');
      writeFileSync(path,source);
      execFileSync(process.execPath,['--check',path],{stdio:'pipe'});
    }
  }finally{
    rmSync(directory,{recursive:true,force:true});
  }
});
