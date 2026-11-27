import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createProductionSmokeMetricsResponse } from '../scripts/lib/production-smoke-metrics.mjs';

const site = process.env.SITE;
assert.ok(site, 'SITE must point at the public preview site');
const id = 'Spine-animation-2026-11-20T10-01-52-055Z';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.route('**/api/github-upload', async route => {
  let payload = {};
  try { payload = JSON.parse(route.request().postData() || '{}'); } catch {}
  const mocked = createProductionSmokeMetricsResponse(payload);
  if (!mocked) return route.continue();
  await route.fulfill({
    status: mocked.status,
    contentType: 'application/json',
    body: JSON.stringify(mocked.body),
  });
});
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));

try {
  const response = await page.goto(site + '/p/' + id, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  assert.equal(response?.status(), 200, 'legacy preview route must return HTTP 200');
  await page.waitForFunction(() => {
    const player = document.querySelector('#player');
    return player?.dataset.previewStatus === 'blocked' ||
      player?.dataset.previewStatus === 'ready';
  }, null, { timeout: 60000 });

  const state = await page.evaluate(() => {
    const player = document.querySelector('#player');
    const config = JSON.parse(document.querySelector('#spine-preview-config')?.textContent || '{}');
    const set = config.sets?.[0] || {};
    return {
      version: set.skeletonVersion || '',
      binary: Boolean(set.skelUrl),
      runtimeOverride: set.runtimeVersionOverride || '',
      status: player?.dataset.previewStatus || '',
      blockedCode: document.querySelector('[data-preview-blocked]')?.dataset.previewBlocked || '',
      message: document.querySelector('[data-preview-blocked]')?.textContent || '',
      boneCount: Number(player?.dataset.previewRuntimeBoneCount || 0),
    };
  });
  console.log('SPINE37_BINARY_STATE', JSON.stringify(state));
  assert.ok(state.version.startsWith('3.7.'), 'fixture must be a Spine 3.7 source');
  assert.equal(state.binary, true, 'fixture must use a binary .skel source');
  assert.equal(state.runtimeOverride, '', '3.7 binary must not be misrouted to 3.8');
  assert.equal(state.status, 'blocked', 'unsupported binary must never be reported as ready');
  assert.equal(state.blockedCode, 'UNSUPPORTED_SPINE_3_7_BINARY');
  assert.match(state.message, /re-export.*JSON/i);
  assert.equal(state.boneCount, 0);
  assert.deepEqual(pageErrors, [], 'preview must not throw browser JavaScript errors');
  console.log('SPINE37_BINARY_EXPLICITLY_BLOCKED_PASS');
} finally {
  await browser.close();
}
