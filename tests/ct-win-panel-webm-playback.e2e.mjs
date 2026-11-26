import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const site = process.env.SITE || 'https://spine-link.vercel.app';
const uploadId = 'ct_win_panel-2026-11-26T10-49-18-492Z';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));

try {
  const response = await page.goto(
    `${site}/p/${encodeURIComponent(uploadId)}?webm-playback-smoke=1`,
    { waitUntil: 'domcontentloaded', timeout: 60000 },
  );
  assert.equal(response?.status(), 200, 'Published work page must return HTTP 200');

  const video = page.locator('#preview-video-card-player');
  await video.waitFor({ state: 'visible', timeout: 60000 });
  const source = await video.getAttribute('src');
  assert.ok(source, 'Work page must bind a WebM source');
  assert.match(source, /animation-2/,
    'WebM source must be the playable hit animation, not the short appear clip');

  const assetUrl = new URL(source, site).toString();
  const assetResponse = await page.request.get(assetUrl, { timeout: 45000 });
  assert.equal(assetResponse.status(), 200, 'Selected WebM asset must return HTTP 200');
  assert.match(assetResponse.headers()['content-type'] || '', /video\/webm/i,
    'Selected asset must be served as video/webm');
  const assetBytes = await assetResponse.body();
  assert.ok(assetBytes.byteLength > 1000, 'Selected WebM asset must contain real media bytes');

  await video.evaluate(async element => {
    element.muted = true;
    await element.play();
  });
  await page.waitForFunction(() => {
    const element = document.querySelector('#preview-video-card-player');
    return element &&
      element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      Number.isFinite(element.duration) &&
      element.duration >= 1.9 &&
      element.currentTime > 0.15;
  }, null, { timeout: 60000 });

  const result = await page.evaluate(() => {
    const element = document.querySelector('#preview-video-card-player');
    const player = document.querySelector('#player');
    return {
      src: element?.currentSrc || element?.src || '',
      duration: element?.duration,
      currentTime: element?.currentTime,
      readyState: element?.readyState,
      playerAnimation: player?.dataset.previewAnimation || '',
      playerStatus: player?.dataset.previewStatus || '',
    };
  });
  assert.ok(result.src.includes('animation-2'));
  assert.ok(result.duration >= 1.9 && result.duration <= 2.2,
    'The selected hit preview should be approximately 2 seconds');
  assert.ok(result.currentTime > 0.15, 'Video playback time must advance in Chromium');
  assert.equal(result.playerAnimation, 'appear',
    'The interactive Spine Player must retain its original default animation');
  assert.deepEqual(pageErrors, [], 'Work page must not produce JavaScript errors');

  console.log('PASS ct_win_panel WebM playback:', JSON.stringify(result));
} finally {
  await page.close();
  await browser.close();
}
