export function isGeneratedPosterUrl(value = '') {
  try {
    const pathname = new URL(String(value || ''), 'https://spine-link.invalid').pathname.toLowerCase();
    return ['/preview.webp', '/preview-medium.webp', '/preview-low.webp']
      .some((suffix) => pathname.endsWith(suffix));
  } catch {
    return false;
  }
}
