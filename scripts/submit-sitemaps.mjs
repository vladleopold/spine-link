import { google } from 'googleapis';
import { readFileSync } from 'fs';

const KEY_FILE = '/Users/imac/Downloads/zeywin-connect-e8718e11bd82.json';
const SITE_URL = 'https://spine-link.vercel.app/';

async function main() {
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/webmasters'],
  });

  const sc = google.searchconsole({ version: 'v1', auth });

  // Submit sitemaps using the correct API method
  const sitemaps = [
    'https://spine-link.vercel.app/sitemap.xml',
    'https://spine-link.vercel.app/sitemap-index.xml',
    'https://spine-link.vercel.app/sitemap-archive.xml',
    'https://spine-link.vercel.app/sitemap-video.xml',
    'https://spine-link.vercel.app/sitemap-portfolios.xml',
    'https://spine-link.vercel.app/sitemap-images.xml',
  ];

  console.log('🗺️  Submitting sitemaps...\n');

  for (const sitemapUrl of sitemaps) {
    try {
      // Use the raw HTTP approach
      const authToken = await auth.getAccessToken();
      const response = await fetch(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/sitemaps`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ feedpath: sitemapUrl }),
        }
      );

      if (response.ok) {
        console.log(`   ✅ ${sitemapUrl}`);
      } else {
        const err = await response.text();
        console.log(`   ⚠️  ${sitemapUrl}: ${response.status} - ${err}`);
      }
    } catch (e) {
      console.log(`   ❌ ${sitemapUrl}: ${e.message}`);
    }
  }

  // List sitemaps after submission
  console.log('\n📋 Listing submitted sitemaps...');
  try {
    const res = await sc.sites.listSitemaps({ siteUrl: SITE_URL });
    const sitemapList = res.data.sitemapIndex || [];
    console.log(`   Found ${sitemapList.length} sitemap(s):\n`);
    sitemapList.forEach(s => {
      console.log(`   ${s.path}`);
      console.log(`     Last submitted: ${s.lastSubmitted || 'never'}`);
      console.log(`     Last downloaded: ${s.lastDownloaded || 'never'}`);
      if (s.contents) {
        s.contents.forEach(c => {
          console.log(`     Type: ${c.type}, Submitted: ${c.submitted}, Indexed: ${c.indexed}`);
        });
      }
      console.log('');
    });
  } catch (e) {
    console.log('   Error:', e.message);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
