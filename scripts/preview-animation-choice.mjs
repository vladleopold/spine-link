// Preserve any explicit animation selection byte-for-byte. If no selection
// exists, use only an unambiguous runtime-discovered default: exact "idle", or
// the sole track. The exporter separately validates explicit names after load.
export function choosePreviewAnimation(names, preferred = '') {
  const available = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name.length > 0) : [];
  const requested = typeof preferred === 'string' ? preferred : '';
  if (requested) return requested;
  const idle = available.find((name) => name.toLowerCase() === 'idle');
  if (idle) return idle;
  return available.length === 1 ? available[0] : '';
}
