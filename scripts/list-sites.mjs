import { google } from 'googleapis';
import { readFileSync } from 'fs';

const KEY_FILE = '/Users/imac/Downloads/zeywin-connect-e8718e11bd82.json';

async function main() {
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  const sc = google.searchconsole({ version: 'v1', auth });

  // List all sites this account has access to
  console.log('🔍 Listing all sites this service account can access...\n');
  try {
    const res = await sc.sites.list();
    const sites = res.data.siteEntry || [];
    if (sites.length === 0) {
      console.log('❌ No sites found. The service account has NOT been added to Search Console yet.');
    } else {
      console.log(`✅ Found ${sites.length} site(s):\n`);
      sites.forEach(s => {
        console.log(`  ${s.siteUrl}  (permission: ${s.permissionLevel})`);
      });
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
