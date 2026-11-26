function googleError(code, message, extra = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode: 401,
    ...extra,
  });
}

function isVerified(value) {
  return value === true || value === 'true';
}

/**
 * Verify a Google OAuth access token against the OAuth client configured for
 * this application, then bind its identity to Google's userinfo response.
 *
 * Access-token tokeninfo commonly exposes the OAuth client as `issued_to`.
 * Do not confuse an invalid/expired token response with an audience mismatch:
 * Google returns HTTP 400 and no audience claims for an invalid token.
 */
export async function verifyGoogleAccessToken(accessToken, clientId) {
  const tokenValue = String(accessToken || '');
  const expectedClientId = String(clientId || '');
  if (!tokenValue || tokenValue.length > 4096) {
    throw googleError('google_access_token_invalid', 'Google access token is missing or invalid');
  }
  if (!expectedClientId) {
    throw Object.assign(new Error('Google OAuth client is not configured'), {
      code: 'google_oauth_client_missing',
      statusCode: 500,
    });
  }

  let tokenResponse;
  try {
    tokenResponse = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(tokenValue),
    );
  } catch {
    throw Object.assign(new Error('Google token validation is temporarily unavailable'), {
      code: 'google_token_validation_unavailable',
      statusCode: 503,
    });
  }
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) {
    const tokenError = typeof token?.error === 'string' ? token.error.slice(0, 80) : '';
    throw googleError('google_access_token_invalid', 'Google access token is expired or invalid', {
      googleStatus: Number(tokenResponse.status) || 0,
      googleError: tokenError,
    });
  }

  const clientClaims = [
    token.issued_to,
    token.audience,
    token.aud,
    token.azp,
  ].filter(value => typeof value === 'string' && value);
  if (!clientClaims.includes(expectedClientId)) {
    throw googleError('google_oauth_client_mismatch', 'Google token audience does not match this app', {
      googleStatus: Number(tokenResponse.status) || 200,
      tokenInfo: {
        issued_to: token.issued_to || null,
        audience: token.audience || null,
        aud: token.aud || null,
        azp: token.azp || null,
      },
    });
  }

  let profileResponse;
  try {
    profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenValue },
    });
  } catch {
    throw googleError('google_access_token_invalid', 'Google access token is expired or invalid');
  }
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile?.sub) {
    throw googleError('google_access_token_invalid', 'Google access token is expired or invalid', {
      googleStatus: Number(profileResponse.status) || 0,
    });
  }
  if (!isVerified(profile.email_verified)) {
    throw googleError('google_email_unverified', 'Google email is not verified');
  }
  const tokenSubject = token.user_id || token.sub;
  if (tokenSubject && String(tokenSubject) !== String(profile.sub)) {
    throw googleError('google_subject_mismatch', 'Google token subject does not match user profile');
  }

  return { token, profile };
}
