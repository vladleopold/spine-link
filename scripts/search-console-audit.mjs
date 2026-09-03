import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'fs';

const KEY_FILE = '/Users/imac/Downloads/zeywin-connect-e8718e11bd82.json';
const SITE_URL = 'https://spine-link.vercel.app/';

async function getAuth() {
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return auth;
}

async function searchConsole() {
  const auth = await getAuth();
  return google.searchconsole({ version: 'v1', auth });
}

function rowToObj(row, headers) {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i]; });
  return obj;
}

async function fetchSearchAnalytics(sc) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);

  const fmt = d => d.toISOString().slice(0, 10);
  const rows = 25000;

  console.log(`\n📊 Fetching analytics from ${fmt(startDate)} to ${fmt(endDate)}...\n`);

  // By queries
  const queries = await sc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['query'],
      rowLimit: rows,
      dataState: 'final',
    },
  });

  // By pages
  const pages = await sc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['page'],
      rowLimit: rows,
      dataState: 'final',
    },
  });

  // By country
  const countries = await sc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['country'],
      rowLimit: rows,
      dataState: 'final',
    },
  });

  // By device
  const devices = await sc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['device'],
      rowLimit: rows,
      dataState: 'final',
    },
  });

  // By date
  const byDate = await sc.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['date'],
      rowLimit: rows,
      dataState: 'final',
    },
  });

  // Search appearance
  let searchAppearance = [];
  try {
    searchAppearance = (await sc.searchanalytics.query({
      siteUrl: SITE_URL,
      requestBody: {
        startDate: fmt(startDate),
        endDate: fmt(endDate),
        dimensions: ['searchAppearance'],
        rowLimit: rows,
        dataState: 'final',
      },
    })).data.rows || [];
  } catch (e) {
    console.log('  (searchAppearance not available)');
  }

  return {
    queries: (queries.data.rows || []).map(r => rowToObj(r.keys, ['query'])),
    pages: (pages.data.rows || []).map(r => rowToObj(r.keys, ['page'])),
    countries: (countries.data.rows || []).map(r => rowToObj(r.keys, ['country'])),
    devices: (devices.data.rows || []).map(r => rowToObj(r.keys, ['device'])),
    byDate: (byDate.data.rows || []).map(r => rowToObj(r.keys, ['date'])),
    searchAppearance: searchAppearance.map(r => rowToObj(r.keys, ['searchAppearance'])),
  };
}

async function fetchSitemaps(sc) {
  console.log('🗺️  Fetching sitemaps...');
  try {
    const res = await sc.sitemaps.list({ siteUrl: SITE_URL });
    return res.data.sitemapIndex || [];
  } catch (e) {
    console.log('  Error:', e.message);
    return [];
  }
}

async function fetchInspectSamples(sc) {
  console.log('🔍 Inspecting sample URLs...');
  const urls = [
    'https://spine-link.vercel.app/',
    'https://spine-link.vercel.app/world-spine-archive',
    'https://spine-link.vercel.app/spine-link.html',
    'https://spine-link.vercel.app/spine-preview-online.html',
    'https://spine-link.vercel.app/spine-web-viewer.html',
  ];

  const results = [];
  for (const url of urls) {
    try {
      const res = await sc.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: url,
          siteUrl: SITE_URL,
        },
      });
      const idx = res.data.inspectionResult.indexStatusResult || {};
      results.push({
        url,
        verdict: idx.verdict,
        coverageState: idx.coverageState,
        robotsTxtState: idx.robotsTxtState,
        referringUrls: idx.referringUrls,
        crawledAs: idx.crawledAs,
        indexStatus: idx.indexStatus,
        lastCrawlTime: idx.lastCrawlTime,
        pageFetchState: idx.pageFetchState,
        verdict: idx.verdict,
        isCanonical: idx.isCanonical,
        isIndexed: idx.isIndexed,
      });
      console.log(`  ✅ ${url} → ${idx.verdict || 'OK'}`);
    } catch (e) {
      console.log(`  ❌ ${url} → ${e.message}`);
      results.push({ url, error: e.message });
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 2000));
  }
  return results;
}

async function main() {
  console.log('🚀 Spine-Link SEO Audit via Google Search Console API\n');

  const sc = await searchConsole();

  // Test access
  try {
    const site = await sc.sites.get({ siteUrl: SITE_URL });
    console.log('✅ Site verified:', site.data.siteUrl, '(permissionLevel:', site.data.permissionLevel, ')');
  } catch (e) {
    console.error('❌ Cannot access site:', e.message);
    console.error('\nMake sure you added this service account email to Search Console:');
    console.error('  spine-link-seo@zeywin-connect.iam.gserviceaccount.com');
    process.exit(1);
  }

  // Collect all data
  const analytics = await fetchSearchAnalytics(sc);
  const sitemaps = await fetchSitemaps(sc);
  const inspections = await fetchInspectSamples(sc);

  // Summary stats
  const totalClicks = analytics.queries.reduce((s, r) => s + (r.clicks || 0), 0);
  const totalImpressions = analytics.queries.reduce((s, r) => s + (r.impressions || 0), 0);
  const totalCtr = totalImpressions ? (totalClicks / totalImpressions * 100).toFixed(2) : 0;
  const totalPosition = analytics.queries.length
    ? (analytics.queries.reduce((s, r) => s + (r.position || 0), 0) / analytics.queries.length).toFixed(1)
    : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    siteUrl: SITE_URL,
    summary: {
      totalClicks,
      totalImpressions,
      averageCtr: totalCtr + '%',
      averagePosition: totalPosition,
      uniqueQueries: analytics.queries.length,
      uniquePages: analytics.pages.length,
      sitemapsCount: sitemaps.length,
    },
    topQueries: analytics.queries
      .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
      .slice(0, 50),
    topPages: analytics.pages
      .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
      .slice(0, 50),
    countries: analytics.countries
      .sort((a, b) => (b.clicks || 0) - (a.clicks || 0)),
    devices: analytics.devices,
    byDate: analytics.byDate.sort((a, b) => a.date?.localeCompare(b.date)),
    searchAppearance: analytics.searchAppearance,
    sitemaps,
    urlInspections: inspections,
  };

  // Save report
  const outPath = '/Volumes/Work/spine-link-src/repo/scripts/seo-audit-report.json';
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report saved to: ${outPath}`);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SEO AUDIT SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total clicks (90d):       ${totalClicks}`);
  console.log(`Total impressions (90d):  ${totalImpressions}`);
  console.log(`Average CTR:              ${totalCtr}%`);
  console.log(`Average position:         ${totalPosition}`);
  console.log(`Unique queries:           ${analytics.queries.length}`);
  console.log(`Unique pages indexed:     ${analytics.pages.length}`);
  console.log(`Sitemaps submitted:       ${sitemaps.length}`);
  console.log('='.repeat(60));

  console.log('\n🔍 Top 10 Queries:');
  analytics.queries
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .slice(0, 10)
    .forEach((q, i) => {
      console.log(`  ${i + 1}. "${q.query}" — ${q.clicks || 0} clicks, ${q.impressions || 0} imp, pos ${(q.position || 0).toFixed(1)}`);
    });

  console.log('\n📄 Top 10 Pages:');
  analytics.pages
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .slice(0, 10)
    .forEach((p, i) => {
      const short = p.page?.replace('https://spine-link.vercel.app', '') || p.page;
      console.log(`  ${i + 1}. ${short} — ${p.clicks || 0} clicks, ${p.impressions || 0} imp`);
    });

  console.log('\n🌍 By Country:');
  analytics.countries
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .slice(0, 10)
    .forEach(c => {
      console.log(`  ${c.country}: ${c.clicks || 0} clicks`);
    });

  console.log('\n📱 By Device:');
  analytics.devices.forEach(d => {
    console.log(`  ${d.device}: ${d.clicks || 0} clicks, ${d.impressions || 0} imp`);
  });

  console.log('\n🔍 URL Inspection Results:');
  inspections.forEach(r => {
    console.log(`  ${r.url}`);
    console.log(`    Verdict: ${r.verdict || 'N/A'}`);
    console.log(`    Indexed: ${r.isIndexed}`);
    console.log(`    Last crawl: ${r.lastCrawlTime || 'never'}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
