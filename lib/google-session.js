export function hasUsableGoogleSession(session, clientId, now = Date.now()) {
  const expectedClientId = String(clientId || '').trim();
  const expiresAt = Number(session?.expiresAt);
  return Boolean(
    expectedClientId &&
    session?.clientId === expectedClientId &&
    session?.accessToken &&
    Number.isFinite(expiresAt) &&
    expiresAt > now + 60_000
  );
}
