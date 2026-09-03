import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';

const KEY_FILE = '/Users/imac/Downloads/zeywin-connect-e8718e11bd82.json';
const SITE_URL = 'https://spine-link.vercel.app/';

async function main() {
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const sc = google.searchconsole({ version: 'v1', auth });

  // Get pages with clicks/impressions data
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const fmt = d => d.toISOString().slice(0, 10);

  console.log('📊 Getting page performance data...\n');

  const pages = await sc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['page'],
      rowLimit: 25000,
      dataState: 'final',
    },
  });

  const rows = pages.data.rows || [];
  console.log(`Total pages with data: ${rows.length}\n`);

  // Sort by clicks
  const sorted = rows
    .map(r => ({
      url: r.keys[0],
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0,
      position: r.position || 0,
    }))
    .sort((a, b) => b.clicks - a.clicks);

  console.log('🏆 PAGES WITH TRAFFIC:');
  console.log('─'.repeat(80));
  sorted.filter(r => r.clicks > 0).forEach(r => {
    const short = r.url.replace('https://spine-link.vercel.app', '');
    console.log(`${r.clicks} clicks | ${r.impressions} imp | pos ${r.position.toFixed(1)} | ${short}`);
  });

  console.log('\n\n📄 PAGES WITH IMPRESSIONS BUT NO CLICKS:');
  console.log('─'.repeat(80));
  sorted.filter(r => r.impressions > 0 && r.clicks === 0).slice(0, 30).forEach(r => {
    const short = r.url.replace('https://spine-link.vercel.app', '');
    console.log(`${r.impressions} imp | pos ${r.position.toFixed(1)} | CTR ${(r.ctr * 100).toFixed(1)}% | ${short}`);
  });

  console.log('\n\n🔍 ALL PAGES SORTED BY POSITION (best first):');
  console.log('─'.repeat(80));
  sorted.filter(r => r.position > 0).sort((a, b) => a.position - b.position).slice(0, 30).forEach(r => {
    const short = r.url.replace('https://spine-link.vercel.app', '');
    console.log(`pos ${r.position.toFixed(1)} | ${r.clicks} clicks | ${r.impressions} imp | ${short}`);
  });

  // Save full data
  writeFileSync('/Volumes/Work/spine-link-src/repo/scripts/pages-data.json', JSON.stringify(sorted, null, 2));
  console.log(`\n📄 Full data saved to scripts/pages-data.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
