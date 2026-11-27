import { createHmac, timingSafeEqual } from 'node:crypto';

export const GOOGLE_SESSION_COOKIE_NAME = 'spine_link_session';
export const GOOGLE_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function signingKey(secret) {
  const value = String(secret || '');
  if (value.length < 32) throw new Error('Google session signing secret must contain at least 32 characters');
  return value;
}

function signatureFor(payload, secret) {
  return createHmac('sha256', signingKey(secret)).update(payload).digest('base64url');
}

export function createGoogleSessionCookie(profile, secret, options = {}) {
  if (profile?.email_verified !== true && profile?.email_verified !== 'true') {
    throw new Error('A verified Google account is required to create a session');
  }
  const sub = String(profile?.sub || '').trim();
  const email = String(profile?.email || '').trim().toLowerCase();
  if (!sub || !email) throw new Error('Google session requires a subject and email');
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxAgeSeconds = Math.max(60, Math.min(Number(options.maxAgeSeconds) || GOOGLE_SESSION_MAX_AGE_SECONDS, GOOGLE_SESSION_MAX_AGE_SECONDS));
  const payload = Buffer.from(JSON.stringify({ sub, email, email_verified: true, iat: now, exp: now + maxAgeSeconds * 1000 })).toString('base64url');
  const value = payload + '.' + signatureFor(payload, secret);
  return {
    value,
    options: { httpOnly: true, secure: options.secure !== false, sameSite: 'Lax', path: '/', maxAge: maxAgeSeconds },
  };
}

export function serializeGoogleSessionCookie(cookie) {
  const options = cookie?.options || {};
  return [
    GOOGLE_SESSION_COOKIE_NAME + '=' + String(cookie?.value || ''),
    'Path=' + (options.path || '/'),
    'Max-Age=' + Math.max(0, Number(options.maxAge) || 0),
    'HttpOnly',
    'SameSite=' + (options.sameSite || 'Lax'),
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearGoogleSessionCookie({ secure = true } = {}) {
  return [GOOGLE_SESSION_COOKIE_NAME + '=', 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ');
}

export function readGoogleSessionCookie(cookieHeader, secret, now = Date.now()) {
  try {
    const header = String(cookieHeader || '');
    const match = header.split(';').map(part => part.trim()).find(part => part.startsWith(GOOGLE_SESSION_COOKIE_NAME + '='));
    if (!match || String(secret || '').length < 32) return null;
    const value = match.slice(GOOGLE_SESSION_COOKIE_NAME.length + 1);
    const separator = value.lastIndexOf('.');
    if (separator <= 0) return null;
    const payload = value.slice(0, separator);
    const providedSignature = Buffer.from(value.slice(separator + 1));
    const expectedSignature = Buffer.from(signatureFor(payload, secret));
    if (providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const issuedAt = Number(session?.iat);
    const expiresAt = Number(session?.exp);
    if (!session?.sub || !session?.email || session.email_verified !== true || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
    if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt - issuedAt > GOOGLE_SESSION_MAX_AGE_SECONDS * 1000) return null;
    return { sub: String(session.sub), email: String(session.email).toLowerCase(), email_verified: true };
  } catch {
    return null;
  }
}