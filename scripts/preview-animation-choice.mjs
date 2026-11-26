// Preserve an explicit/indexed animation verbatim. If no selection exists,
// use only an unambiguous runtime-discovered default: exact "idle", or the
// sole track. Never guess the first animation in a multi-track skeleton.
export function choosePreviewAnimation(names, preferred = '') {
  const available = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name.length > 0) : [];
  const requested = typeof preferred === 'string' ? preferred : '';
  if (requested) return available.length === 0 || available.includes(requested) ? requested : '';
  const idle = available.find((name) => name.toLowerCase() === 'idle');
  if (idle) return idle;
  return available.length === 1 ? available[0] : '';
}
