export default async function handler(request, response) {
  try {
    const preview = await import('./github-preview.js');
    return response.status(200).json({
      loaded: typeof preview.default === 'function',
      exports: Object.keys(preview),
    });
  } catch (error) {
    console.error('[preview-module-diagnostic] import failed:', error);
    return response.status(500).json({
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
}
