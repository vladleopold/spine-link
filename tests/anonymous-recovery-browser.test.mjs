import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const SITE = process.env.SPINE_TEST_URL || 'http://127.0.0.1:4173';

test('anonymous visitors can create, use and revoke a recovery key without browser persistence', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const recoverySecret = randomBytes(32).toString('base64url');
    const actions = [];
    const fixtureEntry = {
      id: 'anonymous-recovery-fixture',
      title: 'Recovery fixture',
      uploadedAt: '2026-11-26T12:00:00.000Z',
      files: [],
      animations: [],
      canEdit: true,
    };

    await page.route('**/api/github-upload', async (route) => {
      const body = route.request().postDataJSON() || {};
      actions.push(body.action);
      if (body.action === 'get-index') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, entries: [fixtureEntry] }),
        });
      }
      if (body.action === 'get-metrics') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, metrics: {} }),
        });
      }
      if (body.action === 'create-anonymous-recovery-key') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, recoverySecret, updatedEntries: 1 }),
        });
      }
      if (body.action === 'recover-anonymous-library') {
        assert.equal(body.recoverySecret, recoverySecret);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, recoveredCount: 1, entries: [fixtureEntry] }),
        });
      }
      if (body.action === 'revoke-anonymous-recovery-key') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, revokedCount: 1 }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(SITE);
    await page.locator('.my-library-button').click();
    await page.locator('.anonymous-recovery-panel').waitFor();

    await page.getByRole('button', { name: /Create \/ rotate key/ }).click();
    await page.getByText(recoverySecret).waitFor();

    const browserStorage = await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'),
    );
    assert.equal(browserStorage.includes(recoverySecret), false, 'the recovery secret must not be stored in browser storage');

    await page.locator('#spine-anonymous-recovery-key').fill(recoverySecret);
    await page.getByRole('button', { name: /Restore library/ }).click();
    await page.getByText(/Restored 1 work/).waitFor();
    assert.ok(actions.includes('recover-anonymous-library'));

    await page.getByRole('button', { name: /Revoke key/ }).click();
    await page.getByText(/Recovery key revoked/).waitFor();
    assert.ok(actions.includes('revoke-anonymous-recovery-key'));
  } finally {
    await browser.close();
  }
});
