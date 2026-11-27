// Browser regression for a durable server session after the short-lived GIS access token expires.
// Google endpoints and the upload API are stubbed; no real account or project is touched.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const SITE = process.env.SPINE_TEST_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:1280,height:800}});
const page = await context.newPage();
const pageErrors = [];
let portfolioLoads = 0;
page.on('pageerror', error => pageErrors.push(String(error)));

await page.addInitScript(() => {
  window.__gisPromptLog = JSON.parse(sessionStorage.getItem('spine-test-gis-prompts') || '[]');
  window.__recordPrompt = prompt => {
    window.__gisPromptLog.push(prompt);
    sessionStorage.setItem('spine-test-gis-prompts', JSON.stringify(window.__gisPromptLog));
  };
});

await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
  status:200, contentType:'application/javascript',
  body:`window.google = { accounts: { id: { disableAutoSelect() {} }, oauth2: { initTokenClient(config) { return { requestAccessToken(options = {}) { const prompt = options.prompt ?? ''; window.__recordPrompt(prompt); queueMicrotask(() => config.callback({access_token:'browser-test-google-access-token',expires_in:3600})); } }; } } } };`,
}));
await page.route('https://www.googleapis.com/oauth2/v3/userinfo', route => route.fulfill({
  status:200, contentType:'application/json',
  body:JSON.stringify({sub:'spine-link-browser-test-subject',email:'spine-link-test@example.invalid',email_verified:true,name:'Spine-Link Test Owner'}),
}));
await page.route('**/api/github-upload', async route => {
  const body = route.request().postDataJSON() || {};
  let payload = {ok:true};
  const headers = { 'Set-Cookie':'spine_link_session=browser-test-session; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax' };
  if (body.action === 'get-session') {
    const cookie = route.request().headers()['cookie'] || '';
    payload = {ok:true,authenticated:cookie.includes('spine_link_session=browser-test-session'),user:{sub:'spine-link-browser-test-subject',email:'spine-link-test@example.invalid'}};
  } else if (body.action === 'merge-anonymous-account') {
    payload = {ok:true,entries:[],merged:false};
  } else if (body.action === 'get-index') {
    if (body.scope === 'mine') portfolioLoads += 1;
    payload = {ok:true,entries:[]};
  }
  await route.fulfill({status:200,contentType:'application/json',headers,body:JSON.stringify(payload)});
});
await page.route('**/api/github-archive**', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({entries:[]})}));

try {
  const response = await page.goto(SITE + '/', {waitUntil:'domcontentloaded'});
  assert.equal(response?.status(),200,'Homepage must load');
  await page.locator('button[aria-label="Sign in"]').waitFor({state:'visible',timeout:20000});
  const mergeResponse = page.waitForResponse(r => r.url().includes('/api/github-upload') && r.request().postDataJSON()?.action === 'merge-anonymous-account');
  await page.locator('button[aria-label="Sign in"]').click();
  await page.locator('.auth-user').waitFor({state:'visible',timeout:15000});
  await mergeResponse;
  // Keep the mocked HttpOnly session available across the reload just as the API Set-Cookie does in production.
  await context.addCookies([{name:'spine_link_session',value:'browser-test-session',url:SITE,httpOnly:true,sameSite:'Lax'}]);
  assert.equal(await page.locator('.avatar-menu-toggle').isVisible(),true,'Avatar must appear after sign-in');
  const firstSession = await page.evaluate(() => JSON.parse(localStorage.getItem('spine-link-google-session') || 'null'));
  assert.equal(firstSession?.user?.email,'spine-link-test@example.invalid');
  assert.ok(firstSession?.accessToken,'OAuth access token must be stored');

  // Simulate the OAuth access token expiring while the durable HttpOnly cookie remains valid.
  await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('spine-link-google-session'));
    session.expiresAt = Date.now() - 1000;
    localStorage.setItem('spine-link-google-session', JSON.stringify(session));
  });
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.auth-user').waitFor({state:'visible',timeout:15000});
  assert.equal(await page.locator('.avatar-menu-toggle').isVisible(),true,'Avatar disappeared after reload');
  await page.getByRole('button',{name:'MY PORTFOLIO'}).click();
  await page.waitForResponse(r => r.url().includes('/api/github-upload') && r.request().postDataJSON()?.action === 'get-index' && r.request().postDataJSON()?.scope === 'mine');
  assert.ok(portfolioLoads >= 1,'Portfolio must load using the remembered server session');
  assert.equal(await page.locator('button[aria-label="Reconnect Google"]').count(),0,'A valid persistent session must not request another Google login');
  const prompts = await page.evaluate(() => window.__gisPromptLog);
  assert.ok(prompts.includes('select_account'),'Initial sign-in must use an explicit account selection');
  assert.equal(prompts.includes(''),false,'A valid server session must not trigger silent OAuth renewal');
  assert.deepEqual(pageErrors,[],'No browser JavaScript errors');
  console.log('PASS Google profile/avatar survives reload after the short-lived access token expires');
  console.log('PASS Portfolio opens from the HttpOnly server session without another Google login');
} finally { await context.close(); await browser.close(); }