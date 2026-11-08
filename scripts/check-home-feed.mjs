import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try {
 for(const [width,height] of [[390,844],[360,640],[480,600],[1365,900],[844,390]]) {
  const page=await browser.newPage({viewport:{width,height}});
  await page.goto('https://spine-link.vercel.app/',{waitUntil:'domcontentloaded'});
  await page.locator('.home-feed-card').first().waitFor({state:'attached',timeout:90000});
  const state=await page.evaluate(()=>{
   const feed=document.querySelector('.home-portfolio-feed');
   const drop=document.querySelector('.main-drop-zone');
   return {display:getComputedStyle(feed).display,feed:feed.getBoundingClientRect().toJSON(),drop:drop.getBoundingClientRect().toJSON(),cards:document.querySelectorAll('.home-feed-card').length,width:innerWidth,height:innerHeight};
  });
  console.log(JSON.stringify(state));
  await page.screenshot({path:`home-feed-${width}x${height}.png`});
  assert.notEqual(state.display,'none');
  assert.ok(state.cards>0 && state.feed.height>0);
  assert.ok(state.feed.top>=0 && state.feed.bottom<=height+1);
  assert.ok(state.drop.width>0 && state.drop.height>0);
  assert.ok(state.drop.bottom<=state.feed.top+1,'Upload panel overlaps feed');
  await page.close();
 }
} finally {await browser.close();}
