// Chromium UI regression test: real desktop/mobile rendering, mocked
// network data so no Google account, API key or real project is created.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const SITE = process.env.SPINE_TEST_URL || 'http://127.0.0.1:4173';
const BROWSER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];
const testKey='slk_v1_0123456789abcdef_' + 'A'.repeat(43);

function text(value) { return String(value || ''); }
async function session(context) {
  await context.addInitScript(() => {
    localStorage.setItem('spine-link-google-session',JSON.stringify({
      user:{email:'testowner@example.invalid',name:'Test owner'},
      accessToken:'browser-test-google-access-token',
      expiresAt:Date.now()+3600000,
    }));
  });
}
async function mockApi(page, calls) {
  await page.route('**/api/agent-animation', async route => {
    const request=route.request();
    const body=request.postDataJSON() || {};
    calls.push({action:body.action,auth:request.headers().authorization||''});
    const authorized=request.headers().authorization?.includes('browser-test-google-access-token');
    const payload=body.action==='keys-list' ? {ok:true,keys:[]} :
      body.action==='keys-projects' ? {ok:true,projects:[{
        id:'agent-'+'a'.repeat(32),title:'Automated hero',
        pageUrl:'https://spine-link.vercel.app/p/agent-'+'a'.repeat(32),
        state:'processing',createdAt:'2026-11-14T12:00:00Z',
      }]} :
      body.action==='keys-create' ? {ok:true,key:testKey,record:{id:'0123456789abcdef',name:body.name}} :
      body.action==='ping' ? {ok:true,authenticated:true,keyType:'personal',scope:'publish'} :
      body.action==='keys-revoke' ? {ok:true,revoked:body.keyId} :
      {ok:false,error:'Unknown action'};
    const permitted=authorized||body.action==='ping'&&request.headers().authorization==='Bearer '+testKey;
    await route.fulfill({
      status:permitted?200:401,contentType:'application/json',
      body:JSON.stringify(permitted?payload:{ok:false,error:'Invalid session'}),
    });
  });
}
async function desktopAndMobile(browser,width,height) {
  const context=await browser.newContext({viewport:{width,height}});
  await session(context);
  const page=await context.newPage();
  const calls=[],errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await mockApi(page,calls);
  const response=await page.goto(SITE+'/api-keys.html',{waitUntil:'networkidle'});
  assert.equal(response.status(),200);
  await page.waitForSelector('#manager:not([hidden])');
  assert.equal(await page.locator('#sign-in').isVisible(),false);
  assert.equal(await page.locator('#key-name').isVisible(),true);
  assert.equal(await page.locator('#refresh-projects').isVisible(),true);
  assert.equal(await page.locator('#project-list tr').count(),1);
  assert.match(await page.locator('#project-list').innerText(),/Automated hero/);
  const dimensions=await page.evaluate(()=>({
    viewport:window.innerWidth,
    scrollWidth:document.documentElement.scrollWidth,
    buttonVisible:(()=>{
      const r=document.querySelector('#create-button')?.getBoundingClientRect();
      return Boolean(r&&r.width>0&&r.left>=0&&r.right<=window.innerWidth+1);
    })()
  }));
  assert(dimensions.scrollWidth<=dimensions.viewport+1,
    'Horizontal page overflow at '+width+'px: '+JSON.stringify(dimensions));
  assert(dimensions.buttonVisible,'Create key button is clipped at '+width+'px');
  await page.locator('#key-name').fill('<img src=x onerror=alert(1)>');
  await page.locator('#create-button').click();
  await page.waitForSelector('#new-key:not([hidden])');
  assert.equal(await page.locator('#key-value').inputValue(),testKey);
  assert.equal(await page.locator('#new-key img').count(),0);
  await page.locator('#test-key').click();
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('Personal API key is valid'));
  assert(calls.some(c=>c.action==='ping'&&c.auth==='Bearer '+testKey));
  await page.locator('#hide-key').click();
  assert.equal(await page.locator('#key-value').inputValue(),'');
  assert.equal(await page.locator('#new-key').isVisible(),false);
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.locator('#key-value').inputValue(),'');
  assert.equal(await page.locator('#new-key').isVisible(),false);
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('PASS browser UI '+width+'x'+height+' mobile/desktop, account session, upload list, key lifecycle, no overflow/XSS');
}
async function unsigned(browser) {
  const context=await browser.newContext({viewport:{width:375,height:740}});
  const page=await context.newPage();
  const response=await page.goto(SITE+'/api-keys.html',{waitUntil:'networkidle'});
  assert.equal(response.status(),200);
  assert.equal(await page.locator('#sign-in').isVisible(),true);
  assert.equal(await page.locator('#manager').isVisible(),false);
  await context.close();
  console.log('PASS browser UI unauthenticated shows Google sign-in');
}
const browser=await chromium.launch({headless:true,args:BROWSER_ARGS});
try {
  await unsigned(browser);
  await desktopAndMobile(browser,1280,850);
  await desktopAndMobile(browser,375,720);
  await desktopAndMobile(browser,320,600);
} finally {
  await browser.close();
}
