import { Script } from 'node:vm';

export default async function handler(request, response) {
  try {
    const sourceResponse = await fetch('https://raw.githubusercontent.com/vladleopold/spine-link/main/api/github-preview.js');
    if (!sourceResponse.ok) throw new Error('Cannot fetch source: ' + sourceResponse.status);
    let source = await sourceResponse.text();
    source = source
      .replace(/^import\\s+.*?;\\s*$/gm, '')
      .replace(/^export default /gm, '')
      .replace(/^export /gm, '');
    new Script(source, { filename: 'api/github-preview.js' });
    return response.status(200).json({ syntax: 'ok' });
  } catch (error) {
    console.error('[preview-module-diagnostic] syntax check failed:', error);
    return response.status(500).json({
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || '',
      lineNumber: error?.lineNumber || null,
      columnNumber: error?.columnNumber || null,
    });
  }
}
