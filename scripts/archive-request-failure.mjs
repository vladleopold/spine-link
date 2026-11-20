export function isExpectedArchiveRequestAbort(errorText = '') {
  return /^(?:net::)?ERR_(?:ABORTED|CANCELED)$/i.test(String(errorText || '').trim());
}
