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

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanPublicText(value = '', maxLength = 240) {
  return String(value).trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function safeImage(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function safeVideo(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+\.webm(?:[?#][^\s"'<>]*)?$/i.test(url) ? url : '';
}

function generatedThumbnailUrl(origin, entry) {
  const id = String(entry?.id || '').trim();
  const poster = String(entry?.thumbnailPoster || '');
  return origin && id && /^data:image\/webp;base64,/i.test(poster)
    ? `${origin}/assets/library/${encodeURIComponent(id)}/generated-preview.webp`
    : '';
}

function isoDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubText(settings, path) {
  const encodedPath = encodeURIComponent(cleanRepoPath(path)).replace(/%2F/g, '/');
  const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings.token),
  });
  if (!response.ok) return '';
  const data = await response.json();
  return data?.content ? base64ToText(data.content) : '';
}

function videoUrlXml({ loc, thumbnail, title, description, content, publicationDate }) {
  return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <video:video>
      <video:thumbnail_loc>${escapeXml(thumbnail)}</video:thumbnail_loc>
      <video:title>${escapeXml(title)}</video:title>
      <video:description>${escapeXml(description)}</video:description>
      <video:content_loc>${escapeXml(content)}</video:content_loc>
      <video:player_loc>${escapeXml(loc)}</video:player_loc>
      <video:publication_date>${escapeXml(publicationDate)}</video:publication_date>
      <video:family_friendly>yes</video:family_friendly>
      <video:requires_subscription>no</video:requires_subscription>
      <video:live>no</video:live>
    </video:video>
  </url>`;
}

function staticVideoEntries(origin) {
  return [
    {
      loc: `${origin}/spine-link-video.html`,
      thumbnail: `${origin}/spine-link-video-thumbnail.png`,
      title: 'Spine-Link online Spine preview video demo',
      description: 'Demo of Spine-Link, an online Spine preview and Spine web viewer for JSON, SKEL, atlas, and texture files.',
      content: `${origin}/spine-link.webm`,
      publicationDate: '2026-05-01T17:20:00.000Z',
    },
    {
      loc: `${origin}/spine-online-video.html`,
      thumbnail: `${origin}/video_tumbnail.png`,
      title: 'Spine online browser animation preview video',
      description: 'Spine online video demo of Spine-Link, a browser Spine animation preview and Spine web viewer for permanent preview links.',
      content: `${origin}/spine-online.webm`,
      publicationDate: '2026-05-01T18:49:00.000Z',
    },
  ];
}

function libraryVideoEntries(origin, entries) {
  return entries
    .filter((entry) => entry && entry.hiddenFromPublicLibrary !== true)
    .map((entry) => {
      const id = String(entry.id || '').trim();
      const content = safeVideo(entry.webmPreview || '');
      const thumbnail = safeImage(entry.thumbnailPoster || '') || generatedThumbnailUrl(origin, entry) || safeImage(entry.thumbnail || '');
      if (!id || !content || !thumbnail || content.endsWith('/v_holder.webm')) return null;
      const title = cleanPublicText(entry.title || id || 'Spine animation preview', 100);
      return {
        loc: `${origin}/p/${encodeURIComponent(id)}`,
        thumbnail,
        title: `${title} Spine animation video`,
        description:
          cleanPublicText(entry.note || `${title} interactive Spine animation preview with WebM video and first-frame image thumbnail on Spine-Link.`, 240) ||
          `${title} interactive Spine animation preview with WebM video and first-frame image thumbnail on Spine-Link.`,
        content,
        publicationDate: isoDate(entry.uploadedAt) || '2026-05-04T00:00:00.000Z',
      };
    })
    .filter(Boolean);
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).send('Method not allowed');
  }

  const origin = 'https://spine-link.vercel.app';
  const token = process.env.GITHUB_TOKEN;
  let dynamicEntries = [];

  if (token) {
    const settings = {
      owner: process.env.GITHUB_OWNER || defaultOwner,
      repo: process.env.GITHUB_REPO || defaultRepo,
      branch: process.env.GITHUB_BRANCH || defaultBranch,
      token,
    };
    try {
      const indexText = await githubText(settings, `${defaultBasePath}/index.json`);
      const entries = indexText ? JSON.parse(indexText) : [];
      dynamicEntries = Array.isArray(entries) ? libraryVideoEntries(origin, entries) : [];
    } catch {
      dynamicEntries = [];
    }
  }

  const urls = [...staticVideoEntries(origin), ...dynamicEntries].map(videoUrlXml).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"
>
${urls}
</urlset>
`;

  response.setHeader('Content-Type', 'application/xml; charset=utf-8');
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  if (request.method === 'HEAD') return response.status(200).end();
  return response.status(200).send(xml);
}
