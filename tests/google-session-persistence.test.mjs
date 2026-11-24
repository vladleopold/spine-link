// Browser regression for remembered Google identity and short-lived GIS tokens.
// Google endpoints and the upload API are stubbed; no real account or project is touched.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const SITE = process.env.SPINE_TEST_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:1280,height:800}});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));

await context.addInitScript(() => {
  window.__gisPromptLog = JSON.parse(sessionStorage.getItem('spine-test-gis-prompts') || '[]');
  window.__failSilentRefresh = sessionStorage.getItem('spine-test-fail-silent') === '1';
  window.__recordPrompt = prompt => {
    window.__gisPromptLog.push(prompt);
    sessionStorage.setItem('spine-test-gis-prompts', JSON.stringify(window.__gisPromptLog));
  };
});

await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
  status:200,
  contentType:'application/javascript',
  body:`
    window.google = {
      accounts: {
        id: { disableAutoSelect() {} },
        oauth2: {
          initTokenClient(config) {
            return {
              requestAccessToken(options = {}) {
                const prompt = options.prompt ?? '';
                window.__recordPrompt(prompt);
                queueMicrotask(() => {
                  if (prompt === '' && window.__failSilentRefresh) {
                    config.callback({error:'interaction_required'});
                  } else {
                    config.callback({access_token:'browser-test-google-access-token',expires_in:3600});
                  }
                });
              }
            };
          }
        }
      }
    };
  `,
}));
await page.route('https://www.googleapis.com/oauth2/v3/userinfo', route => route.fulfill({
  status:200,
  contentType:'application/json',
  body:JSON.stringify({
    sub:'spine-link-browser-test-subject',
    email:'spine-link-test@example.invalid',
    email_verified:true,
    name:'Spine-Link Test Owner',
  }),
}));
await page.route('**/api/github-upload', async route => {
  const body = route.request().postDataJSON() || {};
  const payload = body.action === 'merge-anonymous-account'
    ? {ok:true,entries:[],merged:false}
    : body.action === 'get-index'
      ? {ok:true,entries:[]}
      : {ok:true};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});
});
await page.route('**/api/github-archive**', route => route.fulfill({
  status:200,contentType:'application/json',body:JSON.stringify({entries:[]}),
}));

try {
  const response = await page.goto(SITE + '/', {waitUntil:'domcontentloaded'});
  assert.equal(response?.status(),200,'Homepage must load');
  const signIn = page.locator('button[aria-label="Sign in"]');
  await signIn.waitFor({state:'visible',timeout:20000});
  await signIn.click();

  await page.locator('.auth-user').waitFor({state:'visible',timeout:15000});
  assert.ok(
    (await page.locator('.auth-user').evaluate(element => element.textContent || '')).includes('spine-link-test@example.invalid'),
    'Signed-in account email must remain attached to the account panel',
  );
  assert.equal(await page.locator('.avatar-menu-toggle').isVisible(),true,'Avatar must appear after sign-in');

  const firstSession = await page.evaluate(() => JSON.parse(localStorage.getItem('spine-link-google-session') || 'null'));
  assert.equal(firstSession?.user?.email,'spine-link-test@example.invalid');
  assert.ok(firstSession?.accessToken,'OAuth access token must be stored');
  assert.ok(firstSession.expiresAt > Date.now(),'Stored token expiry must be valid');

  // Simulate a token that expired while the user was away, then reload the page.
  await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('spine-link-google-session'));
    session.expiresAt = Date.now() - 1000;
    localStorage.setItem('spine-link-google-session', JSON.stringify(session));
    sessionStorage.setItem('spine-test-fail-silent','1');
  });
  await page.reload({waitUntil:'domcontentloaded'});

  // The remembered identity/avatar must remain visible even when Google requires
  // an interactive consent step to renew the expired access token.
  // The boot shell renders the remembered avatar before the React app mounts.
  await page.locator('.auth-user').waitFor({state:'visible',timeout:15000});
  assert.equal(await page.locator('.avatar-menu-toggle').isVisible(),true,'Avatar disappeared after refresh');
  // Opening the portfolio mounts React, which performs the silent GIS refresh.
  await page.locator('[data-open-library]').first().click();
  await page.locator('button[aria-label="Reconnect Google"]').waitFor({state:'visible',timeout:15000});
  // The status span can be hidden while its final text is already populated.
  // Wait for the text rather than requiring the span itself to be visible.
  await page.waitForFunction(
    () => /Reconnect to continue/i.test(document.querySelector('.auth-error')?.textContent || ''),
    null,
    {timeout:15000},
  );

  const promptsAfterSilentAttempt = await page.evaluate(() => window.__gisPromptLog);
  assert.ok(promptsAfterSilentAttempt.includes(''), 'Expired session must attempt silent Google token renewal');

  // When silent GIS renewal cannot run without interaction, one explicit reconnect
  // restores the token without losing the remembered account or changing its owner.
  await page.evaluate(() => {
    window.__failSilentRefresh = false;
    sessionStorage.removeItem('spine-test-fail-silent');
  });
  await page.locator('button[aria-label="Reconnect Google"]').click();
  await page.getByRole('button',{name:'MY PORTFOLIO'}).waitFor({state:'visible',timeout:15000});

  const renewed = await page.evaluate(() => JSON.parse(localStorage.getItem('spine-link-google-session') || 'null'));
  assert.equal(renewed?.user?.email,'spine-link-test@example.invalid','Reauth must preserve account identity');
  assert.equal(renewed?.accessToken,'browser-test-google-access-token');
  assert.ok(renewed.expiresAt > Date.now() + 60_000,'Reauth must store a fresh token lifetime');
  const prompts = await page.evaluate(() => window.__gisPromptLog);
  assert.ok(prompts.includes('select_account'),'Explicit reconnect must request account interaction');
  assert.deepEqual(pageErrors,[],'No browser JavaScript errors');

  console.log('PASS Google profile/avatar survives reload with an expired token');
  console.log('PASS silent token renewal is attempted; interactive reconnect restores the same account');
} finally {
  await context.close();
  await browser.close();
}
