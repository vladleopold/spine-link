export function canReadPublicSpineWithoutToken(token, owner, repo) {
  if (String(token || '').trim()) return true;
  return String(owner || '').trim().toLowerCase() === 'vladleopold' &&
    String(repo || '').trim().toLowerCase() === 'spine';
}
