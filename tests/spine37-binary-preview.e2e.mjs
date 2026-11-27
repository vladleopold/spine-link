import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createProductionSmokeMetricsResponse } from '../scripts/lib/production-smoke-metrics.mjs';

const site = process.env.SITE;
assert.ok(site, 'SITE must point at the public preview site');
const binaryId = 'Spine-animation-2026-11-20T10-01-52-055Z';
const unityTextAssetId = 'Spine-animation-2026-11-27T04-40-28-926Z';
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
const conversionResponses = [];
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('response', response => {
  const url = response.url();
  if (!/\/(?:B507201|20938824)\.(?:skel\.json|atlas(?:\.txt)?\.spine43)(?:\?|$)/i.test(url)) return;
  conversionResponses.push(response.allHeaders().then(headers => ({
    url,
    status: response.status(),
    converted: headers['x-spine-link-converted'] || '',
  })));
});

async function openAndWait(id, query = '') {
  const response = await page.goto(site + '/p/' + id + query, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  assert.equal(response?.status(), 200, id + ' preview route must return HTTP 200');
  await page.waitForFunction(() => {
    const player = document.querySelector('#player');
    return player?.dataset.previewStatus === 'blocked' ||
      player?.dataset.previewStatus === 'ready';
  }, null, { timeout: 60000 });
  return page.evaluate(() => {
    const player = document.querySelector('#player');
    const config = JSON.parse(document.querySelector('#spine-preview-config')?.textContent || '{}');
    const set = config.sets?.[0] || {};
    return {
      version: set.skeletonVersion || '',
      runtimeOverride: set.runtimeVersionOverride || '',
      jsonUrl: set.jsonUrl || '',
      atlasUrl: set.atlasUrl || '',
      status: player?.dataset.previewStatus || '',
      blockedCode: player?.dataset.previewError || '',
      message: document.querySelector('[data-preview-blocked]')?.textContent || '',
      boneCount: Number(player?.dataset.previewRuntimeBoneCount || 0),
      animationCount: Number(player?.dataset.previewRuntimeAnimationCount || 0),
      animation: player?.dataset.previewAnimation || '',
    };
  });
}

try {
  const binaryState = await openAndWait(binaryId);
  console.log('SPINE37_BINARY_STATE', JSON.stringify(binaryState));
  assert.ok(binaryState.version.startsWith('3.7.'), 'fixture must be a Spine 3.7 source');
  assert.equal(binaryState.runtimeOverride, '4.3', 'Spine 3.7 binary must use the converted 4.3 runtime');
  assert.match(binaryState.jsonUrl, /B507201\.skel\.json/);
  assert.match(binaryState.atlasUrl, /B507201\.atlas\.txt\.spine43/);
  assert.equal(binaryState.status, 'ready', 'converted Spine 3.7 binary must play');
  assert.ok(binaryState.boneCount > 0, 'converted Spine 3.7 skeleton must expose bones');
  assert.ok(binaryState.animationCount > 0, 'converted Spine 3.7 skeleton must expose animations');
  let responses = await Promise.all(conversionResponses);
  assert.ok(responses.some(item => item.converted === 'spine-3.7-to-4.3-json' && item.status === 200),
    'converted 3.7 skeleton response must be served as JSON');
  assert.ok(responses.some(item => item.converted === 'spine-atlas-to-4.3' && item.status === 200),
    'converted 3.7 atlas response must be served');

  const unityState = await openAndWait(unityTextAssetId, '?animation=__SPINE_AUTO__');
  console.log('SPINE_UNITY_TEXTASSET_STATE', JSON.stringify(unityState));
  assert.equal(unityState.version, '4.2.42', 'Unity TextAsset wrapper must preserve its embedded Spine version');
  assert.equal(unityState.runtimeOverride, '', 'Unity-wrapped 4.2 JSON must use its matching 4.2 runtime');
  assert.match(unityState.jsonUrl, /20938824\.skel\.json/);
  assert.equal(unityState.status, 'ready', 'Unity TextAsset skeleton must play after JSON extraction');
  assert.ok(unityState.boneCount > 0, 'extracted Unity skeleton must expose bones');
  assert.ok(unityState.animationCount > 0, 'extracted Unity skeleton must expose animations');
  assert.equal(unityState.animation, 'animation', '__SPINE_AUTO__ must resolve to the runtime animation');
  responses = await Promise.all(conversionResponses);
  assert.ok(responses.some(item => item.converted === 'unity-textasset-to-spine-json' && item.status === 200),
    'Unity TextAsset asset response must be extracted to Spine JSON');

  assert.deepEqual(pageErrors, [], 'both previews must not throw browser JavaScript errors');
  console.log('SPINE_LEGACY_AND_UNITY_PREVIEWS_PASS');
} finally {
  await browser.close();
}
