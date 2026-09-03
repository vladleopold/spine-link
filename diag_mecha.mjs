import { chromium } from 'playwright';
import fs from 'node:fs';

const executable = process.env.PLAYWRIGHT_EXECUTABLE || '/Users/imac/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const setDir = '/tmp/spine-local-mecha/library/mechagirl_b_front-2026-08-31T22-09-19-878Z/mechagirl_b_front';
const baseUrl = 'https://raw.githubusercontent.com/vladleopold/spine/main/library/mechagirl_b_front-2026-08-31T22-09-19-878Z/mechagirl_b_front';
const anim = '[down]run_front';
const playerJs = 'https://spine-link.vercel.app/vendor-spine-player-3.8.js';

const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body><div id="player" style="width:960px;height:720px"></div>
<script src="${playerJs}"></script>
<script>
window.__log=[];
function L(m){ window.__log.push(String(m)); }
try {
  var cfg = {
    skelUrl: '${baseUrl}/mechagirl_b_front.skel',
    atlasUrl: '${baseUrl}/mechagirl_b.atlas',
    textures: ['${baseUrl}/mechagirl_b.png'],
    animation: '${anim}',
    showLoading: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    alpha: true,
    success: function(p){
      L('SUCCESS');
      L('skeleton bones: ' + (p.skeleton ? p.skeleton.bones.length : 'none'));
      // Get all animations
      var anims = [];
      if (p.skeletonData && p.skeletonData.animations) {
        anims = p.skeletonData.animations.map(function(a){ return {name: a.name, duration: a.duration}; });
      }
      L('total animations: ' + anims.length);
      // Find our target animation
      var target = anims.find(function(a){ return a.name === '${anim}'; });
      if (target) {
        L('TARGET animation [down]run_front duration: ' + target.duration);
      } else {
        L('TARGET NOT FOUND in available animations');
      }
      // Show first 10 animation names and durations
      var sample = anims.filter(function(a){ return a.name.includes('run') || a.name.includes('idle') || a.name.includes('walk'); }).slice(0,15);
      sample.forEach(function(a){ L('  ' + a.name + ': ' + a.duration); });
      // Check animationState
      if (p.animationState) {
        var t = p.animationState.getCurrent(0);
        if (t && t.animation) {
          L('current track animation: ' + t.animation.name + ' duration: ' + t.animation.duration);
        }
      }
      window.__ready = true;
    },
    error: function(p, err){ L('ERROR: ' + (typeof err==='string'?err:(err&&err.message||JSON.stringify(err)))); window.__ready = true; }
  };
  new spine.SpinePlayer('player', cfg);
} catch(e){ L('construct-exc: ' + e.message); window.__ready = true; }
</script></body></html>`;

const browser = await chromium.launch({ headless: true, executablePath: executable, args: ['--no-sandbox','--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));

const atlas = fs.readFileSync(setDir+'/mechagirl_b.atlas','utf8');
const skel = fs.readFileSync(setDir+'/mechagirl_b_front.skel');
const png = fs.readFileSync(setDir+'/mechagirl_b.png');

await page.route(baseUrl+'/mechagirl_b.atlas', r => r.fulfill({status:200, contentType:'application/octet-stream', body:atlas}));
await page.route(baseUrl+'/mechagirl_b_front.skel', r => r.fulfill({status:200, contentType:'application/octet-stream', body:skel}));
await page.route(baseUrl+'/mechagirl_b.png', r => r.fulfill({status:200, contentType:'image/png', body:png}));

await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(10000);
const log = await page.evaluate(() => window.__log);
log.forEach(l => console.log(l));
await browser.close();
