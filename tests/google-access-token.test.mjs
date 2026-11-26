import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleAccessToken } from '../lib/google-access-token.js';

const clientId = 'spine-link-test-client.apps.googleusercontent.com';

function mockGoogle({ tokenStatus = 200, token = {}, profileStatus = 200, profile = {} } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.startsWith('https://oauth2.googleapis.com/tokeninfo?access_token=')) {
      return new Response(JSON.stringify(token), { status: tokenStatus });
    }
    if (value === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return new Response(JSON.stringify(profile), { status: profileStatus });
    }
    throw new Error('Unexpected Google request: ' + value);
  };
  return {
    calls,
    restore() { globalThis.fetch = originalFetch; },
  };
}

test('accepts a valid Google access token whose tokeninfo issued_to matches this OAuth client', async () => {
  const mock = mockGoogle({
    token: { issued_to: clientId, user_id: 'google-subject-1', scope: 'openid email profile' },
    profile: { sub: 'google-subject-1', email: 'owner@example.test', email_verified: true },
  });
  try {
    const result = await verifyGoogleAccessToken('valid-access-token', clientId);
    assert.equal(result.profile.sub, 'google-subject-1');
    assert.equal(result.profile.email, 'owner@example.test');
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('accepts the Google tokeninfo audience field when it matches the OAuth client', async () => {
  const mock = mockGoogle({
    token: { audience: clientId, user_id: 'google-subject-2' },
    profile: { sub: 'google-subject-2', email: 'owner@example.test', email_verified: 'true' },
  });
  try {
    const result = await verifyGoogleAccessToken('valid-access-token', clientId);
    assert.equal(result.profile.sub, 'google-subject-2');
  } finally {
    mock.restore();
  }
});

test('rejects a token issued to another OAuth client before requesting userinfo', async () => {
  const mock = mockGoogle({
    token: { issued_to: 'another-client.apps.googleusercontent.com' },
    profile: { sub: 'google-subject-3', email: 'owner@example.test', email_verified: true },
  });
  try {
    await assert.rejects(
      () => verifyGoogleAccessToken('foreign-access-token', clientId),
      error => error.code === 'google_oauth_client_mismatch',
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('classifies a failed tokeninfo response as an expired or invalid access token, not an audience mismatch', async () => {
  const mock = mockGoogle({ tokenStatus: 400, token: { error: 'invalid_token' } });
  try {
    await assert.rejects(
      () => verifyGoogleAccessToken('expired-access-token', clientId),
      error => error.code === 'google_access_token_invalid' && error.statusCode === 401,
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('rejects a token whose tokeninfo subject differs from the userinfo subject', async () => {
  const mock = mockGoogle({
    token: { issued_to: clientId, user_id: 'subject-from-tokeninfo' },
    profile: { sub: 'different-subject', email: 'owner@example.test', email_verified: true },
  });
  try {
    await assert.rejects(
      () => verifyGoogleAccessToken('valid-access-token', clientId),
      error => error.code === 'google_subject_mismatch',
    );
  } finally {
    mock.restore();
  }
});

test('rejects a Google account without a verified email', async () => {
  const mock = mockGoogle({
    token: { issued_to: clientId, user_id: 'google-subject-4' },
    profile: { sub: 'google-subject-4', email: 'owner@example.test', email_verified: false },
  });
  try {
    await assert.rejects(
      () => verifyGoogleAccessToken('valid-access-token', clientId),
      error => error.code === 'google_email_unverified',
    );
  } finally {
    mock.restore();
  }
});
