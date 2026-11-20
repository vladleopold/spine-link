export function previewMediaStatusAllowsPlayback(entry = {}) {
  return ['previewStatus', 'webmStatus'].every((field) => {
    const value = entry?.[field];
    if (value == null) return true;
    if (typeof value !== 'string') return false;
    const status = value.trim().toLowerCase();
    return !status || status === 'ready';
  });
}
