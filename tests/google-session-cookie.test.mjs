import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleSessionCookie, readGoogleSessionCookie, clearGoogleSessionCookie } from '../lib/google-session-cookie.js';

const secret = 'test-session-secret-with-enough-entropy';
const profile = { sub: 'google-subject-123', email: 'owner@example.com', email_verified: true };

test('signed Google session cookie restores the verified account after the OAuth access token expires', () => {
  const now = 1_800_000_000_000;
  const cookie = createGoogleSessionCookie(profile, secret, { now, maxAgeSeconds: 3600 });
  const restored = readGoogleSessionCookie('other=x; spine_link_session=' + cookie.value, secret, now + 3_500_000);
  assert.equal(restored.sub, profile.sub);
  assert.equal(restored.email, profile.email);
  assert.equal(restored.email_verified, true);
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.sameSite, 'Lax');
  assert.equal(cookie.options.path, '/');
});

test('expired, tampered, or unverified session cookies are rejected', () => {
  const now = 1_800_000_000_000;
  const cookie = createGoogleSessionCookie(profile, secret, { now, maxAgeSeconds: 60 });
  assert.equal(readGoogleSessionCookie('spine_link_session=' + cookie.value, secret, now + 60_001), null);
  const parts = cookie.value.split('.');
  const tampered = parts[0].slice(0, -2) + 'aa.' + parts[1];
  assert.equal(readGoogleSessionCookie('spine_link_session=' + tampered, secret, now), null);
  assert.throws(() => createGoogleSessionCookie({ ...profile, email_verified: false }, secret, { now }), /verified/);
});

test('session cookies cannot be issued without a server signing secret', () => {
  assert.throws(() => createGoogleSessionCookie(profile, '', { now: 1_800_000_000_000 }), /secret/);
  assert.equal(readGoogleSessionCookie('spine_link_session=anything', '', 1_800_000_000_000), null);
});

test('logout cookie expires the browser session immediately', () => {
  const cookie = clearGoogleSessionCookie();
  assert.match(cookie, /^spine_link_session=;/);
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /HttpOnly/);
});