import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const site = process.env.SITE;
assert.ok(site, 'SITE must point at the public preview site');
const id = 'Spine-animation-2026-11-20T10-01-52-055Z';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
const assetErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('response', response => {
  if (response.status() >= 400 && /\.(?:atlas|json|png|webp|skel)(?:\?|$)/i.test(response.url())) {
    assetErrors.push({ status: response.status(), url: response.url() });
  }
});

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

try {
  const first = await page.goto(site + '/p/' + id, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  assert.equal(first?.status(), 200, 'legacy preview route must return HTTP 200');
  await page.waitForFunction(() => {
    const player = document.querySelector('#player');
    return player?.dataset.previewStatus === 'ready' ||
      player?.dataset.previewStatus === 'blocked';
  }, null, { timeout: 60000 });

  const config = await page.evaluate(() => {
    const node = document.querySelector('#spine-preview-config');
    if (!node) throw new Error('preview config is missing');
    const value = JSON.parse(node.textContent || '{}');
    const set = value.sets?.[0] || {};
    return {
      version: set.skeletonVersion || '',
      runtimeOverride: set.runtimeVersionOverride || '',
      binary: Boolean(set.skelUrl),
      animations: Array.isArray(set.animations) ? set.animations : [],
      defaultAnimation: set.animation || '',
    };
  });
  const initialState = await page.evaluate(() => ({
    status: document.querySelector('#player')?.dataset.previewStatus || '',
    error: document.querySelector('#player')?.dataset.previewError || '',
    message: document.querySelector('#player')?.innerText || '',
  }));
  console.log('SPINE37_INITIAL_STATE', JSON.stringify({ config, initialState }));
  assert.ok(config.version.startsWith('3.7.'), 'fixture must be a Spine 3.7 source');
  assert.equal(config.binary, true, 'fixture must use a binary .skel source');
  assert.equal(config.runtimeOverride, '3.8',
    '3.7 binary must be routed to the binary-capable 3.8 runtime');
  assert.equal(initialState.status, 'ready',
    'Spine 3.7 binary must initialize through the 3.8 runtime: ' + JSON.stringify(initialState));

  await page.waitForFunction(() =>
    document.querySelectorAll('#animation-menu button').length > 0,
  null, { timeout: 15000 });
  const runtimeAnimations = await page.locator('#animation-menu button').allTextContents();
  console.log('SPINE37_RUNTIME_ANIMATIONS', JSON.stringify(runtimeAnimations));
  assert.ok(runtimeAnimations.length > 0,
    'loaded binary must expose its runtime animation names: ' + JSON.stringify(initialState));
  const candidates = [...new Set([config.defaultAnimation, ...config.animations, ...runtimeAnimations].filter(Boolean))].slice(0, 6);
  let successfulAnimation = '';
  let beforeHash = '';
  let afterHash = '';
  for (const animation of candidates) {
    await page.goto(site + '/p/' + id + '?animation=' + encodeURIComponent(animation), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForFunction(() => {
      const status = document.querySelector('#player')?.dataset.previewStatus;
      return status === 'ready' || status === 'blocked';
    }, null, { timeout: 60000 });
    const state = await page.evaluate(() => ({
      status: document.querySelector('#player')?.dataset.previewStatus || '',
      error: document.querySelector('#player')?.dataset.previewError || '',
      animation: document.querySelector('#player')?.dataset.previewAnimation || '',
      message: document.querySelector('#player')?.innerText || '',
    }));
    assert.equal(state.status, 'ready',
      'Spine 3.7 binary must initialize through 3.8 runtime: ' + JSON.stringify(state));
    assert.equal(state.animation, animation, 'requested animation must remain selected');
    const canvas = page.locator('#player canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(900);
    const firstFrame = await canvas.screenshot();
    await page.waitForTimeout(1300);
    const secondFrame = await canvas.screenshot();
    beforeHash = digest(firstFrame);
    afterHash = digest(secondFrame);
    if (beforeHash !== afterHash) {
      successfulAnimation = animation;
      await mkdir('artifacts', { recursive: true });
      await writeFile('artifacts/spine37-preview.png', secondFrame);
      break;
    }
  }

  assert.ok(successfulAnimation,
    'no tested Spine 3.7 animation produced changing canvas frames; this is not accepted as playback');
  assert.deepEqual(assetErrors, [], 'required Spine assets must load without HTTP errors');
  assert.deepEqual(pageErrors, [], 'preview must not throw browser JavaScript errors');
  console.log('SPINE37_BINARY_REAL_PLAYBACK_PASS', JSON.stringify({
    sourceVersion: config.version,
    runtimeOverride: config.runtimeOverride,
    animation: successfulAnimation,
    frameA: beforeHash,
    frameB: afterHash,
  }));
} finally {
  await browser.close();
}
