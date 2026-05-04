const defaultOwner = 'vladleopold';
const defaultRepo = 'spine';
const defaultBranch = 'main';
const defaultBasePath = 'library';

function cleanRepoPath(value = '') {
  return String(value).trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function base64ToText(base64) {
  return Buffer.from(String(base64).replace(/\s/g, ''), 'base64').toString('utf8');
}

function base64ToBuffer(base64) {
  return Buffer.from(String(base64).replace(/\s/g, ''), 'base64');
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubText(settings, path) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
  const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings.token),
  });
  if (!response.ok) return '';
  const data = await response.json();
  return data?.content ? base64ToText(data.content) : '';
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).send('Method not allowed');
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return response.status(500).send('GITHUB_TOKEN is not configured');

  const id = String(request.query?.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,160}$/i.test(id)) return response.status(400).send('Invalid thumbnail id');

  const settings = {
    owner: process.env.GITHUB_OWNER || defaultOwner,
    repo: process.env.GITHUB_REPO || defaultRepo,
    branch: process.env.GITHUB_BRANCH || defaultBranch,
    basePath: cleanRepoPath(process.env.GITHUB_BASE_PATH || defaultBasePath),
    token,
  };

  try {
    const indexText = await githubText(settings, `${settings.basePath}/index.json`);
    const entries = indexText ? JSON.parse(indexText) : [];
    const entry = Array.isArray(entries) ? entries.find((item) => String(item?.id || '') === id) : null;
    const poster = String(entry?.thumbnailPoster || '');
    const match = poster.match(/^data:image\/webp;base64,([\s\S]+)$/i);
    if (!match) return response.status(404).send('Generated thumbnail not found');

    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).send(base64ToBuffer(match[1]));
  } catch (error) {
    return response.status(500).send(error instanceof Error ? error.message : 'Generated thumbnail failed');
  }
}
