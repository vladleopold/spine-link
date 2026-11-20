// Resolve only the Vercel deployment payload whose inspector URL matches
// the status attached to the exact commit under test. Later failed deployments
// may add plain-text bot comments after an earlier successful deployment.
export function findMatchingVercelProject(comments, expectedInspectorUrl, projectName = 'spine-link') {
  if (!Array.isArray(comments) || typeof expectedInspectorUrl !== 'string' || !expectedInspectorUrl) return null;
  for (const comment of [...comments].reverse()) {
    if (comment?.user?.login !== 'vercel[bot]') continue;
    const firstLine = String(comment.body || '').split(/\r?\n/, 1)[0] || '';
    const encoded = firstLine.slice(firstLine.lastIndexOf(':') + 1).trim();
    if (!encoded) continue;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      continue;
    }
    const project = payload.projects?.find(item => item?.name === projectName &&
      item.inspectorUrl === expectedInspectorUrl && item.previewUrl && item.nextCommitStatus);
    if (project) return project;
  }
  return null;
}
