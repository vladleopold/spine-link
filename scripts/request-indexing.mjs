// Helper script to request indexing for key pages via Google Indexing API
// Requires: GOOGLE_APPLICATION_CREDENTIALS env var pointing to service account JSON
// Run: node scripts/request-indexing.mjs

import { google } from 'googleapis';
import { readFileSync } from 'fs';

const KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/Users/imac/Downloads/zeywin-connect-e8718e11bd82.json';
const SITE_URL = 'https://spine-link.vercel.app/';
const KEY_PAGES = [
  '/',
  '/spine-preview.html',
  '/world-spine-archive',
  '/world-spine-archive/book-2026-06-13T19-00-43-423Z',
  '/video/book-2026-06-13T19-00-43-423Z',
  '/spine-link.html',
  '/spine-preview-online.html',
  '/spine-web-viewer.html',
  '/spine-library.html',
  '/spine-portfolio.html',
];

async function requestIndexing() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE,
      scopes: ['https://www.googleapis.com/auth/indexing'],
    });
    const authClient = await auth.getClient();
    const indexing = google.indexing({ version: 'v3', auth: authClient });

    const results = [];
    for (const path of KEY_PAGES) {
      const url = SITE_URL + path.replace(/^\//, '');
      try {
        const res = await indexing.urlNotifications.publish({
          request: {
            url,
            type: 'URL_UPDATED',
          },
        });
        results.push({ url, status: res.status, data: res.data });
        console.log('Published:', url);
      } catch (err) {
        results.push({ url, error: err.message });
        console.error('Failed:', url, err.message);
      }
    }

    console.log('\nSummary:');
    console.log('Success:', results.filter(r => !r.error).length);
    console.log('Failed:', results.filter(r => r.error).length);

    // Check for Indexing API not enabled error
    const apiNotEnabled = results.some(r => r.error?.includes('Indexing API has not been used'));
    if (apiNotEnabled) {
      console.log('\n⚠️ Web Search Indexing API is not enabled on this GCP project.');
      console.log('To enable: https://console.developers.google.com/apis/library/indexing.googleapis.com');
      console.log('\nAlternatively, use manual indexing via Search Console URL Inspection:');
      console.log('https://search.google.com/search-console/url-inspection');
      console.log('\nManual URLs to submit:');
    } else if (results.some(r => r.error)) {
      console.log('\nNote: You can also request indexing manually via:');
      console.log('https://search.google.com/search-console/url-inspection');
      console.log('\nManual URLs to submit:');
    }
    KEY_PAGES.forEach(p => console.log(`  - ${SITE_URL}${p.replace(/^\//, '')}`));
  } catch (err) {
    console.error('Auth error:', err.message);
    console.log('\nManual instructions:');
    console.log('1. Go to: https://search.google.com/search-console/url-inspection');
    console.log('2. Enter each URL and click "Request Indexing"');
    console.log('3. Key URLs:');
    KEY_PAGES.forEach(p => console.log(`   - ${SITE_URL}${p.replace(/^\//, '')}`));
  }
}

requestIndexing();
