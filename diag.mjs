import { chromium } from 'playwright';
import fs from 'node:fs';

const executable = process.env.PLAYWRIGHT_EXECUTABLE || '';
const setDir = '/tmp/spine-local/library/knight_female_hero_side-2026-09-01T08-02-42-709Z/knight_female_hero_side';
const baseUrl = 'https://raw.githubusercontent.com/vladleopold/spine/main/library/knight_female_hero_side-2026-09-01T08-02-42-709Z/knight_female_hero_side';
const anim = '[down]run_side';
const playerJs = 'https://spine-link.vercel.app/vendor-spine-player-3.8.js';

const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body><div id="player" style="width:960px;height:720px"></div>
<script src="${playerJs}"></script>
<script>
window.__log=[];
function L(m){ window.__log.push(String(m)); try{console.log('DIAG:',m);}catch(e){} }
window.addEventListener('error', e => L('pageerror '+(e.message||e.filename)));
try {
  var cfg = {
    skelUrl: '${baseUrl}/knight_female_hero_side.skel',
    atlasUrl: '${baseUrl}/knight_female_hero.atlas',
    textures: ['${baseUrl}/knight_female_hero.png'],
    animation: '${anim}',
    showLoading: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    backgroundColor: '#050607',
    success: function(p){
      L('SUCCESS');
      var keys = [];
      for (var k in p) keys.push(k);
      L('player keys: ' + keys.join(','));
      L('has skeletonData: ' + (!!p.skeletonData) + ' type=' + typeof p.skeletonData);
      if (p.skeletonData && p.skeletonData.animations) L('animations count: ' + p.skeletonData.animations.length);
      L('has skeleton: ' + (!!p.skeleton));
      L('has animationState: ' + (!!p.animationState));
      if (p.skeleton) { L('bones count: ' + p.skeleton.bones.length); }
      if (p.animationState) {
        var t = p.animationState;
        try { var tr = t.getCurrent(0); L('current anim: ' + (tr && tr.animation && tr.animation.name)); } catch(e){ L('getCurrent exc '+e.message); }
      }
      window.__readyDone = true;
    },
    error: function(p, err){ L('ERROR ' + (typeof err==='string'?err:(err&&err.message||JSON.stringify(err)))); window.__readyDone=true; }
  };
  new spine.SpinePlayer('player', cfg);
} catch(e){ L('construct-exc '+(e.stack||e.message||e)); window.__readyDone=true; }
</script></body></html>`;

const browser = await chromium.launch({ headless: true, executablePath: executable || undefined, args: ['--no-sandbox','--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
const atlas = fs.readFileSync(setDir+'/knight_female_hero.atlas','utf8');
const skel = fs.readFileSync(setDir+'/knight_female_hero_side.skel');
const png = fs.readFileSync(setDir+'/knight_female_hero.png');
await page.route(baseUrl+'/knight_female_hero.atlas', r => r.fulfill({status:200, contentType:'application/octet-stream', body:atlas}));
await page.route(baseUrl+'/knight_female_hero_side.skel', r => r.fulfill({status:200, contentType:'application/octet-stream', body:skel}));
await page.route(baseUrl+'/knight_female_hero.png', r => r.fulfill({status:200, contentType:'image/png', body:png}));
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(8000);
const log = await page.evaluate(() => window.__log);
log.forEach(l => console.log('   ', l));
await browser.close();
