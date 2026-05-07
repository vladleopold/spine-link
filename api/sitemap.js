const urls = [
  { loc: 'https://spine-link.vercel.app/', lastmod: '2026-05-07', changefreq: 'weekly', priority: '1.0' },
  { loc: 'https://spine-link.vercel.app/spine-link.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.9' },
  { loc: 'https://spine-link.vercel.app/spine-preview.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.9' },
  { loc: 'https://spine-link.vercel.app/spine-preview-online.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.9' },
  { loc: 'https://spine-link.vercel.app/spine-web-viewer.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.9' },
  { loc: 'https://spine-link.vercel.app/spine-animation-preview.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.9' },
  { loc: 'https://spine-link.vercel.app/spine-animation-dataset.html', lastmod: '2026-05-07', changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://spine-link.vercel.app/spine-library.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.85' },
  { loc: 'https://spine-link.vercel.app/spine-portfolio.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.85' },
  { loc: 'https://spine-link.vercel.app/share-spine-animation-link.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.86' },
  { loc: 'https://spine-link.vercel.app/spine-portfolio-link.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.84' },
  { loc: 'https://spine-link.vercel.app/spine-animator.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.8' },
  { loc: 'https://spine-link.vercel.app/spine-animations.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.8' },
  { loc: 'https://spine-link.vercel.app/spine-work.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.8' },
  { loc: 'https://spine-link.vercel.app/spine-link-video.html', lastmod: '2026-05-07', changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://spine-link.vercel.app/spine-online-video.html', lastmod: '2026-05-07', changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://spine-link.vercel.app/amp.html', lastmod: '2026-05-07', changefreq: 'weekly', priority: '0.8' },
];

export default function handler(_request, response) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url>
    <loc>${url.loc}</loc>
    <lastmod>${url.lastmod}</lastmod>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;

  response.setHeader('Content-Type', 'application/xml; charset=utf-8');
  response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  return response.status(200).send(xml);
}
