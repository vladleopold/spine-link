// Preserve explicit animation selections byte-for-byte. The share-link sentinel
// requests automatic playback: use a valid indexed default, then exact Idle,
// then the first real track. Never pass the sentinel to Spine Player.
export function choosePreviewAnimation(names, preferred = '', automaticDefault = '') {
  const available = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name.length > 0) : [];
  const requested = typeof preferred === 'string' ? preferred : '';
  if (requested === '__SPINE_AUTO__') {
    const indexedDefault = typeof automaticDefault === 'string' ? automaticDefault : '';
    if (indexedDefault && available.includes(indexedDefault)) return indexedDefault;
    const idle = available.find((name) => name.toLowerCase() === 'idle');
    return idle || available[0] || '';
  }
  if (requested) return requested;
  const idle = available.find((name) => name.toLowerCase() === 'idle');
  if (idle) return idle;
  return available.length === 1 ? available[0] : '';
}
