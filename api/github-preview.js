import { sanitizeSkeletonJson } from '../lib/spine-json-sanitize.js';
import { runtimeVersionOverrideForSpineSkeleton, selectSpineRuntimeSkeleton } from '../lib/spine-runtime-file-selection.js';
import { canReadPublicSpineWithoutToken } from '../lib/github-read-access.js';
import { isValidSpineAtlasHeader } from '../lib/spine-atlas-integrity.js';
import { metricCountsForId, parseMetricsJson } from '../lib/spine-metrics.js';

import { cacheProfiles, setCacheHeaders, setNoStoreHeaders } from '../lib/cache-headers.js';
import { appendAssetVersion, assetVersionForEntry } from '../lib/asset-version.js';
import { cachedGithubText } from '../lib/github-content-cache.js';
import { indexedFilePath, previewIndexPath } from '../lib/github-preview-index.js';

const defaultOwner = 'vladleopold';
const defaultRepo = 'spine';
const defaultBranch = 'main';
const defaultBasePath = 'library';

function cleanRepoPath(value = '') {
  return String(value).trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function basename(value = '') {
  return String(value).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

function joinRepoPath(...parts) {
  return parts.map(cleanRepoPath).filter(Boolean).join('/');
}

function encodeRepoPath(path) {
  return cleanRepoPath(path)
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function versionedAssetUrl(origin, item, version) {
  return appendAssetVersion(`${origin}/assets/${encodeRepoPath(item.path)}`, version);
}

function assetUrlForRepoPath(origin, path, version = '') {
  return appendAssetVersion(`${origin}/assets/${encodeRepoPath(path)}`, version);
}

function base64ToText(base64) {
  return Buffer.from(String(base64).replace(/\s/g, ''), 'base64').toString('utf8');
}

class SpineBinaryCursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.index = 0;
  }

  skip(count) {
    this.index = Math.min(this.bytes.length, this.index + count);
  }

  readByte() {
    if (this.index >= this.bytes.length) throw new Error('Unexpected end of Spine binary.');
    return this.bytes[this.index++];
  }

  readInt(optimizePositive = true) {
    let byte = this.readByte();
    let result = byte & 0x7f;
    if ((byte & 0x80) !== 0) {
      byte = this.readByte();
      result |= (byte & 0x7f) << 7;
      if ((byte & 0x80) !== 0) {
        byte = this.readByte();
        result |= (byte & 0x7f) << 14;
        if ((byte & 0x80) !== 0) {
          byte = this.readByte();
          result |= (byte & 0x7f) << 21;
          if ((byte & 0x80) !== 0) result |= (this.readByte() & 0x7f) << 28;
        }
      }
    }
    return optimizePositive ? result : ((result >>> 1) ^ -(result & 1));
  }

  readString() {
    const byteCount = this.readInt(true);
    if (byteCount === 0) return null;
    const length = byteCount - 1;
    const start = this.index;
    const end = start + length;
    if (end > this.bytes.length) throw new Error('Invalid Spine binary string length.');
    this.index = end;
    return Buffer.from(this.bytes.slice(start, end)).toString('utf8');
  }
}

function extractVersion(v) {
  const m = String(v).match(/^(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

function spineBinaryVersionFromBase64(base64 = '') {
  const bytes = Buffer.from(String(base64).replace(/\s/g, ''), 'base64');
  const legacyCursor = new SpineBinaryCursor(bytes);
  try {
    legacyCursor.readString();
    const version = extractVersion(legacyCursor.readString());
    if (version) return version;
  } catch {
    // Try newer binary header below.
  }

  const cursor = new SpineBinaryCursor(bytes);
  try {
    cursor.skip(8);
    return extractVersion(cursor.readString()) || '';
  } catch {
    return '';
  }
}

function escapedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function sanitizeSkeletonData(json) {
  return sanitizeSkeletonJson(json);
}

// Margin kept around an animation inside the preview canvas. The runtime frames a
// clip from the union of every frame's attachment quads, and for VFX-only skeletons
// (soft glows, staggered particles) that box is far larger than the pixels a viewer
// actually sees. A wide margin then shrinks the visible burst to a small dim blob in
// the middle of the canvas. A narrow margin keeps the framing close to the exported
// video, which is rendered with no padding at all, while still leaving room for
// elements that reach the very edge of their quad.
const PREVIEW_PAD = "0%";

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanPublicText(value = '', maxLength = 120) {
  return String(value).trim().slice(0, maxLength);
}

function safePublicImage(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) || /^data:image\/webp;base64,/i.test(url) ? url : '';
}

function skinNamesFromSkeletonJson(skeletonJson) {
  if (!skeletonJson || typeof skeletonJson !== 'object' || !('skins' in skeletonJson)) return [];
  const skins = skeletonJson.skins;
  if (Array.isArray(skins)) {
    return skins
      .map((skin) => {
        if (typeof skin === 'string') return skin;
        if (skin && typeof skin === 'object' && typeof skin.name === 'string') return skin.name;
        return '';
      })
      .filter(Boolean);
  }
  if (skins && typeof skins === 'object') return Object.keys(skins).filter(Boolean);
  return [];
}

function preferredSkinName(skinNames) {
  if (!skinNames.length) return '';
  return skinNames.includes('default') ? 'default' : skinNames[0] || '';
}

function extractAtlasPages(atlasText = '') {
  return String(atlasText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.(png|jpe?g|webp|dds)$/i.test(line));
}

function canonicalAtlasPageName(pageName = '') {
  return basename(String(pageName || '').replace(/\\/g, '/').trim());
}

function imageMatchesAtlasPage(imageName = '', pageName = '') {
  const imageBase = basename(String(imageName || '').replace(/\\/g, '/').trim()).toLowerCase();
  const pageBase = canonicalAtlasPageName(pageName).toLowerCase();
  if (!imageBase || !pageBase) return false;
  if (imageBase === pageBase) return true;
  if (pageBase.endsWith(imageBase)) return true;
  if (imageBase.endsWith(pageBase)) return true;
  return false;
}

function safePublicVideo(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+\.webm(?:[?#][^\s"'<>]*)?$/i.test(url) ? url : '';
}

function safePublicAsset(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function sanitizeSha256(value = '') {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function shortHash(value = '') {
  const hash = String(value || '').trim();
  return hash.length > 22 ? `${hash.slice(0, 12)}...${hash.slice(-8)}` : hash;
}

function generatedThumbnailUrl(origin, entry) {
  const id = String(entry?.id || '').trim();
  const poster = String(entry?.thumbnailPoster || '');
  return id && /^data:image\/webp;base64,/i.test(poster)
    ? assetUrlForRepoPath(origin, `library/${id}/generated-preview.webp`, assetVersionForEntry(entry, 'generated-preview'))
    : '';
}

function entryImageAsset(value = '', entry = {}, fallback = '') {
  return appendAssetVersion(safePublicImage(value), assetVersionForEntry(entry, fallback));
}

function entryVideoAsset(value = '', entry = {}, fallback = '') {
  return appendAssetVersion(safePublicVideo(value), assetVersionForEntry(entry, fallback));
}

function isoDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function durationToIso8601(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return `PT${Math.max(1, Math.round(seconds))}S`;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function pageUrlForEntry(origin, entryId) {
  return `${origin}/p/${encodeURIComponent(String(entryId || '').trim())}`;
}

function playerUrlForEntry(origin, entry, entryId) {
  const id = encodeURIComponent(String(entry?.id || entryId || '').trim());
  const animation = typeof entry?.defaultAnimation === 'string' ? entry.defaultAnimation : '';
  return animation.trim() ? `${origin}/p/${id}?animation=${encodeURIComponent(animation)}` : `${origin}/p/${id}`;
}

function archiveUrlForEntry(origin, entry, entryId) {
  const id = String(entry?.id || entryId || '').trim();
  return id ? `${origin}/world-spine-archive/${encodeURIComponent(id)}` : '';
}

function robotsHeaderValue(value = '') {
  const robots = String(value || '').trim();
  return robots
    ? robots.split(',').map((part) => part.trim()).filter(Boolean).join(', ')
    : 'index, follow, max-image-preview:large, max-video-preview:-1, max-snippet:-1';
}

function entryHasFile(entry, fileName = '') {
  const name = String(fileName || '').trim().toLowerCase();
  return Array.isArray(entry?.files) && entry.files.some((file) => String(file || '').trim().toLowerCase() === name);
}

function sourceProofUrlForEntry(origin, entry) {
  const direct = safePublicAsset(entry?.sourceProofUrl || entry?.sourceProof?.proofUrl);
  if (direct) return direct;
  const path = cleanRepoPath(entry?.sourceProofPath || entry?.sourceProof?.proofPath || '');
  if (path) return `${origin}/assets/${encodeRepoPath(path)}`;
  if (entryHasFile(entry, 'source-proof.json') && entry?.previewPath) {
    return `${origin}/assets/${encodeRepoPath(`${entry.previewPath}/source-proof.json`)}`;
  }
  return '';
}

function blockchainAnchorUrlForEntry(origin, entry) {
  const direct = safePublicAsset(entry?.blockchainAnchor?.anchorUrl || entry?.blockchainAnchor?.github?.anchorUrl);
  if (direct) return direct;
  const path = cleanRepoPath(entry?.blockchainAnchor?.anchorPath || entry?.blockchainAnchor?.github?.anchorPath || '');
  if (path) return `${origin}/assets/${encodeRepoPath(path)}`;
  if (entryHasFile(entry, 'blockchain-anchor.json') && entry?.previewPath) {
    return `${origin}/assets/${encodeRepoPath(`${entry.previewPath}/blockchain-anchor.json`)}`;
  }
  return '';
}

function proofDocumentsForEntry(origin, entry, pageUrl) {
  const sourceProofUrl = sourceProofUrlForEntry(origin, entry);
  const blockchainAnchorUrl = blockchainAnchorUrlForEntry(origin, entry);
  const proofHash = sanitizeSha256(entry?.sourceProof?.proofHash || entry?.blockchainAnchor?.sourceProofHash);
  const anchorHash = sanitizeSha256(entry?.blockchainAnchor?.anchorHash);
  const documents = [];
  if (sourceProofUrl) {
    documents.push({
      '@type': 'DigitalDocument',
      '@id': `${pageUrl}#source-proof`,
      name: 'Spine-Link source origin proof',
      url: sourceProofUrl,
      encodingFormat: 'application/json',
      description:
        'Source-origin proof JSON linking uploaded Spine files to SHA-256 hashes, upload timestamps, and the GitHub repository path; new records omit account and browser/device identifiers.',
      ...(proofHash
        ? {
            identifier: {
              '@type': 'PropertyValue',
              propertyID: 'SHA-256',
              value: proofHash,
            },
          }
        : {}),
    });
  }
  if (blockchainAnchorUrl) {
    documents.push({
      '@type': 'DigitalDocument',
      '@id': `${pageUrl}#blockchain-anchor`,
      name: 'Spine-Link GitHub blockchain anchor',
      url: blockchainAnchorUrl,
      encodingFormat: 'application/json',
      description:
        'Blockchain anchor JSON linking the source proof hash, GitHub commit receipts, browser/account evidence, and optional EVM transaction data.',
      ...(anchorHash
        ? {
            identifier: {
              '@type': 'PropertyValue',
              propertyID: 'SHA-256',
              value: anchorHash,
            },
          }
        : {}),
    });
  }
  return documents;
}

function textFromEntry(entry, field = 'all') {
  if (!entry || typeof entry !== 'object') return '';
  const files = Array.isArray(entry.files) ? entry.files.join(' ') : '';
  const animations = Array.isArray(entry.animations) ? entry.animations.join(' ') : '';
  const values = {
    all: [entry.id, entry.title, entry.ownerEmail, entry.ownerName, entry.note, entry.skeleton, entry.atlas, files, animations, entry.previewPath, entry.repositoryUrl],
    id: [entry.id],
    title: [entry.title],
    ownerEmail: [entry.ownerEmail],
    ownerName: [entry.ownerName],
    note: [entry.note],
    files: [files],
    animations: [animations],
    path: [entry.previewPath, entry.repositoryUrl],
  };
  return (values[field] || values.all).filter(Boolean).join(' ');
}

function exclusionRuleMatches(entry, rule) {
  if (!rule || rule.enabled === false) return false;
  const pattern = String(rule.pattern || '').trim();
  if (!pattern) return false;
  const haystack = textFromEntry(entry, String(rule.field || 'all'));
  if (!haystack) return false;
  if (rule.type === 'regex') {
    try {
      const flags = String(rule.flags || 'i').replace(/[^dgimsuvy]/g, '') || 'i';
      return new RegExp(pattern, flags).test(haystack);
    } catch {
      return false;
    }
  }
  return haystack.toLowerCase().includes(pattern.toLowerCase());
}

function entryExcludedFromArchive(entry, exclusions) {
  const rules = Array.isArray(exclusions?.rules) ? exclusions.rules : [];
  return rules.some((rule) => exclusionRuleMatches(entry, rule));
}

function isPublicArchiveEntry(entry, exclusions) {
  return Boolean(
    entry &&
      entry.hiddenFromPublicLibrary !== true &&
      (entry.webmPreview || entry.thumbnail || entry.thumbnailPoster) &&
      !entryExcludedFromArchive(entry, exclusions),
  );
}

function videoMetadataForEntry(origin, entry, entryId, note = '', canonicalUrl = '', embedUrl = '') {
  const id = String(entry?.id || entryId || '').trim();
  // Prefer the preview of an animation that is actually long enough to show as
  // a moving clip. A 1-frame `idle` preview is a still image, so the video-watch
  // panel and the SEO metadata would otherwise surface a zero-length video.
  const target = resolvePreviewTarget(entry, origin);
  const contentUrl = target.url ? entryVideoAsset(target.url, entry, 'webm') : '';
  const poster = entryImageAsset(target.poster || '', entry, 'poster') ||
    entryImageAsset(entry?.thumbnail || '', entry, 'thumbnail');
  if (!id || !contentUrl || !poster) return null;
  const name = cleanPublicText(entry?.title || id || 'Spine animation preview', 110);
  const description =
    cleanPublicText(note || entry?.note || `${name} Spine animation video preview and interactive Spine web player on Spine-Link.`, 260) ||
    `${name} Spine animation video preview and interactive Spine web player on Spine-Link.`;
  const watchPageUrl = `${origin}/video/${encodeURIComponent(id)}`;
  return {
    id,
    name,
    description,
    thumbnailUrl: poster,
    contentUrl,
    previewAnimation: target.name,
    embedUrl: embedUrl || watchPageUrl,
    url: watchPageUrl,
    playerPageUrl: canonicalUrl || pageUrlForEntry(origin, id),
    proofDocuments: proofDocumentsForEntry(origin, entry, watchPageUrl),
    sourceProofUrl: sourceProofUrlForEntry(origin, entry),
    blockchainAnchorUrl: blockchainAnchorUrlForEntry(origin, entry),
    proofHash: sanitizeSha256(entry?.sourceProof?.proofHash || entry?.blockchainAnchor?.sourceProofHash),
    anchorHash: sanitizeSha256(entry?.blockchainAnchor?.anchorHash),
    uploadDate: isoDate(entry?.uploadedAt) || '2026-05-04T00:00:00.000Z',
    duration: durationToIso8601(Number.isFinite(target.duration) && target.duration > 0 ? target.duration : entry?.previewDuration),
    width: positiveInteger(entry?.previewWidth),
    height: positiveInteger(entry?.previewHeight),
  };
}

function breadcrumbStructuredData(items) {
  return items.length > 1 ? {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  } : null;
}

function seoHead({
  origin,
  entryId,
  video,
  fallbackTitle = 'Spine-Link',
  robots = 'index,follow,max-image-preview:large,max-video-preview:-1,max-snippet:-1',
  playerUrl = '',
  archiveUrl = '',
}) {
  const title = video?.name ? `${video.name} - Spine animation video preview` : fallbackTitle;
  const description = video?.description || 'Spine-Link interactive Spine animation preview and Spine web viewer.';
  const url = video?.url || (entryId ? pageUrlForEntry(origin, entryId) : origin);
  const image = video?.thumbnailUrl || `${origin}/spine-link-video-thumbnail.png`;
  const structuredData = video
    ? {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        '@id': `${video.playerPageUrl || video.url}#video`,
        name: video.name,
        description: video.description,
        thumbnailUrl: [video.thumbnailUrl],
        uploadDate: video.uploadDate,
        contentUrl: video.contentUrl,
        embedUrl: video.playerPageUrl || video.embedUrl,
        url: video.playerPageUrl || video.url,
        mainEntityOfPage: video.playerPageUrl || video.url,
        isFamilyFriendly: true,
        ...(Array.isArray(video.proofDocuments) && video.proofDocuments.length
          ? { subjectOf: video.proofDocuments.map((document) => ({ '@id': document['@id'] })) }
          : {}),
        ...(video.duration ? { duration: video.duration } : {}),
        ...(video.width ? { width: video.width } : {}),
        ...(video.height ? { height: video.height } : {}),
        potentialAction: {
          '@type': 'WatchAction',
          target: video.url,
        },
        publisher: {
          '@type': 'Organization',
          name: 'Spine Portfolio',
          alternateName: 'Spine-Link',
          url: origin,
        },
      }
    : null;
  const imageStructuredData = video
    ? {
        '@context': 'https://schema.org',
        '@type': 'ImageObject',
        contentUrl: video.thumbnailUrl,
        url: video.thumbnailUrl,
        name: `${video.name} preview frame`,
        representativeOfPage: true,
      }
    : null;
  const proofStructuredData = video?.proofDocuments?.length
    ? {
        '@context': 'https://schema.org',
        '@graph': video.proofDocuments,
      }
    : null;
  const breadcrumbs = breadcrumbStructuredData([
    { name: 'Spine-Link', url: origin },
    ...(archiveUrl ? [{ name: 'World SPINE ARCHIVE', url: archiveUrl }] : []),
    { name: video?.name || fallbackTitle, url: video?.url || url },
  ]);
  return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="${escapeHtml(robots)}" />
    <meta name="googlebot" content="${escapeHtml(robots)}" />
    <meta name="application-name" content="Spine Portfolio" />
    <meta name="apple-mobile-web-app-title" content="Spine Portfolio" />
    <meta name="theme-color" content="#000000" />
    <link rel="canonical" href="${escapeHtml(video?.playerPageUrl || url)}" />
    ${video?.url && video.url !== url ? `<link rel="alternate" href="${escapeHtml(video.url)}" title="${escapeHtml(video.name)} video watch page" />` : ''}
    ${archiveUrl && archiveUrl !== url ? `<link rel="alternate" href="${escapeHtml(archiveUrl)}" title="World SPINE ARCHIVE detail page" />` : ''}
    <meta property="og:type" content="${video ? 'video.other' : 'website'}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:site_name" content="Spine Portfolio" />
    <meta property="og:image" content="${escapeHtml(image)}" />${video ? `
    <meta property="og:video" content="${escapeHtml(video.contentUrl)}" />
    <meta property="og:video:secure_url" content="${escapeHtml(video.contentUrl)}" />
    <meta property="og:video:type" content="video/webm" />
    ${video.width ? `<meta property="og:video:width" content="${video.width}" />` : ''}
    ${video.height ? `<meta property="og:video:height" content="${video.height}" />` : ''}` : ''}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(image)}" />${structuredData ? `
    <script type="application/ld+json">${escapedJson(structuredData)}</script>
    <script type="application/ld+json">${escapedJson(imageStructuredData)}</script>${proofStructuredData ? `
    <script type="application/ld+json">${escapedJson(proofStructuredData)}</script>` : ''}` : ''}${breadcrumbs ? `
    <script type="application/ld+json">${escapedJson(breadcrumbs)}</script>` : ''}`;
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function githubApiFetch(url, token) {
  let response = await fetch(url, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(8000),
  });
  // A 403 is commonly a rate-limit response; retrying anonymously only
  // consumes the separate public quota. Raw index reads are the fallback.
  if (!response.ok && token && response.status === 401) {
    response = await fetch(url, {
      headers: githubHeaders(''),
      signal: AbortSignal.timeout(8000),
    });
  }
  return response;
}

function isSkeleton(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.skel');
}

function isAtlas(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.atlas') || lower.endsWith('.atlas.txt') || lower.endsWith('.atlas.docx');
}

function isImage(name) {
  return /\.(png|jpe?g|webp|dds)$/i.test(name);
}

function stem(name) {
  return name
    .replace(/\.atlas(?:\.txt|\.docx)?$/i, '')
    .replace(/\.(json|skel|png|jpe?g|webp|dds)$/i, '');
}

function viewportFromJson(json) {
  const bounds = json?.skeleton;
  if (
    typeof bounds?.x === 'number' &&
    typeof bounds.y === 'number' &&
    typeof bounds.width === 'number' &&
    typeof bounds.height === 'number'
  ) {
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }
  return undefined;
}

function animationNamesFromJson(json) {
  return Object.keys(json?.animations || {});
}

function hasPremultipliedAlpha(atlasText = '') {
  const match = String(atlasText).match(/^\s*pma\s*:\s*(true|false)\s*$/im);
  return match ? match[1].toLowerCase() === 'true' : false;
}

function compareLibraryEntries(a, b) {
  const aOrder = Number(a?.libraryOrder);
  const bOrder = Number(b?.libraryOrder);
  const hasAOrder = Number.isFinite(aOrder);
  const hasBOrder = Number.isFinite(bOrder);
  if (hasAOrder && hasBOrder && aOrder !== bOrder) return aOrder - bOrder;
  if (hasAOrder !== hasBOrder) return hasAOrder ? -1 : 1;
  return String(b?.uploadedAt || '').localeCompare(String(a?.uploadedAt || ''));
}

async function githubJson(settings, path) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
  const response = await githubApiFetch(
    `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}?ref=${encodeURIComponent(settings.branch)}`,
    settings.token,
  );
  if (!response.ok) return null;
  return response.json();
}

// Every library_NN folder is a collection; they are listed at runtime so a folder
// added by a rotation is found without a deploy.
// Works are spread across library_01, library_02, ... folders, each capped at the
// GitHub limit. They are listed at runtime so a folder added by a rotation shows up
// without a code change or a deploy.
const collectionPathCache = globalThis.__spineLinkCollectionPathCache || new Map();
globalThis.__spineLinkCollectionPathCache = collectionPathCache;

async function libraryCollectionPaths(settings) {
  const basePath = cleanRepoPath(settings.basePath || defaultBasePath);
  const cacheKey = [settings.owner, settings.repo, settings.branch, basePath].join('\n');
  const cached = collectionPathCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return [...cached.paths];

  // GitHub root Contents listings may be truncated when a repository has many
  // root entries. Always search the two established public shards as well as
  // the configured base path, even when the root listing appears successful.
  const paths = new Set([basePath, 'library_02', 'library_01']);
  try {
    const response = await githubApiFetch(
      `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/?ref=${encodeURIComponent(settings.branch)}&per_page=100`,
      settings.token,
    );
    if (response.ok) {
      const items = await response.json();
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item?.type === 'dir' && /^library(_\d+)?$/.test(String(item.name || ''))) {
            paths.add(item.name);
          }
        }
      }
    }
  } catch {
    // Fall back to established collection shards if the root listing is unavailable.
  }
  // New uploads are in the newest collection. Searching library_01 first can
  // download a 20+ MB legacy index and time out the Vercel invocation.
  const rank = (name) => /^library_(\d+)$/.test(name)
    ? Number(name.match(/^library_(\d+)$/)[1])
    : name === 'library' ? 0 : -1;
  const result = [...paths].filter(Boolean).sort((a, b) => rank(b) - rank(a));
  collectionPathCache.set(cacheKey, { paths: result, expiresAt: Date.now() + 60_000 });
  if (collectionPathCache.size > 24) {
    const oldest = collectionPathCache.keys().next().value;
    if (oldest) collectionPathCache.delete(oldest);
  }
  return result;
}
async function githubText(settings, path, options = {}) {
  return cachedGithubText(settings, path, options);
}

async function githubFileContent(settings, path) {
  const data = await githubJson(settings, path);
  return data && typeof data.content === 'string' ? data.content : '';
}

async function githubFileHead(settings, path, maxBytes = 256) {
  const rawUrl = `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${settings.branch}/${encodeRepoPath(path)}`;
  const rangeHeaders = {
    Range: `bytes=0-${maxBytes - 1}`,
    Accept: 'application/octet-stream',
  };
  let response = await fetch(rawUrl, {
    headers: { ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}), ...rangeHeaders },
  });
  if (!response.ok && response.status !== 206 && settings.token && (response.status === 401 || response.status === 403)) {
    response = await fetch(rawUrl, { headers: rangeHeaders });
  }
  if (!response.ok && response.status !== 206) return '';
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('base64');
}

async function githubList(settings, path) {
  const data = await githubJson(settings, path);
  return Array.isArray(data) ? data : [];
}

async function findSpineSetDirectories(settings, uploadPath, maxDepth = 3, indexedEntry = null) {
  // The collection index already records every file belonging to this work.
  // Prefer that manifest when GitHub's directory Contents API is throttled;
  // public raw-file reads can still load the actual skeleton, atlas and images.
  const indexedFiles = Array.isArray(indexedEntry?.files)
    ? indexedEntry.files.map((file) => cleanRepoPath(indexedFilePath(file))).filter(Boolean)
    : [];
  if (indexedFiles.length) {
    const uploadPrefix = `${cleanRepoPath(uploadPath)}/`;
    const normalizedFiles = indexedFiles.map((filePath) =>
      filePath.startsWith(uploadPrefix) ? filePath.slice(uploadPrefix.length) : filePath
    ).filter(Boolean);
    const groups = new Map();
    const fileVersion = String(indexedEntry?.uploadedAt || indexedEntry?.updatedAt || '');
    for (const filePath of normalizedFiles) {
      const slash = filePath.lastIndexOf('/');
      const parent = slash >= 0 ? filePath.slice(0, slash) : '';
      const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
      if (!name) continue;
      const items = groups.get(parent) || [];
      items.push({
        type: 'file',
        name,
        path: joinRepoPath(uploadPath, filePath),
        sha: fileVersion,
      });
      groups.set(parent, items);
    }

    const indexedDirectories = [];
    for (const [relativeDir, directItems] of groups) {
      const hasSkeleton = directItems.some((item) => isSkeleton(item.name));
      const hasAtlas = directItems.some((item) => isAtlas(item.name));
      if (!hasSkeleton || !hasAtlas) continue;

      // Texture pages may live in an images/ subfolder while the skeleton and
      // atlas stay at the work root. Include descendant images using paths
      // relative to the skeleton/atlas directory so atlas page names still match.
      const prefix = relativeDir ? `${relativeDir}/` : '';
      const descendantTextures = normalizedFiles
        .filter((filePath) => {
          const slash = filePath.lastIndexOf('/');
          const parent = slash >= 0 ? filePath.slice(0, slash) : '';
          return parent !== relativeDir && parent.startsWith(prefix) && isImage(filePath);
        })
        .map((filePath) => ({
          type: 'file',
          name: filePath.slice(prefix.length),
          path: joinRepoPath(uploadPath, filePath),
          sha: fileVersion,
        }));
      const items = [...directItems, ...descendantTextures];
      if (!items.some((item) => isImage(item.name))) continue;
      indexedDirectories.push({
        name: relativeDir.split('/').filter(Boolean).pop() || cleanRepoPath(uploadPath).split('/').pop() || uploadPath,
        path: joinRepoPath(uploadPath, relativeDir),
        items,
      });
    }
    if (indexedDirectories.length) return indexedDirectories;
  }

  // Older collection entries often store the runtime file names in
  // skeleton/atlas/textures rather than a complete files[] manifest. Use those
  // indexed paths directly so an archived preview does not depend on the
  // GitHub Contents directory API being available during page rendering.
  if (!indexedFiles.length && indexedEntry) {
    const skeletonPath = cleanRepoPath(indexedEntry.skeleton || '');
    const atlasPath = cleanRepoPath(indexedEntry.atlas || '');
    const texturePaths = Array.isArray(indexedEntry.textures)
      ? indexedEntry.textures.map(cleanRepoPath).filter(filePath => filePath && isImage(filePath))
      : [];
    const parentOf = filePath => {
      const slash = filePath.lastIndexOf('/');
      return slash >= 0 ? filePath.slice(0, slash) : '';
    };
    const baseName = filePath => filePath.slice(filePath.lastIndexOf('/') + 1);
    const skeletonParent = skeletonPath ? parentOf(skeletonPath) : '';
    if (skeletonPath && atlasPath && parentOf(atlasPath) === skeletonParent && texturePaths.length) {
      const fileVersion = String(indexedEntry.uploadedAt || indexedEntry.updatedAt || 'indexed-legacy-manifest');
      const relativeTexturePaths = texturePaths
        .filter(filePath => {
          const parent = parentOf(filePath);
          return parent === skeletonParent || parent.startsWith(skeletonParent ? skeletonParent + '/' : '');
        })
        .map(filePath => ({
          type: 'file',
          name: skeletonParent ? filePath.slice(skeletonParent.length + 1) : filePath,
          path: joinRepoPath(uploadPath, filePath),
          sha: fileVersion,
        }));
      const items = [
        { type: 'file', name: baseName(skeletonPath), path: joinRepoPath(uploadPath, skeletonPath), sha: fileVersion },
        { type: 'file', name: baseName(atlasPath), path: joinRepoPath(uploadPath, atlasPath), sha: fileVersion },
        ...relativeTexturePaths,
      ];
      if (items.some(item => isImage(item.name))) {
        return [{
          name: skeletonParent.split('/').filter(Boolean).pop() || cleanRepoPath(uploadPath).split('/').pop() || uploadPath,
          path: joinRepoPath(uploadPath, skeletonParent),
          items,
        }];
      }
    }
  }

  // Older records without a file manifest retain the directory-listing path.
  const found = [];
  const seen = new Set();
  async function visit(path, depth) {
    const cleanPath = cleanRepoPath(path);
    if (!cleanPath || seen.has(cleanPath) || depth > maxDepth) return;
    seen.add(cleanPath);
    const items = await githubList(settings, cleanPath);
    const hasSkeleton = items.some((item) => item.type === 'file' && isSkeleton(item.name));
    const hasAtlas = items.some((item) => item.type === 'file' && isAtlas(item.name));
    const hasTexture = items.some((item) => item.type === 'file' && isImage(item.name));
    if (hasSkeleton && hasAtlas && hasTexture) {
      found.push({ name: cleanPath.split('/').pop() || cleanPath, path: cleanPath, items });
      return;
    }
    const directories = items.filter((item) => item.type === 'dir');
    for (const directory of directories) await visit(directory.path, depth + 1);
  }
  await visit(uploadPath, 0);
  return found;
}

// Download buttons for the work page sidebar — mirrors the editor block in
// src/SpineApp.tsx so the server-rendered /p/<id> page offers the same files.
// Resolve media only from the exact indexed defaultAnimation. A missing or short
// selected preview remains blocked; another animation is never substituted.
function resolvePreviewTarget(entry, origin = '') {
  const previewAnimation = typeof entry?.previewAnimation === 'string' ? entry.previewAnimation : '';
  const defaultAnimation = typeof entry?.defaultAnimation === 'string' ? entry.defaultAnimation : '';
  const chosen = previewAnimation.trim() ? previewAnimation : defaultAnimation;
  const previews = entry && entry.allAnimationPreviews && typeof entry.allAnimationPreviews === 'object'
    ? entry.allAnimationPreviews
    : null;
  const selectedAnimation = chosen.trim() && previews && previews[chosen] ? chosen : defaultAnimation;
  const selected = selectedAnimation.trim() && previews ? previews[selectedAnimation] : null;
  const fix = origin ? (value) => repairAnimationAssetUrl(entry, value, origin) : (value) => value;
  const selectedFullValue = selected?.webmPreview || selected?.webmPreviewMedium || selected?.webmPreviewLow || '';
  const selectedLowValue = selected?.webmPreviewLow || selected?.webmPreviewMedium || selected?.webmPreview || '';
  const selectedUrl = typeof selectedFullValue === 'string' && selectedFullValue.trim()
    ? fix(selectedFullValue.trim())
    : '';
  const selectedLowUrl = typeof selectedLowValue === 'string' && selectedLowValue.trim()
    ? fix(selectedLowValue.trim())
    : '';
  const durationValue = Number(selected?.previewDuration ?? entry?.previewDuration ?? 0);
  const duration = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : 0;
  const shortClip = duration > 0 && duration < 2;
  const fallbackFull = String(entry?.webmPreview || entry?.webmPreviewMedium || entry?.webmPreviewLow || '').trim();
  const fallbackLow = String(entry?.webmPreviewLow || entry?.webmPreviewMedium || entry?.webmPreview || '').trim();
  const fallbackPoster = String(entry?.webpPosterMedium || entry?.webpPoster || entry?.thumbnailPoster || '').trim();
  const hasAnimationPreview = Boolean(selectedUrl || selectedLowUrl);
  return {
    name: selectedAnimation || chosen || defaultAnimation || '',
    url: shortClip ? '' : (selectedUrl || fallbackFull),
    lowUrl: shortClip ? '' : (selectedLowUrl || fallbackLow || selectedUrl || fallbackFull),
    poster: typeof selected?.webpPosterMedium === 'string' && selected.webpPosterMedium.trim()
      ? selected.webpPosterMedium.trim()
      : (typeof selected?.webpPoster === 'string' && selected.webpPoster.trim()
        ? selected.webpPoster.trim()
        : fallbackPoster),
    duration,
    isFallback: !hasAnimationPreview && Boolean(fallbackFull || fallbackLow),
  };
}

// Compact download picker for the sidebar.
//
// The old block listed every combination as its own button — five formats times
// three sizes times every animation, which produced dozens of identical-looking
// buttons and pushed the rest of the sidebar off-screen. It is replaced by a
// three-step cascading selector: choose a FORMAT, choose a SIZE, then choose
// whether to download every animation in one click or pick them one by one.
// The steps slide horizontally so the interaction reads as one compact control
// instead of a long list, and each step is keyboard reachable.
const DOWNLOAD_FORMATS = [
  { id: 'webm', label: 'WebM', note: 'VP9 · small file' },
  { id: 'mp4', label: 'MP4', note: 'H.264 · widest support' },
  { id: 'mov', label: 'MOV \u03b1', note: 'ProRes 4444 · alpha' },
  { id: 'gif', label: 'GIF \u03b1', note: 'Palette · alpha, loops' },
  { id: 'png', label: 'PNG seq \u03b1', note: 'Zip of frames · alpha' },
];

// Labels are filled in per work from the real pixel width the exporter wrote
// into meta.json. The fixed 1080p/720p/360p names were only accurate for the
// handful of clips rendered above 1080 wide; for everything else the "720p"
// button handed out the same bytes as the "1080p" one.
const DOWNLOAD_QUALITIES = [
  { id: 'high', label: 'Original', suffix: '' },
  { id: 'medium', label: 'Medium', suffix: 'Medium' },
  { id: 'low', label: 'Small', suffix: 'Low' },
];

function downloadKeysFor(format, suffix) {
  const cap = suffix;
  switch (format) {
    case 'mp4': return [`mp4Preview${cap}`];
    case 'mov': return [`movAlpha${cap}`];
    case 'gif': return [`gifAlpha${cap}`];
    case 'png': return [`pngAlpha${cap}`];
    default:    return [`webmPreview${cap}`];
  }
}

function animationDownloadIcon() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0-12l4 4m-4-4-4 4M5 17v3h14v-3"/></svg>';
}

// Repairs a stored asset URL that points at a collection folder the work has
// since been rotated out of.
//
// index.json keeps absolute URLs per animation, but when the library rotates
// (999 files -> library_NN+1) a work's files move while the already-written
// URLs stay behind. Those links then 404 and the browser saves the 404 page
// instead of the video, which shows up as a ".html" download named after the
// clip. previewPath is the only field that always tracks where the work lives
// now, so every per-animation URL is rebuilt from it using just the filename.
// Same repair for the work-level preview fields (webmPreview, webmPreviewMedium,
// webmPreviewLow, webpPoster…): they live directly under previewPath rather than
// under animations/<name>/, so only the file name has to be swapped.
function repairEntryAssetUrl(entry, url, origin) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const file = raw.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
  const previewPath = cleanRepoPath(entry?.previewPath || '');
  if (!file || !previewPath) return raw;
  const version = raw.match(/[?#]v=([^&#]+)/);
  return assetUrlForRepoPath(origin, joinRepoPath(previewPath, file), version ? version[1] : '');
}

function repairAnimationAssetUrl(entry, url, origin) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const file = raw.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
  if (!file) return raw;
  const previewPath = cleanRepoPath(entry?.previewPath || '');
  if (!previewPath) return raw;
  const version = raw.match(/[?#]v=([^&#]+)/);
  return assetUrlForRepoPath(origin, joinRepoPath(previewPath, 'animations', basename(dirnameOfAnimationUrl(raw)), file), version ? version[1] : '');
}

// The per-animation folder is the parent directory of the file inside the
// /animations/<safeName>/<file> layout.
function dirnameOfAnimationUrl(url) {
  const parts = String(url).split('?')[0].split('#')[0].split('/').filter(Boolean);
  parts.pop();
  return parts.pop() || '';
}

function animationDownloadBlock(entry, origin) {
  const previews = entry && entry.allAnimationPreviews && typeof entry.allAnimationPreviews === 'object'
    ? entry.allAnimationPreviews
    : null;
  if (!previews || !Object.keys(previews).length) return "";

  const animations = Object.keys(previews);
  // Every returned URL is rebuilt from previewPath, so a work that was rotated
  // into library_NN+1 still downloads from where its files actually are.
  const pick = (name, keys) => {
    const p = previews[name];
    if (!p) return '';
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'string' && v.trim()) return repairAnimationAssetUrl(entry, v.trim(), origin);
    }
    return '';
  };

  // Only offer a format when at least one animation actually carries that file,
  // so the control never sends the user to an empty download.
  const availableFormats = DOWNLOAD_FORMATS.filter((format) =>
    animations.some((name) => pick(name, downloadKeysFor(format.id, '')) || pick(name, downloadKeysFor(format.id, 'Medium')) || pick(name, downloadKeysFor(format.id, 'Low'))));

  if (!availableFormats.length) return '';

  const formatButtons = availableFormats
    .map((format) => `<button type="button" class="dl-chip" data-dl-format="${escapeHtml(format.id)}" aria-pressed="false">${escapeHtml(format.label)}<span>${escapeHtml(format.note)}</span></button>`)
    .join('');

  // Prefer a real measured width from any animation; they all come from the same
  // skeleton, so one sample describes the whole ladder.
  const widths = {};
  for (const name of animations) {
    const group = previews[name] && previews[name].qualityWidths;
    if (!group || typeof group !== 'object') continue;
    for (const quality of DOWNLOAD_QUALITIES) {
      const value = Number(group[quality.id]);
      if (Number.isFinite(value) && value > 0 && !widths[quality.id]) widths[quality.id] = value;
    }
  }
  const qualityButtons = DOWNLOAD_QUALITIES
    .map((quality) => {
      const width = widths[quality.id] || 0;
      const label = width ? `${width}px` : quality.label;
      return `<button type="button" class="dl-chip dl-chip--sm" data-dl-quality="${escapeHtml(quality.id)}" aria-pressed="false">${escapeHtml(label)}</button>`;
    })
    .join('');

  // Per-animation rows are rendered from JS once a format+size is chosen, but
  // the shell is server-rendered so the block is complete without JavaScript.
  const animationNames = animations
    .map((name) => `<li class="dl-row" data-dl-animation="${escapeHtml(name)}"><span class="dl-row-name">${escapeHtml(name)}</span><span class="dl-row-links"></span></li>`)
    .join('');

  return `<section class="animation-download-block" id="animation-download-block" data-dl-block aria-label="Download animations">
    <div class="dl-head">
      <div class="dl-head-title">Download</div>
      <div class="dl-steps" role="tablist" aria-label="Download steps">
        <button type="button" class="dl-step is-active" data-dl-goto="format" role="tab" aria-selected="true"><b>1</b><span class="sr-only">Format</span></button>
        <button type="button" class="dl-step" data-dl-goto="size" role="tab" aria-selected="false"><b>2</b><span class="sr-only">Size</span></button>
        <button type="button" class="dl-step" data-dl-goto="files" role="tab" aria-selected="false"><b>3</b><span class="sr-only">Files</span></button>
      </div>
    </div>
    <div class="dl-viewport">
      <div class="dl-track">
        <div class="dl-panel" data-dl-panel="format">
          <div class="dl-grid">${formatButtons}</div>
        </div>
        <div class="dl-panel" data-dl-panel="size">
          <div class="dl-grid dl-grid--sm">${qualityButtons}</div>
        </div>
        <div class="dl-panel" data-dl-panel="files">
          <div class="dl-scope">
            <button type="button" class="dl-chip dl-chip--wide" data-dl-scope="all">All animations · one click</button>
            <span class="dl-scope-or">or</span>
            <button type="button" class="dl-chip dl-chip--wide" data-dl-scope="one">Pick one by one</button>
          </div>
          <ul class="dl-list" data-dl-list hidden>${animationNames}</ul>
        </div>
      </div>
    </div>
    <div class="dl-status" data-dl-status aria-live="polite">${animationDownloadIcon()} <span class="sr-only" data-dl-status-text>Pick a format to start</span></div>
    <script type="application/json" data-dl-config>${escapedJson({
      origin,
      animations,
      widths,
      files: animations.reduce((acc, name) => {
        acc[name] = {};
        for (const format of DOWNLOAD_FORMATS) {
          for (const quality of DOWNLOAD_QUALITIES) {
            const url = pick(name, downloadKeysFor(format.id, quality.suffix));
            if (url) acc[name][`${format.id}-${quality.id}`] = url;
          }
        }
        return acc;
      }, {}),
    })}</script>
  </section>`;
}

function createHtml(config) {
  const video = config.video || null;
  const origin = config.origin || 'https://spine-link.vercel.app';
  const entryMetricId = String(config.entryId || 'spine-preview');
  const metric = metricCountsForId(config.metrics, entryMetricId);
  const entry = config.entry || {};
  const clientConfig = {
    ...config,
    metrics: {
      entries: {
        [entryMetricId]: metric,
      },
    },
  };
  const videoPreviewRatio =
    video?.width && video?.height && Number(video.width) > 0 && Number(video.height) > 0
      ? `${Math.round(Number(video.width))} / ${Math.round(Number(video.height))}`
      : '16 / 9';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${seoHead({
      origin,
      entryId: config.entryId,
      video,
      fallbackTitle: 'Spine-Link interactive Spine animation preview',
      robots: config.robots,
      playerUrl: config.playerUrl,
      archiveUrl: config.archiveUrl,
    })}
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/page-transitions.css" />
    <link rel="stylesheet" id="spine-player-stylesheet" href="https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/spine-player.css" />
    <script src="/page-transitions.js" defer></script>
    <script src="/spine-embers.js?v=2026-09-30" defer></script>
    <style>
      * { box-sizing: border-box; }
      * { scrollbar-width: thin; scrollbar-color: rgba(74,78,84,.72) transparent; }
      *::-webkit-scrollbar { width: 8px; height: 8px; }
      *::-webkit-scrollbar-track { background: transparent; }
      *::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: rgba(74,78,84,.72); background-clip: content-box; }
      *::-webkit-scrollbar-thumb:hover { background: rgba(100,106,115,.78); background-clip: content-box; }
      html, body, #app { width: 100%; min-height: 100%; margin: 0; }
      body { overflow: auto; background: #000; color: #e7edf4; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      #app { position: relative; z-index: 1; display: flex; flex-direction: column; min-height: 100vh; max-height: 100vh; overflow: hidden; padding: 14px 18px 10px; background: rgba(0,0,0,.78); }
      html, body { height: 100%; overflow: hidden; }
      .topbar { display: flex; justify-content: space-between; gap: 18px; align-items: center; flex: 0 0 auto; }
      .brand-link { display: inline-block; color: inherit; text-decoration: none; }
      .brand-logo { display: inline-flex; align-items: center; gap: 5px; color: #fff; font-family: "Trebuchet MS", Inter, ui-sans-serif, system-ui, sans-serif; font-size: clamp(34px, 4.4vw, 58px); font-weight: 500; line-height: .78; letter-spacing: .1em; text-shadow: 0 0 1px rgba(255,255,255,.86), 0 6px 18px rgba(0,0,0,.42); }
      .brand-spine-mark { display: inline-grid; gap: 4px; width: 16px; margin: 0 -3px 0 -5px; transform: translateY(1px); }
      .brand-spine-mark i { display: block; width: 16px; height: 7px; border-radius: 999px; background: #ff5a1f; box-shadow: 0 0 8px rgba(255,90,31,.22); }
      .brand-spine-mark i:nth-child(1) { transform: translateX(-1px); }
      .brand-spine-mark i:nth-child(2) { width: 14px; transform: translateX(2px); }
      .brand-spine-mark i:nth-child(3) { width: 12px; transform: translateX(4px); }
      .brand-spine-mark i:nth-child(4) { width: 10px; transform: translateX(6px); }
      .brand-spine-mark i:nth-child(5) { width: 8px; transform: translateX(8px); }
      .brand-plus { margin-left: 10px; color: #ff6a28; font-size: .72em; font-weight: 800; letter-spacing: .22em; line-height: 1; text-transform: uppercase; }
      .brand-link:hover .brand-plus { color: #8cc7ff; }
      /* Плеер — почти на весь экран; панель справа уходит вниз и растягивается
         по ширине, вместо того чтобы растягивать страницу вниз и создавать скрол. */
      /* Desktop layout: the Spine player takes the full window height and stays
         adaptive, while the side panel on its right never exceeds 420px. */
      .stage { display: grid; grid-template-columns: minmax(0, 1fr) clamp(300px, 28vw, 420px); gap: 16px; min-height: 0; height: calc(100vh - 104px); max-height: calc(100vh - 104px); }
      .player-frame { position: relative; min-width: 0; min-height: 0; }
      #player { width: 100%; height: 100%; min-height: 0; }
      .video-watch-panel { position: relative; display: grid; gap: 10px; overflow: hidden; padding: 16px; border: 1px solid rgba(255,185,214,.46); border-radius: 8px; background: #020304; box-shadow: 0 20px 64px rgba(0,0,0,.34); }
      .video-watch-panel--bottom { margin-top: 4px; }
      .seo-video-frame { display: flex; align-items: center; justify-content: center; width: 100%; height: min(70vh, 820px); min-height: 220px; max-height: min(70vh, 820px); overflow: hidden; border: 1px solid rgba(140,199,255,.22); border-radius: 8px; background: #000; }
      .video-watch-player, .seo-video-preview { display: block; width: auto; height: auto; max-width: 100%; max-height: 100%; aspect-ratio: var(--video-preview-ratio, 16 / 9); object-fit: contain; background: #000; }
      .video-watch-copy { display: grid; gap: 5px; pointer-events: none; }
      .video-watch-copy h1 { margin: 0; color: #fff; font-size: clamp(24px, 3.4vw, 44px); line-height: 1; letter-spacing: 0; text-shadow: 0 4px 18px rgba(0,0,0,.76); }
      .video-watch-copy p { max-width: 780px; margin: 0; color: rgba(237,245,255,.78); font-size: 14px; line-height: 1.35; }
      /* Сцена под анимацию тёмная: мягкое свечение и полупрозрачные частицы на
         средне-серой шахматке почти не читались — больше половины видимых пикселей
         не набирали контраста с фоном. Узор оставлен тёмным, чтобы прозрачные
         области всё так же читались, но не съедали контраст анимации. */
      #player { width: 100%; height: 100%; min-height: 0; touch-action: none; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; overflow: hidden; background: conic-gradient(#1c1f24 25%, #141619 0 50%, #1c1f24 0 75%, #141619 0); background-size: var(--preview-pattern-size, 140px) var(--preview-pattern-size, 140px); }
      .library-nav-button { position: absolute; top: 50%; z-index: 8; display: grid; place-items: center; width: 52px; min-height: 78px; padding: 0; border: 1px solid rgba(140,199,255,.55); border-radius: 8px; color: #f7fbff; background: rgba(9,13,17,.68); box-shadow: 0 16px 34px rgba(0,0,0,.38), inset 0 0 22px rgba(140,199,255,.08); font-size: 42px; font-weight: 800; line-height: 1; transform: translateY(-50%); backdrop-filter: blur(10px); }
      .library-nav-button:hover { border-color: rgba(179,255,64,.78); background: rgba(23,31,18,.78); }
      .library-nav-button:disabled { display: none; }
      .library-nav-button--prev { left: 14px; }
      .library-nav-button--next { right: 14px; }
      #sidebar { min-height: 0; max-height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; scrollbar-width: thin; scrollbar-color: rgba(74,78,84,.72) transparent; }
      /* Supporting panels follow the animation picker at every desktop width. */
      #sidebar > #animation-card { order: 1; }
      #sidebar > .animation-download-block { order: 2; }
      #sidebar > .video-watch-panel--below-list { order: 3; }
      #sidebar > .proof-card { order: 4; }
      #sidebar > #owner-library { order: 5; }
      #sidebar > #set-card, #sidebar > .note-card { order: 6; }
      .animation-card.is-open .animation-menu { max-height: 240px; }

      /* Большое видео-превью остаётся на странице: это главная видео-поверхность
         работы и единственное место, где показывается клип в полном качестве.
         Оно живёт под плеером и не мешает сайдпанелу. */
      .video-watch-panel { display: grid; }
      .video-watch-panel .seo-video-frame { height: min(58vh, 720px); max-height: min(58vh, 720px); }
      .preview-card { padding: 16px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(255,255,255,.05); box-shadow: 0 18px 40px rgba(0,0,0,.18); }
      .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .topbar .preview-top-row {
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: 10px;
        min-width: 0;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
      }
      .topbar .preview-top-row .preview-card { min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
      .topbar .preview-top-row .owner-card { display: none; }
      .topbar .preview-top-row .owner-card.is-visible { display: flex; flex: 1 1 auto; min-width: 0; }
      .topbar .preview-top-row .like-card { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; height: auto; min-height: 0; }
      .topbar .preview-top-row .section-title { display: none; }
      /* The like is the rightmost control and reads as a round badge. */
      .topbar .preview-like-button { order: 1; width: clamp(38px, 10vw, 44px); height: clamp(38px, 10vw, 44px); min-height: 0; aspect-ratio: 1; padding: 0; gap: 4px; flex-direction: row; align-items: center; justify-content: center; border-color: rgba(255,118,171,.76); border-radius: 50%; color: #ff8dbc; background: rgba(74,18,39,.5); box-shadow: none; font-size: 15px; white-space: nowrap; }
      .preview-like-button strong { color: currentColor; font-size: 14px; font-weight: 950; line-height: 1; white-space: nowrap; }
      .preview-like-button.is-liked { border-color: rgba(255,118,171,.78); color: #ff76ab; background: rgba(255,118,171,.14); }
      .preview-view-count { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 34px; margin-top: 8px; color: rgba(231,237,244,.78); font-size: 13px; font-weight: 850; }
      .preview-view-count strong { color: #fff; }
      .proof-card { display: ${video?.sourceProofUrl || video?.blockchainAnchorUrl ? 'block' : 'none'}; }
      .proof-card > summary { display: flex; align-items: center; gap: 9px; margin: 0; color: #f7fbff; font-size: 13px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; list-style: none; }
      .proof-card > summary::-webkit-details-marker { display: none; }
      .proof-card > summary::before { flex: 0 0 auto; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 7px solid #8cc7ff; content: ''; transition: transform .16s ease; }
      .proof-card[open] > summary::before { transform: rotate(90deg); }
      .proof-card > summary:hover { color: #fff; }
      .proof-links { display: grid; gap: 10px; margin-top: 10px; }
      /* A nested display (grid/flex) beats the native <details> hiding, so the
         collapsed state has to be stated explicitly or the links stay visible. */
      .proof-card:not([open]) > .proof-links { display: none; }
      .proof-card a { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 38px; padding: 0 10px; border: 1px solid rgba(140,199,255,.2); border-radius: 8px; color: #dff1ff; background: rgba(140,199,255,.08); font-size: 12px; font-weight: 850; text-decoration: none; }
      .proof-card a:hover { border-color: rgba(179,255,64,.58); color: #fff; }
      .proof-card code { overflow: hidden; max-width: 132px; color: rgba(237,245,255,.68); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
      select, button { width: 100%; }
      select { min-height: 48px; padding: 0 12px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: #e7edf4; background: #1a2027; }
      button { min-height: 38px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: rgba(231,237,244,.86); background: rgba(255,255,255,.045); cursor: pointer; }
      button.active, button:hover { border-color: rgba(140,199,255,.82); color: #fff; background: rgba(71,156,255,.22); }
      .animation-card { position: relative; }
      .animation-card.is-open .animation-menu { display: grid; gap: 6px; max-height: 320px; overflow: auto; margin-top: 0; padding: 8px; border: 1px solid rgba(140,199,255,.34); border-radius: 10px; background: rgba(9,13,17,.94); box-shadow: 0 22px 50px rgba(0,0,0,.52); backdrop-filter: blur(12px); }
      /* ── Compact download picker ──────────────────────────────────────────
         Three short steps that slide sideways instead of a long button list:
         Format → Size → Files. Everything stays inside the side panel width. */
      .animation-download-block { padding: 12px; border: 1px solid rgba(140,199,255,.22); border-radius: 10px; background: rgba(140,199,255,.05); box-shadow: 0 18px 40px rgba(0,0,0,.2); }
      .dl-head { display: grid; gap: 9px; }
      .dl-head-title { color: #f7fbff; font-size: 13px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
      .dl-steps { display: none; grid-template-columns: repeat(3, 1fr); gap: 4px; }
      .animation-download-block.has-format .dl-steps { display: grid; }
      .dl-step { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 0 6px; border: 1px solid rgba(255,255,255,.1); border-radius: 999px; color: rgba(231,237,244,.72); background: rgba(255,255,255,.04); font-size: 11px; font-weight: 850; cursor: pointer; transition: color .18s ease, background .18s ease, border-color .18s ease; }
      .dl-step b { display: grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; color: #0b0e12; background: rgba(231,237,244,.72); font-size: 9px; font-weight: 900; }
      .dl-step.is-active { border-color: rgba(140,199,255,.82); color: #fff; background: rgba(71,156,255,.2); }
      .dl-step.is-active b { background: #8cc7ff; }
      .dl-step.is-done b { background: #b3ff40; }
      .dl-viewport { margin-top: 10px; overflow: hidden; }
      .dl-track { display: flex; width: 300%; transition: transform .34s cubic-bezier(.22,.75,.3,1); }
      .dl-track[data-dl-step="format"] { transform: translateX(0); }
      .dl-track[data-dl-step="size"]   { transform: translateX(-33.3333%); }
      .dl-track[data-dl-step="files"]  { transform: translateX(-66.6666%); }
      .dl-panel { width: 33.3333%; flex: 0 0 33.3333%; min-width: 0; padding-right: 8px; }
      .dl-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
      .dl-grid--sm { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .dl-chip { display: grid; gap: 2px; min-height: 46px; padding: 7px 8px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: rgba(231,237,244,.86); background: rgba(255,255,255,.045); font-size: 12px; font-weight: 900; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, color .16s ease, transform .12s ease; }
      .dl-chip span { color: rgba(231,237,244,.5); font-size: 9px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
      .dl-chip:hover { border-color: rgba(140,199,255,.78); color: #fff; transform: translateY(-1px); }
      .dl-chip.is-picked { border-color: rgba(179,255,64,.82); color: #eaffc2; background: rgba(179,255,64,.12); }
      .dl-chip--sm { display: grid; place-items: center; min-height: 40px; padding: 0 4px; font-size: 12px; text-align: center; }
      .dl-chip--wide { grid-column: 1 / -1; }
      .dl-scope { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 6px; }
      .dl-scope-or { color: rgba(231,237,244,.44); font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
      .dl-list { display: grid; gap: 5px; margin: 8px 0 0; padding: 0; list-style: none; max-height: 168px; overflow: auto; }
      .dl-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 7px; border: 1px solid rgba(255,255,255,.07); border-radius: 7px; background: rgba(255,255,255,.03); }
      .dl-row-name { overflow: hidden; color: rgba(231,237,244,.86); font-size: 11px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
      .dl-row-links { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
      .dl-mini { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; padding: 0 7px; border: 1px solid rgba(140,199,255,.28); border-radius: 999px; color: #dff1ff; background: rgba(140,199,255,.1); font-size: 10px; font-weight: 900; text-decoration: none; }
      .dl-mini:hover { border-color: rgba(179,255,64,.7); color: #eaffc2; background: rgba(179,255,64,.14); }
      .dl-status { display: flex; align-items: center; gap: 7px; margin-top: 9px; min-height: 30px; padding: 0 9px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; color: rgba(231,237,244,.78); background: rgba(255,255,255,.03); font-size: 11px; font-weight: 800; }
      .dl-status span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dl-back { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; margin-top: 8px; padding: 0 9px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; color: rgba(231,237,244,.78); background: rgba(255,255,255,.05); font-size: 10px; font-weight: 900; cursor: pointer; }
      .dl-back:hover { border-color: rgba(140,199,255,.78); color: #fff; }
      @media (prefers-reduced-motion: reduce) { .dl-track { transition: none; } }

      .note-text { margin: 0; color: rgba(231,237,244,.88); font-size: 16px; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
      .note-card:empty { display: none; }
      .owner-card { display: none; gap: 12px; }
      .owner-card.is-visible { display: grid; }
      .preview-top-row .preview-card { min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
      .preview-top-row .section-title, .preview-top-row .like-card .section-title { display: none; }
      .preview-top-row .owner-card { display: none; }
      .preview-top-row .owner-card.is-visible { display: flex; flex: 1 1 auto; min-width: 0; }

      .preview-top-row .owner-profile { flex: 1 1 auto; gap: 8px; min-width: 0; overflow: hidden; }
      .preview-top-row .owner-avatar { flex: 0 0 30px; width: 30px; height: 30px; }
      .preview-top-row .owner-profile-text { flex: 1 1 auto; flex-wrap: nowrap; gap: 8px; overflow: hidden; }
      .preview-top-row .owner-profile strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; }
      .preview-top-row .owner-profile span { overflow: hidden; min-width: 0; font-size: 10px; text-overflow: ellipsis; }
      .preview-top-row .preview-view-count { order: 2; flex: 0 0 auto; width: auto; min-height: 0; margin: 0; gap: 6px; font-size: 12px; white-space: nowrap; }
      .preview-top-row .preview-view-count span:last-child { display: none; }
      .preview-top-row .like-card .preview-like-button { order: 1; flex: 0 0 auto; width: 38px; height: 38px; aspect-ratio: 1; padding: 0; gap: 0; border-radius: 50%; }
      .owner-profile { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .owner-avatar {
        width: 46px;
        height: 46px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 50%;
        object-fit: cover;
        background: rgba(255,255,255,.08);
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        overflow: hidden;
      }
      .owner-avatar-fallback { display: grid; place-items: center; color: #111; font-weight: 900; background: #b3ff40; }
      .owner-profile-text { display: flex; flex: 1 1 auto; align-items: baseline; gap: 40px; min-width: 0; max-width: 100%; flex-wrap: wrap; }
      .owner-profile strong, .owner-profile span { white-space: nowrap; }
      .owner-profile strong { flex: 0 1 auto; min-width: 0; color: #fff; font-size: 16px; overflow-wrap: anywhere; }
      .owner-profile span { flex: 0 0 auto; color: rgba(231,237,244,.62); font-size: 12px; }
      .owner-library { display: none; gap: 10px; }
      /* auto-fill keeps the columns at their intended width; auto-fit let a
         short list stretch one card across the whole panel. The fixed height
         keeps every thumbnail a readable rectangle instead of a collapsed sliver. */
      .owner-library.is-visible { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); grid-auto-rows: 108px; align-items: stretch; align-content: start; }
      .owner-library a { position: relative; display: block; overflow: hidden; height: 108px; min-height: 108px; border: 1px solid rgba(255,255,255,.09); border-radius: 8px; color: inherit; text-decoration: none; background: rgba(255,255,255,.045); isolation: isolate; }
      .owner-library a::after { content: ""; position: absolute; inset: 0; z-index: 1; background: linear-gradient(rgba(0,0,0,.18), rgba(0,0,0,.18) 45%, rgba(8,10,12,.82)); pointer-events: none; }
      .owner-library a:hover { border-color: rgba(179,255,64,.55); background: rgba(179,255,64,.08); transform: translateY(-2px); }
      .owner-thumb { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; border-radius: 0; object-fit: cover; background: rgba(255,255,255,.08); transform: scale(1.05); transform-origin: center; }
      .owner-library a > div { position: absolute; right: 10px; bottom: 10px; left: 10px; z-index: 2; display: grid; gap: 3px; min-width: 0; }
      .owner-library strong, .owner-library span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .owner-library strong { color: #fff; font-size: 13px; text-shadow: 0 2px 12px rgba(0,0,0,.75); }
      .owner-library span { color: rgba(231,237,244,.7); font-size: 11px; }
      @media (max-width: 1000px) {
        * { scrollbar-width: none; }
        *::-webkit-scrollbar { width: 0; height: 0; display: none; }
        html, body, #app { min-height: 100%; }
        body { background: #030404; }
        #app { display: flex; flex-direction: column; gap: 10px; min-height: 100%; padding: 12px 16px 8px; background: #030404; }
        .topbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; overflow: hidden; }
        .brand-link { min-width: 0; overflow: hidden; }
        .brand-logo { max-width: 100%; gap: 3px; font-size: clamp(24px, 5.6vw, 30px); letter-spacing: .1em; }
        .brand-spine-mark { gap: 3px; width: 11px; margin: 0 -3px 0 -5px; transform: translateY(0); }
        .brand-spine-mark i { width: 11px; height: 5px; }
        .brand-spine-mark i:nth-child(2) { width: 10px; }
        .brand-spine-mark i:nth-child(3) { width: 9px; }
        .brand-spine-mark i:nth-child(4) { width: 8px; }
        .brand-spine-mark i:nth-child(5) { width: 7px; }
        .brand-plus { margin-left: 7px; font-size: .64em; letter-spacing: .17em; }
        .stage { display: contents; }
        #sidebar { display: contents; }
        .player-frame { order: 2; height: auto; min-height: 0; }
        .topbar { gap: 10px; }
        .topbar .preview-top-row { gap: 8px; margin: 0; overflow: hidden; }
        .preview-card { padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
        .preview-top-row .section-title, .like-card .section-title { display: none; }
        .owner-card.is-visible { display: block; min-width: 0; }
        .preview-top-row .owner-profile { gap: clamp(8px, 1.7vw, 12px); min-width: 0; }
        .preview-top-row .owner-avatar { flex: 0 0 clamp(34px, 5.6vw, 46px); width: clamp(34px, 5.6vw, 46px); height: clamp(34px, 5.6vw, 46px); aspect-ratio: 1 / 1; border: 0; border-radius: 50%; }
        .owner-profile-text { display: grid; gap: 3px; min-width: 0; }
        .preview-top-row .owner-profile strong { overflow: hidden; min-width: 0; color: #fff; font-size: clamp(19px, 4.4vw, 28px); font-weight: 950; line-height: 1.05; text-overflow: ellipsis; }
        .preview-top-row .owner-profile span { overflow: hidden; min-width: 0; color: rgba(231,237,244,.48); font-size: clamp(12px, 2.8vw, 17px); font-weight: 850; letter-spacing: .14em; line-height: 1; text-transform: uppercase; text-overflow: ellipsis; }
        .preview-top-row .like-card { display: contents; }
        .preview-view-count { order: 2; display: inline-flex; width: auto; min-width: 0; min-height: 44px; margin: 0; gap: clamp(6px, 1.2vw, 9px); color: rgba(231,237,244,.84); font-size: clamp(20px, 4.5vw, 28px); font-weight: 950; white-space: nowrap; }
        .preview-view-count span:last-child { display: none; }
        .preview-view-count span:first-child { position: relative; flex: 0 0 clamp(18px, 3.2vw, 24px); width: clamp(18px, 3.2vw, 24px); height: clamp(12px, 2.2vw, 16px); overflow: hidden; border: 2px solid currentColor; border-radius: 50% / 62%; color: rgba(231,237,244,.76); font-size: 0; }
        .preview-view-count span:first-child::after { content: ""; position: absolute; top: 50%; left: 50%; width: 34%; aspect-ratio: 1 / 1; border-radius: 50%; background: currentColor; transform: translate(-50%, -50%); }
        .preview-view-count strong { font-size: clamp(16px, 3.4vw, 22px); }
        .topbar .preview-like-button { order: 1; width: clamp(38px, 10vw, 44px); height: clamp(38px, 10vw, 44px); min-height: 0; aspect-ratio: 1; padding: 0; gap: 4px; flex-direction: row; align-items: center; justify-content: center; border-color: rgba(255,118,171,.76); border-radius: 50%; color: #ff8dbc; background: rgba(74,18,39,.5); box-shadow: none; font-size: 15px; white-space: nowrap; }        .preview-like-button span { font-size: clamp(18px, 3.4vw, 24px); }
        .preview-like-button strong { font-size: clamp(15px, 3vw, 20px); }
        #player { width: 100%; height: calc(100dvh - 236px); min-height: 300px; max-height: 760px; border-color: rgba(255,255,255,.18); border-radius: 12px; background-size: 132px 132px; }
        .spine-player-controls { min-height: 74px; }
        .library-nav-button { display: none; }
        .animation-card { order: 3; margin: 10px 16px 0; }
        .animation-card .section-title { display: none; }
        .animation-card { padding: 0; }
        .animation-menu { position: static; max-height: 46vh; margin-top: 0; padding: 5px; gap: 4px; }
        #animation-menu button { min-height: 40px; }
        .animation-menu button { min-height: 40px; border-color: rgba(140,199,255,.78); border-radius: 8px; color: #f1f7ff; background: rgba(31,58,91,.72); font-size: 14px; font-weight: 850; }
        #set-card, .note-card, .proof-card, .owner-library { order: 4; margin-inline: 32px; }
        .video-watch-panel { display: none; }
        .seo-video-frame { max-height: min(62vh, 520px); }
      }
      @media (max-width: 560px) {
        #app { padding: 10px 12px 8px; }
        .topbar { grid-template-columns: minmax(0, 1fr) auto; justify-items: stretch; }
        .brand-logo { gap: 2px; font-size: clamp(21px, 6.2vw, 28px); letter-spacing: .06em; }
        .preview-top-row { margin: 2px 0 10px; }
        .preview-like-button { width: 60px; height: 60px; }
      }
      .spine-link-loop-button { position: relative; margin-right: 12px !important; }
      /* Панель управления свёрнута и выезжает по нажатию на ручку. */
      .spine-player-controls { z-index: 4; }
      .spine-player-controls.spine-player-controls-hidden { pointer-events: auto; opacity: 1; }
        overflow: hidden;
        max-height: 0;
        min-height: 0 !important;
        opacity: 0;
        transform: translateY(100%);
        transition: max-height 260ms ease, opacity 200ms ease, transform 260ms ease, padding 260ms ease;
        padding-top: 0;
        padding-bottom: 0;
      }
        max-height: 190px;
        opacity: 1;
        transform: translateY(0);
        padding-top: 8px;
        padding-bottom: 8px;
      }
        position: absolute;
        right: 14px;
        bottom: 12px;
        z-index: 6;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-width: 42px;
        min-height: 42px;
        padding: 0 12px;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 999px;
        color: #e9f2ff;
        background: rgba(8,11,16,.72);
        box-shadow: 0 10px 26px rgba(0,0,0,.34);
        backdrop-filter: blur(8px);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 850;
      }
        display: inline-block;
        font-size: 11px;
        line-height: 1;
        transform: translateY(1px);
        transition: transform 260ms ease;
      }
      .spine-link-loop-button::before, .spine-link-loop-button::after { position: absolute; inset: 0; display: grid; place-items: center; font-size: 30px; font-weight: 900; line-height: 1; }
      .spine-link-loop-button.is-on::before { content: "↻"; color: #54cfff; text-shadow: 0 0 14px rgba(84, 207, 255, 0.72); transform: translateY(-1px); }
      .spine-link-loop-button.is-off::before { content: "↻"; color: rgba(210, 216, 222, 0.42); transform: translateY(-1px); }
      .spine-link-loop-button.is-off::after { content: none; }
    
      /* Responsive /p pages: let the document scroll, never the sidebar. */
      .sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
      html, body { height: auto !important; min-height: 100%; overflow-x: hidden !important; overflow-y: auto !important; }
      #app { height: auto !important; min-height: 100svh; max-height: none !important; overflow: visible !important; }
      .stage { height: auto !important; max-height: none !important; min-height: calc(100svh - 104px); align-items: start; }
      #sidebar { height: auto !important; max-height: none !important; overflow: visible !important; padding-right: 0; }
      .player-frame { align-self: start; position: sticky; top: 12px; height: calc(100svh - 120px); min-height: 420px; }
      /* Document scroll remains enabled; the desktop animation menu scrolls independently. */
      .dl-steps .dl-step span, .dl-status [data-dl-status-text] { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
      .dl-status { display: none !important; }
      #sidebar > #animation-card { order: 1 !important; }
      #sidebar > .animation-download-block { order: 2 !important; }
      #sidebar > .video-watch-panel--below-list { order: 3 !important; }
      #sidebar > .proof-card { order: 4 !important; }
      #sidebar > #owner-library { order: 5 !important; }
      #sidebar > #set-card, #sidebar > .note-card { order: 6 !important; }
      .video-watch-panel--below-list { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(255,185,214,.28); border-radius: 8px; background: #020304; }
      .video-watch-panel--below-list video { display: block; width: 100%; max-height: 56svh; object-fit: contain; background: #000; }
      .owner-library.is-visible { grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: 96px; }
      .owner-library a { height: 96px; min-height: 96px; }
      .owner-library-more { display: grid !important; place-items: end start; padding: 10px; color: #fff; background: linear-gradient(135deg, rgba(255,106,40,.9), rgba(26,31,38,.96)); font-size: 12px; font-weight: 900; text-decoration: none; }
      @media (max-width: 1000px) {
        html, body { height: auto !important; min-height: 100%; overflow-x: hidden !important; overflow-y: auto !important; }
        #app { display: flex; flex-direction: column; height: auto !important; min-height: 100svh; max-height: none !important; overflow: visible !important; padding: 10px 12px 24px; }
        .stage { display: flex !important; flex-direction: column; gap: 14px; height: auto !important; max-height: none !important; min-height: 0; }
        .player-frame { position: relative !important; top: auto !important; order: 1 !important; width: 100%; height: 90svh !important; min-height: 90svh !important; max-height: none !important; flex: 0 0 auto; }
        #player { width: 100%; height: 100% !important; min-height: 90svh !important; max-height: none !important; }
        #sidebar { display: flex !important; flex-direction: column; order: 2 !important; width: 100%; max-height: none !important; height: auto !important; overflow: visible !important; gap: 12px; margin: 0; padding: 0; }
        #sidebar > #animation-card { order: 1 !important; margin: 0; }
        #sidebar > .animation-download-block { order: 2 !important; margin: 0; }
        #sidebar > .video-watch-panel--below-list { order: 3 !important; margin: 0; }
        #sidebar > .proof-card { order: 4 !important; margin: 0; }
        #sidebar > #owner-library { order: 5 !important; margin: 0; }
        #sidebar > #set-card, #sidebar > .note-card { order: 6 !important; margin: 0; }
        .animation-menu, .animation-card.is-open .animation-menu { max-height: none !important; height: auto !important; overflow: visible !important; }
        .animation-menu button, #animation-menu button { min-height: 40px; }
        .video-watch-panel--below-list video { max-height: 60svh; }
        .owner-library.is-visible { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 100px; }
        .owner-library a { height: 100px; min-height: 100px; }
      }
      /* The animation picker grows with its content but scrolls before exceeding
         the player. Following sidebar cards remain in normal document flow. */
      @media (min-width: 1001px) {
        #animation-card.is-open #animation-menu {
          height: auto !important;
          max-height: var(--animation-menu-player-height, max(420px, calc(100svh - 120px))) !important;
          overflow-x: hidden !important;
          overflow-y: auto !important;
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
        #sidebar > #animation-card { flex: 0 0 auto; }
      }
</style>
  </head>
      <body>
    <div id="app">
      <header class="topbar">
        <a class="brand-link" href="/" aria-label="Spine-Link home"><span class="brand-logo" aria-hidden="true"><span>s</span><span>p</span><span class="brand-spine-mark"><i></i><i></i><i></i><i></i><i></i></span><span>n</span><span>e</span><span class="brand-plus">link</span></span></a>
        <div class="preview-top-row">
          <div class="preview-card owner-card" id="owner-card"><div id="owner-profile"></div></div>
          <div class="preview-card like-card" data-metric-id="${escapeHtml(entryMetricId)}" data-metric-label="stats" aria-label="${metric.likes} likes and ${metric.views} views"><div class="preview-view-count" data-metric-id="${escapeHtml(entryMetricId)}"><span aria-hidden="true">◉</span><strong data-metric-views>${metric.views}</strong><span>views</span></div><button class="preview-like-button" id="preview-like-button" type="button" data-metric-id="${escapeHtml(entryMetricId)}" data-metric-like data-metric-current-likes="${metric.likes}" data-metric-current-views="${metric.views}" aria-pressed="false" aria-label="Like"><span data-metric-like-icon aria-hidden="true">♡</span><strong data-metric-likes>${metric.likes}</strong></button></div>
        </div>
      </header>
      <div class="stage">
        <div class="player-frame">
          <button class="library-nav-button library-nav-button--prev" id="library-nav-prev" type="button" aria-label="Previous Spine work" title="Previous Spine work">&lsaquo;</button>
          <div id="player"></div>
          ${video?.contentUrl ? `<video id="preview-loading-video" class="preview-fallback-video" src="${escapeHtml(video.contentUrl)}" poster="${escapeHtml(video?.thumbnailUrl || '')}" muted loop playsinline preload="none" hidden data-animation="${escapeHtml(video.previewAnimation || '')}" aria-label="${escapeHtml(video.name || 'Spine animation video preview')}"></video>` : ''}
          <button class="library-nav-button library-nav-button--next" id="library-nav-next" type="button" aria-label="Next Spine work" title="Next Spine work">&rsaquo;</button>
        </div>
        <aside id="sidebar">
          <div class="preview-card" id="set-card"><div class="section-title">Set</div><select id="set-select"></select></div>
          <div class="preview-card note-card" id="note-card"><div class="section-title">Text</div><p class="note-text" id="note-text"></p></div>
          ${video?.contentUrl ? `<div class="preview-card preview-video-card"><div class="section-title">Video preview</div><video id="preview-video-card-player" src="${escapeHtml(video.contentUrl)}" poster="${escapeHtml(video?.thumbnailUrl || '')}" muted loop playsinline preload="metadata" autoplay controls aria-label="${escapeHtml(video.name || 'Spine animation video preview')}"></video></div>` : ''}
          <div class="preview-card animation-card is-open" id="animation-card"><div class="section-title">Animations</div><div class="animation-menu" id="animation-menu" role="menu"></div></div>
          ${animationDownloadBlock(entry, origin)}
          
          ${video?.sourceProofUrl || video?.blockchainAnchorUrl ? "<details class=\"preview-card proof-card\"><summary class=\"section-title\">Origin proof</summary><div class=\"proof-links\">" + (video.sourceProofUrl ? "<a href=\"".concat(escapeHtml(video.sourceProofUrl)).concat("\" target=\"_blank\" rel=\"noreferrer\">source-proof.json").concat(video.proofHash ? "<code>".concat(escapeHtml(shortHash(video.proofHash))).concat("</code>") : "").concat("</a>") : "").concat(video.blockchainAnchorUrl ? "<a href=\"".concat(escapeHtml(video.blockchainAnchorUrl)).concat("\" target=\"_blank\" rel=\"noreferrer\">blockchain-anchor.json").concat(video.anchorHash ? "<code>".concat(escapeHtml(shortHash(video.anchorHash))).concat("</code>") : "").concat("</a>") : "").concat("</div></details>") : ""}
          <div class="preview-card owner-library" id="owner-library"></div>
        </aside>
      </div>
      
    </div>
    <script type="application/json" id="spine-preview-config">${escapedJson(clientConfig)}</script>
    <script>
      // Keep the preview static on load; the Spine player is already the active animated surface.
      if (window.spine?.GLTexture) {
        window.spine.GLTexture.DISABLE_UNPACK_PREMULTIPLIED_ALPHA_WEBGL = true;
      }
      const config = JSON.parse(document.getElementById("spine-preview-config").textContent);
      const sets = config.sets || [];
      function queryValue(name) { return new URLSearchParams(window.location.search).get(name) || ""; }
      function setHasAnimation(set, animationName) { return Boolean(set && animationName && (set.animations || []).includes(animationName)); }
      function initialSet() {
        const querySet = queryValue("set");
        const queryAnimation = queryValue("animation");
        if (querySet) return sets.find((set) => set.label === querySet) || null;
        return sets.find((set) => setHasAnimation(set, queryAnimation)) || sets.find((set) => set.label === config.activeLabel) || sets[0] || null;
      }
      function initialAnimation(set) {
        const queryAnimation = queryValue("animation");
        return queryAnimation || set?.animation || "";
      }
      // Kept in sync with the server-side PREVIEW_PAD: a narrow margin so a clip whose
      // attachment quads are far larger than its visible pixels still fills the canvas.
      const PREVIEW_PAD = "0%";
      const activeSet = { value: initialSet() };
      const activeAnimation = { name: initialAnimation(activeSet.value) };
      const loopEnabled = { value: true };
      // Сценарий in -> idle -> out для проектов с такими анимациями.
      const currentZoom = { value: config.zoom || 1 };
      const baseViewport = { value: null };
      const animationNames = { value: activeSet.value?.animations || [] };
      const animationMenu = document.getElementById("animation-menu");
      const setCard = document.getElementById("set-card");
      const setSelect = document.getElementById("set-select");
      const noteCard = document.getElementById("note-card");
      const noteText = document.getElementById("note-text");
      const ownerCard = document.getElementById("owner-card");
      const ownerProfile = document.getElementById("owner-profile");
      const ownerLibrary = document.getElementById("owner-library");
      const libraryNavPrev = document.getElementById("library-nav-prev");
      const libraryNavNext = document.getElementById("library-nav-next");
      const previewLikeButton = document.getElementById("preview-like-button");
      const profileNavigationItems = Array.isArray(config.ownerProfile?.navigation) ? config.ownerProfile.navigation : [];
      function normalizedPath(url) {
        try {
          return new URL(url, window.location.origin).pathname.replace(/\\/+$/, "");
        } catch {
          return "";
        }
      }
      function currentNavigationIndex() {
        const currentPath = window.location.pathname.replace(/\\/+$/, "");
        return profileNavigationItems.findIndex((item) => normalizedPath(item?.url || "") === currentPath);
      }
      function siblingNavigationUrl(direction) {
        if (profileNavigationItems.length < 2) return "";
        const index = currentNavigationIndex();
        if (index < 0) return "";
        const nextIndex = direction === "previous" ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= profileNavigationItems.length) return "";
        return profileNavigationItems[nextIndex]?.url || "";
      }
      function navigateSibling(direction) {
        const url = siblingNavigationUrl(direction);
        if (url) window.location.href = url;
      }
      function syncLibraryNavigationButtons() {
        const previousUrl = siblingNavigationUrl("previous");
        const nextUrl = siblingNavigationUrl("next");
        if (libraryNavPrev) {
          libraryNavPrev.disabled = !previousUrl;
          libraryNavPrev.onclick = () => navigateSibling("previous");
        }
        if (libraryNavNext) {
          libraryNavNext.disabled = !nextUrl;
          libraryNavNext.onclick = () => navigateSibling("next");
        }
      }
      const playerElement = document.getElementById("player");
      const playerFrameElement = playerElement?.closest(".player-frame");
      if (animationMenu && playerFrameElement) {
        const syncAnimationMenuHeight = () => {
          if (window.innerWidth <= 1000) {
            animationMenu.style.removeProperty("--animation-menu-player-height");
            return;
          }
          const playerHeight = playerFrameElement.getBoundingClientRect().height;
          if (playerHeight > 0) {
            animationMenu.style.setProperty("--animation-menu-player-height", Math.floor(playerHeight) + "px");
          }
        };
        syncAnimationMenuHeight();
        if (typeof ResizeObserver === "function") {
          new ResizeObserver(syncAnimationMenuHeight).observe(playerFrameElement);
        }
        window.addEventListener("resize", syncAnimationMenuHeight, { passive: true });
      }
const pinchDistance = { value: null };
       const panPosition = { value: null };
       const swipeStart = { value: null };
       const touchPanPosition = { value: null };
      let player;
      let playerReady = false;
      // A URL may select an animation whose owning skeleton is not the first
      // set when the library index is stale or incomplete. Probe each set once.
      const attemptedAnimationSets = new Set();
      const animationSetKey = (set) => String(set?.label || set?.skeleton || "");
      const runtimeLoaders = new Map();
      function legacyRuntimeForSet(set) {
        const version = String(set?.skeletonVersion || "");
        const runtimeVersionOverride = String(set?.runtimeVersionOverride || "");
        if (runtimeVersionOverride === "3.8") return "3.8";
        // В шаблонной строке точка экранируется одним обратным слэшем:
        // было "\\." — регулярка искала буквальную "\." и никогда не срабатывала.
        if (/^3\.7(?:\.|$)/.test(version)) return "3.7";
        if (/^3\.8(?:\.|$)/.test(version)) return "3.8";
        if (/^4\.[012](?:\.|$)/.test(version)) return version.slice(0,3);
        return "";
      }
      function setPlayerStylesheet(href) {
        const link = document.getElementById("spine-player-stylesheet");
        if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
      }
      function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
          const existing = document.querySelector('script[src="' + src + '"]');
          if (existing?.dataset.loaded === "true") {
            resolve();
            return;
          }
          if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("Could not load " + src)), { once: true });
            return;
          }
          const script = document.createElement("script");
          script.src = src;
          script.async = true;
          script.onload = () => {
            script.dataset.loaded = "true";
            resolve();
          };
          script.onerror = () => reject(new Error("Could not load " + src));
          document.head.appendChild(script);
        });
      }
      // Рантайм создаёт Input с autoPreventDefault=true и гасит колесо над канвасом
      // в capture-фазе: страница не прокручивается, когда курсор над плеером. Наше
      // масштабирование живёт на Ctrl/⌘+колесе и пинче, поэтому это гашение нам не
      // нужно. Класс рантайм закрыт извне, поэтому снимаем флаг с живого экземпляра.
      function releaseRuntimeWheelCapture() {
        const p = player;
        const input = p?.input;
        if (input && input.autoPreventDefault) {
          input.autoPreventDefault = false;
          return true;
        }
        return false;
      }

      function loadSpineRuntime(set) {
        const runtime = legacyRuntimeForSet(set);
        const key = runtime || "4.3.13";
        if (!runtimeLoaders.has(key)) {
          runtimeLoaders.set(key, (async () => {
            if (runtime && runtime.startsWith("4.")) {
              // Use the same exact package pins as the server-side renderer;
              // wildcard unpkg URLs can resolve inconsistently or return 403.
              const pinnedVersions = {"4.0":"4.0.31","4.1":"4.1.56","4.2":"4.2.120"};
              const version = pinnedVersions[runtime];
              if (!version) throw new Error("Unsupported pinned Spine runtime: " + runtime);
              const base = "https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@" + version + "/dist/";
              setPlayerStylesheet(base + "spine-player.css");
              await loadScriptOnce(base + "iife/spine-player.js");
            } else if (runtime === "3.7") {
              // Use the official 3.7 player build pinned to an immutable commit;
              // the old /vendor-spine-player-3.7.* files are not in this repo.
              const base = "https://cdn.jsdelivr.net/gh/EsotericSoftware/spine-runtimes@9639bcc81722d7178fd9d1cdc1a3d55a4c91f989/spine-ts/";
              setPlayerStylesheet(base + "player/css/spine-player.css");
              await loadScriptOnce(base + "build/spine-player.js");
            } else if (runtime === "3.8") {
              // Serve the exact official, commit-pinned Spine 3.8 runtime from
              // this origin. The public vendor files are byte-identical to
              // EsotericSoftware/spine-runtimes@8b4844bd4b193ba9e54487ed397a777993cbad56.
              // Same-origin delivery avoids third-party CDN/DNS failures on
              // legacy previews and matches the exporter runtime.
              setPlayerStylesheet("/vendor-spine-player-3.8.css");
              await loadScriptOnce("/vendor-spine-player-3.8.js");
            } else if (runtime) {
              setPlayerStylesheet("/vendor-spine-player-" + runtime + ".css");
              await loadScriptOnce("/vendor-spine-player-" + runtime + ".js");
            } else {
              setPlayerStylesheet("https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/spine-player.css");
              await loadScriptOnce("https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/iife/spine-player.js");
            }
            if (!window.spine?.SpinePlayer) throw new Error("Spine runtime could not be loaded.");
            if (window.spine?.GLTexture) window.spine.GLTexture.DISABLE_UNPACK_PREMULTIPLIED_ALPHA_WEBGL = true;
            return window.spine.SpinePlayer;
          })());
        }
        return runtimeLoaders.get(key);
      }
      function syncUrl(replace = false) {
        if (!activeSet.value || !activeAnimation.name) return;
        const url = new URL(window.location.href);
        if (sets.length > 1) url.searchParams.set("set", activeSet.value.label);
        else url.searchParams.delete("set");
        url.searchParams.set("animation", activeAnimation.name);
        const nextUrl = url.pathname + url.search + url.hash;
        if (nextUrl === window.location.pathname + window.location.search + window.location.hash) return;
        window.history[replace ? "replaceState" : "pushState"]({}, "", nextUrl);
      }
      function applySelectionFromUrl() {
        const nextSet = initialSet();
        activeSet.value = nextSet;
        activeAnimation.name = initialAnimation(nextSet);
        syncSetInfo();
        renderAnimationList();
        createPlayer();
      }
      function syncSetInfo() {
        if (!activeSet.value) return;
        animationNames.value = activeSet.value.animations || [];
        setCard.style.display = sets.length > 1 ? "" : "none";
        setSelect.value = activeSet.value.label;
        const note = String(config.note || "").trim();
        noteText.textContent = note;
        noteCard.style.display = note ? "" : "none";
      }
      function renderSetList() { setSelect.innerHTML = ""; sets.forEach((set) => { const option = document.createElement("option"); option.value = set.label; option.textContent = set.label; setSelect.appendChild(option); }); }
      function playOwnerThumb(video) {
        const source = video?.dataset?.videoSrc || "";
        if (!source) return;
        if (!video.getAttribute("src")) video.setAttribute("src", source);
        video.muted = true;
        video.playsInline = true;
        // Клипы по 2-3 секунды: без повтора карточка замирала на последнем кадре и
        // выглядела пустой, хотя анимация в ней есть.
        video.loop = true;
        if (video.ended || (video.currentTime > 0 && video.currentTime >= video.duration - 0.05)) {
          try { video.currentTime = 0; } catch (e) {}
        }
        const attempt = video.play();
        if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
      }
      function stopOwnerThumb(video) {
        if (!video) return;
        video.pause();
        try { video.currentTime = 0; } catch {}
      }
      // Anonymous owners: 30 individual images. Pick one deterministically by owner id.
      const ANON_AVATAR_COUNT = 30;

      function ownerAvatarUrl(seed) {
        const text = String(seed || "");
        let hash = 0;
        for (let i = 0; i < text.length; i += 1) {
          hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
        }
        const idx = (hash % ANON_AVATAR_COUNT) + 1;
        return "/avatars/sprite_" + String(idx).padStart(2, "0") + ".png";
      }
      function renderOwnerCard() {
        const owner = config.ownerProfile || {};
        const items = Array.isArray(owner.library) ? owner.library : [];
        ownerCard.classList.toggle("is-visible", Boolean(owner.visible));
        ownerLibrary.classList.toggle("is-visible", Boolean(owner.visible && items.length));
        ownerProfile.innerHTML = "";
        ownerLibrary.innerHTML = "";
        if (!owner.visible) return;
        ownerProfile.className = "owner-profile";
        const avatar = document.createElement("div");
        avatar.className = "owner-avatar";
        avatar.setAttribute("role", "img");
        avatar.setAttribute("aria-label", owner.name || "Anonymous owner");
        // Anonymous owners have no portrait, so they get a frame from the shared
        // sprite. The frame is picked from the owner id, so the same person keeps
        // the same face everywhere and two owners rarely collide. The sprite is
        // painted with background-image (a <div>), because an <img> would show the
        // whole PNG instead of the one cell the CSS background-position crops out.
        if (owner.picture) {
          avatar.style.backgroundImage = "url('" + owner.picture + "')";
          avatar.style.backgroundSize = "cover";
          avatar.style.backgroundPosition = "center";
        } else {
          avatar.style.backgroundImage = "url('" + ownerAvatarUrl(owner.id || owner.name || "") + "')";
          avatar.style.backgroundSize = "cover";
          avatar.style.backgroundPosition = "center";
        }
        const ownerText = document.createElement("div");
        ownerText.className = "owner-profile-text";
        const ownerName = document.createElement("strong");
        ownerName.textContent = owner.name || "anonim";
        const ownerSubtitle = document.createElement("span");
        ownerSubtitle.textContent = owner.subtitle || "Public Spine library";
        ownerText.append(ownerName, ownerSubtitle);
        ownerProfile.append(avatar, ownerText);
        if (owner.url) {
          ownerProfile.style.cursor = "pointer";
          ownerProfile.onclick = () => { window.location.href = owner.url; };
          ownerProfile.title = "Open public library";
        }
        const visibleItems = items.length > 8 ? items.slice(0, 7) : items.slice(0, 8);
        visibleItems.forEach((item) => {
          const link = document.createElement("a");
          link.href = item.url;
          const thumbSrc = item.thumbnailType === "gif" ? item.thumbnailPoster || "" : item.thumbnail || item.thumbnailPoster || "";
          const videoSrc = item.webmPreview || "";
          const thumb = videoSrc ? document.createElement("video") : thumbSrc ? document.createElement("img") : document.createElement("div");
          thumb.className = "owner-thumb";
          if (videoSrc) {
            thumb.dataset.videoSrc = videoSrc;
            if (item.thumbnailPoster) thumb.poster = item.thumbnailPoster;
            thumb.muted = true;
            thumb.loop = true;
            thumb.playsInline = true;
            thumb.preload = "none";
            thumb.setAttribute("aria-hidden", "true");
          } else if (thumbSrc) {
            thumb.src = thumbSrc;
            thumb.alt = "";
          }
          const text = document.createElement("div");
          const title = document.createElement("strong");
          title.textContent = item.title || "Spine preview";
          const meta = document.createElement("span");
          meta.textContent = (item.animations || 0) + " animations";
          text.append(title, meta);
          link.append(thumb, text);
          ownerLibrary.appendChild(link);
        });
        if (items.length > 8 && owner.url) {
          const more = document.createElement("a");
          more.className = "owner-library-more";
          more.href = owner.url;
          more.setAttribute("aria-label", "View more animations from this user");
          const moreLabel = document.createElement("strong");
          moreLabel.textContent = "View more animations";
          more.appendChild(moreLabel);
          ownerLibrary.appendChild(more);
        }
      }
      function installOwnerLibraryChaos() {
        const visibleVideos = new Set();
        const manualVideos = new WeakSet();
        const hoverTimers = new WeakMap();
        let chaosTimer = 0;
        function clearHoverTimer(video) {
          const timer = hoverTimers.get(video);
          if (timer) window.clearTimeout(timer);
          hoverTimers.delete(video);
        }
        function startHoverLoop(video) {
          manualVideos.add(video);
          clearHoverTimer(video);
          video.onended = () => {
            const timer = window.setTimeout(() => {
              if (!manualVideos.has(video)) return;
              try { video.currentTime = 0; } catch {}
              playOwnerThumb(video);
            }, 1000);
            hoverTimers.set(video, timer);
          };
          playOwnerThumb(video);
        }
        function stopHoverLoop(video) {
          manualVideos.delete(video);
          clearHoverTimer(video);
          stopOwnerThumb(video);
        }
        function scheduleChaos() {
          window.clearTimeout(chaosTimer);
          chaosTimer = window.setTimeout(runChaos, 800 + Math.random() * 2000);
        }
        function randomSample(items, count) {
          return items
            .map((item) => ({ item, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .slice(0, count)
            .map((entry) => entry.item);
        }
        function runChaos() {
          const videos = Array.from(visibleVideos).filter((video) => video.isConnected && (video.dataset.videoSrc || video.getAttribute("src")));
          if (!videos.length) {
            scheduleChaos();
            return;
          }
          const activeLimit = Math.min(4, Math.max(2, Math.ceil(videos.length * 0.35)));
          randomSample(videos.filter((video) => !video.paused && !manualVideos.has(video)), videos.length).slice(activeLimit).forEach(stopOwnerThumb);
          randomSample(videos.filter((video) => video.paused && !manualVideos.has(video)), activeLimit).forEach((video) => {
            if (Math.random() < 0.92) {
              playOwnerThumb(video);
              window.setTimeout(() => {
                if (!manualVideos.has(video) && visibleVideos.has(video) && Math.random() < 0.7) stopOwnerThumb(video);
              }, 1200 + Math.random() * 3000);
            }
          });
          videos.forEach((video) => {
            if (!manualVideos.has(video) && !video.paused && Math.random() < 0.4) stopOwnerThumb(video);
          });
          scheduleChaos();
        }
        document.querySelectorAll(".owner-library a").forEach((link) => {
          const video = link.querySelector("video.owner-thumb");
          if (!video) return;
          link.addEventListener("pointerenter", () => startHoverLoop(video));
          link.addEventListener("focusin", () => startHoverLoop(video));
          link.addEventListener("pointerleave", () => stopHoverLoop(video));
          link.addEventListener("focusout", () => stopHoverLoop(video));
        });
        if ("IntersectionObserver" in window) {
          const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
              const video = entry.target.querySelector("video.owner-thumb");
              if (!video) return;
              if (entry.isIntersecting && entry.intersectionRatio >= 0.42) {
                visibleVideos.add(video);
              } else {
                visibleVideos.delete(video);
                if (!manualVideos.has(video)) stopOwnerThumb(video);
              }
            });
            scheduleChaos();
          }, { threshold: [0, 0.42, 0.68, 1] });
          document.querySelectorAll(".owner-library a").forEach((link) => observer.observe(link));
        } else {
          document.querySelectorAll("video.owner-thumb").forEach((video) => visibleVideos.add(video));
        }
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) {
            window.clearTimeout(chaosTimer);
            visibleVideos.forEach((video) => { if (!manualVideos.has(video)) stopOwnerThumb(video); });
          } else {
            scheduleChaos();
          }
        });
        window.addEventListener("pagehide", () => {
          window.clearTimeout(chaosTimer);
          visibleVideos.forEach(stopOwnerThumb);
        }, { once: true });
        scheduleChaos();
      }
      // Кадр зафиксирован на весь показ: переключение анимации не должно
      // пересчитывать вьюпорт и сбивать центровку.
      function rememberBaseViewport() { if (!player?.currentViewport) return;
        const v = player.currentViewport; baseViewport.value = { x: v.x, y: v.y, width: v.width * currentZoom.value, height: v.height * currentZoom.value, padLeft: v.padLeft * currentZoom.value, padRight: v.padRight * currentZoom.value, padTop: v.padTop * currentZoom.value, padBottom: v.padBottom * currentZoom.value }; }
      // Один якорь на весь показ. В скелете бывают клипы разного масштаба, поэтому
      // размер кадра подстраивается под анимацию, а точка, вокруг которой он
      // центрируется, остаётся прежней: переключение ничего не двигает.
      const stageOffset = { value: null };
      function captureStageOffset() {
        const v = player?.currentViewport;
        if (!v) return;
        stageOffset.value = { x: 0, y: 0 };
      }
      // Кадр остаётся тем, каким его посчитал рантайм под конкретный клип, но
      // пользовательское смещение (зум/панорама) сохраняется: якорь задаёт не
      // абсолютную точку мира, а долю отступа от центра кадра.
      function applyStageAnchor() {
        const v = player?.currentViewport;
        const offset = stageOffset.value;
        if (!v || !offset) return;
        v.x = v.x + v.width * offset.x;
        v.y = v.y + v.height * offset.y;
        player.previousViewport = { ...v };
        player.viewportTransitionStart = performance.now();
      }
      function touchDistance(touches) { const a = touches.item(0), b = touches.item(1); if (!a || !b) return 0; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
      function applyZoom(nextZoom) { currentZoom.value = Math.min(4, Math.max(0.6, Number(nextZoom))); playerElement.style.setProperty("--preview-pattern-size", (140 * currentZoom.value) + "px"); const b = baseViewport.value; if (!b || !player?.currentViewport) return; const cx = b.x + b.width / 2, cy = b.y + b.height / 2, width = b.width / currentZoom.value, height = b.height / currentZoom.value; const next = { x: cx - width / 2, y: cy - height / 2, width, height, padLeft: b.padLeft / currentZoom.value, padRight: b.padRight / currentZoom.value, padTop: b.padTop / currentZoom.value, padBottom: b.padBottom / currentZoom.value }; player.previousViewport = { ...next }; player.currentViewport = next; player.viewportTransitionStart = performance.now(); }
      function limitPlayerFps(loadedPlayer, maxFps) {
        if (!loadedPlayer || typeof loadedPlayer.drawFrame !== "function") return;
        const targetMs = 1000 / Math.max(1, maxFps);
        let lastRender = 0;
        const originalDrawFrame = loadedPlayer.drawFrame.bind(loadedPlayer);
        loadedPlayer.drawFrame = (requestNextFrame = true) => {
          if (loadedPlayer.disposed || loadedPlayer.error) return;
          if (document.hidden) return; // stop rendering when tab hidden
          const now = performance.now();
          const paused = loadedPlayer.paused === true;
          const frameBudget = paused ? 1000 / Math.min(8, maxFps) : targetMs;
          if (now - lastRender >= frameBudget) {
            lastRender = now;
            originalDrawFrame(false);
          }
          if (requestNextFrame && !loadedPlayer.stopRequestAnimationFrame) {
            requestAnimationFrame(() => loadedPlayer.drawFrame(true));
          }
        };
      }
      function updateLoopButtonState(button) { button.classList.toggle("is-on", loopEnabled.value); button.classList.toggle("is-off", !loopEnabled.value); button.title = loopEnabled.value ? "Loop on" : "Loop off"; button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", String(loopEnabled.value)); }
      function setTrackLoop() { const entry = player?.animationState?.getCurrent?.(0); if (entry) entry.loop = loopEnabled.value; }
      function disableMix() { if (player?.animationState?.data) player.animationState.data.defaultMix = 0; }
      function playAnimationEntry(name) {
        if (!name) return false;
        // The custom animation list is available before Spine Player finishes
        // loading its skeleton. Queue the current selection instead of calling
        // setAnimation against an uninitialized player instance.
        if (!playerReady) return true;
        if (!player) return false;
        // Do not require skeleton.data.findAnimation here: that method is
        // not exposed consistently by the 3.8/4.1 Spine Player wrappers even
        // though their own animation menus list the tracks. Let the runtime
        // validate the exact indexed name through setAnimation and its track.
        disableMix();
        let setResult;
        try {
          // Spine Player 3.8 updates AnimationState but returns void; newer
          // runtimes may return a TrackEntry. Both contracts are supported.
          setResult = player.setAnimation(name, loopEnabled.value);
        } catch {
          markPreviewBlocked("SELECTED_SPINE_ANIMATION_UNAVAILABLE");
          return false;
        }
        const playerContainer = document.getElementById("player");
        if (playerContainer) playerContainer.dataset.previewAnimation = name;
        const entry = setResult || player.animationState?.getCurrent?.(0);
        // Spine Player 3.8 applies the animation but exposes neither the
        // TrackEntry return value nor animationState on its public wrapper.
        // A successful setAnimation call is therefore sufficient; customize
        // the TrackEntry only on runtimes that expose it.
        if (entry) {
          entry.mixDuration = 0;
          entry.mixTime = 0;
          entry.listener = { ...(entry.listener || {}), complete: () => {
            if (!loopEnabled.value) player.pause();
          } };
        }
        player.play();
        rememberBaseViewport();
        applyStageAnchor();
        return true;
      }
      function playActiveAnimationFromStart() {
        if (!activeAnimation.name) return false;
        if (!playerReady) return true;
        if (!player) return false;
        return playAnimationEntry(activeAnimation.name);
      }
      function togglePlayback() { if (!playerReady || !player || !activeAnimation.name) return; if (player.paused === false) { player.pause(); return; } playActiveAnimationFromStart(); }
      function installLoopButton() { const buttons = player?.dom?.querySelector(".spine-player-buttons"); const playButton = buttons?.querySelector(".spine-player-button"); if (!buttons || !playButton) return; playButton.onclick = (event) => { event.preventDefault(); event.stopPropagation(); togglePlayback(); }; if (buttons.querySelector(".spine-link-loop-button")) return; const button = document.createElement("button"); button.type = "button"; button.className = "spine-player-button spine-link-loop-button"; updateLoopButtonState(button); button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); loopEnabled.value = !loopEnabled.value; setTrackLoop(); updateLoopButtonState(button); }; playButton.insertAdjacentElement("afterend", button); }
      function panByPixels(deltaX, deltaY) { const v = player?.currentViewport, b = baseViewport.value, canvas = player?.canvas; if (!v || !b || !canvas) return; const totalWidth = v.width + v.padLeft + v.padRight, totalHeight = v.height + v.padTop + v.padBottom; const worldDeltaX = deltaX / Math.max(1, canvas.clientWidth) * totalWidth, worldDeltaY = deltaY / Math.max(1, canvas.clientHeight) * totalHeight; v.x -= worldDeltaX; v.y += worldDeltaY; b.x -= worldDeltaX * currentZoom.value; b.y += worldDeltaY * currentZoom.value; player.previousViewport = { ...v }; player.viewportTransitionStart = performance.now(); }

      // The exported skeleton header (skeleton.x/y/width/height) describes the
      // REST pose only. When an animation moves a bone/slot outside that box --
      // which is normal for particle/VFX tracks that scale or fly far from the
      // origin -- the shipped viewport is far too small and the effect gets
      // cropped to a sliver (often invisible). So we drop the static
      // x/y/width/height and let the runtime's calculateAnimationViewport()
      // measure the true bounds of the animation that is actually playing.
      function measuredViewport(set) {
        const src = set?.viewport || {};
        const viewport = {
          padLeft: src.padLeft !== undefined ? src.padLeft : PREVIEW_PAD,
          padRight: src.padRight !== undefined ? src.padRight : PREVIEW_PAD,
          padTop: src.padTop !== undefined ? src.padTop : PREVIEW_PAD,
          padBottom: src.padBottom !== undefined ? src.padBottom : PREVIEW_PAD,
        };
        // Keep a saved per-entry layout clip if the entry explicitly defined one
        // (the author framed it by hand), otherwise let the runtime measure.
        if (src.__locked) {
          viewport.x = src.x; viewport.y = src.y; viewport.width = src.width; viewport.height = src.height;
        }
        return viewport;
      }
      // Ask the runtime to re-fit the current animation, then cache it as the
      // base used by zoom/pan. This is the "fix it on the fly" path.
      function refitToContent(targetPlayer) {
        const p = targetPlayer || player;
        if (!p?.skeleton?.data) return false;
        const names = p.skeleton.data.animations.map((a) => a.name);
        const active = typeof activeAnimation.name === 'string' ? activeAnimation.name : '';
        if (!active || !names.includes(active)) return false;
        try {
          p.setViewport(active);
        } catch (e) {
          return false;
        }
        rememberBaseViewport();
        applyZoom(currentZoom.value);
        return true;
      }
      // Measure the real bounding box of the animation that is playing. The
      // runtime does this internally (calculateAnimationViewport); we redo it
      // here purely to compare "what the animation needs" against "what the
      // current viewport shows", so we can self-heal when the two disagree.
      // Pure maths on the skeleton -- no GPU readback, so it is reliable even
      // though this page runs with preserveDrawingBuffer off.
      function measuredAnimationBounds(targetPlayer, steps = 60) {
        const p = targetPlayer || player;
        const skeleton = p?.skeleton;
        if (!skeleton?.data) return null;
        const animationName = typeof activeAnimation.name === "string" ? activeAnimation.name.trim() : "";
        // Spine 4.3 throws when findAnimation receives null/empty; older 3.8
        // runtimes returned null. A work with no indexed default is valid and
        // should wait for the user to choose a track.
        if (!animationName) return null;
        const animation = skeleton.data.findAnimation(animationName);
        if (!animation) return null;
        const ns = window.spine || {};
        const MixFrom = ns.MixFrom || p.constructor?.MixFrom;
        const Physics = ns.Physics || { update: 0 };
        const duration = Number(animation.duration) || 0;
        const stepTime = duration > 0 ? duration / steps : 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const scratch = [0, 0];
        for (let i = 0; i <= steps; i++) {
          const time = i * stepTime;
          try {
            animation.apply(skeleton, time, time, false, [], 1, MixFrom?.setup, false, false, false);
            skeleton.updateWorldTransform(Physics.update);
            const offset = new (ns.Vector2 || function () { this.x = 0; this.y = 0; })();
            const size = new (ns.Vector2 || function () { this.x = 0; this.y = 0; })();
            const clipping = p.sceneRenderer?.skeletonRenderer?.getSkeletonClipping?.();
            skeleton.getBounds(offset, size, scratch, clipping);
            if (Number.isFinite(offset.x) && Number.isFinite(offset.y) && Number.isFinite(size.x) && Number.isFinite(size.y)) {
              minX = Math.min(minX, offset.x);
              maxX = Math.max(maxX, offset.x + size.x);
              minY = Math.min(minY, offset.y);
              maxY = Math.max(maxY, offset.y + size.y);
            }
          } catch (e) {
            // One bad sample should not abort the whole measurement.
          }
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }

      // Self-heal: if the playing animation reaches outside the viewport we are
      // currently showing, re-measure and re-fit. Runs a bounded number of
      // times after load and after every clip switch, so a bad framing heals
      // itself instead of leaving the user staring at a cropped animation.
      let healAttempts = 0;
      function ensureVisibleContent() {
        if (healAttempts >= 3) return;
        const p = player;
        const viewport = p?.currentViewport;
        if (!viewport || !Number.isFinite(viewport.width) || viewport.width <= 0) return;
        const bounds = measuredAnimationBounds(p);
        if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return;
        // A little slack: 1% so rounding on the very first frame is not read as
        // "clipped" and we do not loop re-fitting forever.
        const slackX = bounds.width * 0.01;
        const slackY = bounds.height * 0.01;
        const viewRight = viewport.x + viewport.width;
        const viewBottom = viewport.y + viewport.height;
        const clipped =
          bounds.x < viewport.x - slackX ||
          bounds.y < viewport.y - slackY ||
          bounds.x + bounds.width > viewRight + slackX ||
          bounds.y + bounds.height > viewBottom + slackY;
        if (!clipped) return;
        healAttempts++;
        refitToContent(p);
      }
      function resetHealAttempts() { healAttempts = 0; }

      // На медленной сети текстура едет секундами: канвас существует, но пуст, и
      // пользователь видит тёмный бокс вместо работы. Показываем выгрузку того же
      // клипа сразу как подложку и убираем её, когда интерактивный плеер готов.
      function showPreviewVideoFallback() {
        const video = document.getElementById("preview-loading-video");
        if (!video || !activeAnimation.name || video.dataset.animation !== activeAnimation.name) return null;
        video.hidden = false;
        video.style.display = "block";
        video.muted = true;
        const attempt = video.play();
        if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
        return video;
      }
      function clearPreviewVideoFallback() {
        const video = document.getElementById("preview-loading-video");
        if (!video) return;
        video.pause();
        video.hidden = true;
        video.style.display = "none";
      }

      function markPreviewBlocked(code, detail = "") {
        playerReady = false;
        clearPreviewVideoFallback();
        try { player?.dispose?.(); } catch {}
        player = null;
        const box = document.getElementById("player");
        if (!box) return;
        box.dataset.previewStatus = "blocked";
        box.dataset.previewError = code;
        delete box.dataset.previewAnimation;
        const detailText = String(detail || "").replace(/<[^>]*>/g, " ").trim();
        if (detailText) box.dataset.previewErrorDetail = detailText.slice(0, 500);
        const missingAtlasRegion = detailText.match(/Region not found in atlas:\\s*([^\\s]+)/i)?.[1] || "";
        const message = document.createElement("div");
        message.dataset.previewBlocked = code;
        message.style.cssText = "display:grid;place-items:center;height:100%;padding:24px;color:#ffb088;font-weight:900;text-align:center;";
        message.textContent = code === "SELECTED_SPINE_ANIMATION_UNAVAILABLE"
          ? "Selected Spine animation is unavailable. Preview blocked."
          : code === "UNSUPPORTED_SPINE_3_8_75"
            ? "This export uses Spine 3.8.75, which the official runtime rejects because of a known export bug. Re-export the original Spine project with Spine 3.8.99."
            : code === "UNSUPPORTED_SPINE_3_7_BINARY"
              ? "Spine 3.7 binary (.skel) is not compatible with the web player. Re-export the same project as JSON using Spine Editor 3.7."
              : code === "UNSUPPORTED_SPINE_VERSION"
                ? "This export uses Spine " + String(activeSet.value?.skeletonVersion || "unknown") + ". Spine-Link supports Web Player exports from Spine 3.7 through 4.3. Re-export the original .spine project with a supported editor version."
                : code === "SPINE_PLAYER_ERROR" && missingAtlasRegion
                  ? "The skeleton references atlas region " + missingAtlasRegion + ", but that region is missing from the selected atlas. Re-export the skeleton and atlas together."
                  : "Spine preview is blocked.";
        box.replaceChildren(message);
      }

      async function createPlayer() {
        playerReady = false;
        const playerContainer = document.getElementById("player");
        if (playerContainer) {
          playerContainer.dataset.previewStatus = "loading";
          delete playerContainer.dataset.previewError;
          delete playerContainer.dataset.previewAnimation;
        }
        if (!activeSet.value) {
          markPreviewBlocked("NO_SKELETON_SET");
          return;
        }
        const skeletonVersion = String(activeSet.value.skeletonVersion || "");
        // Spine 3.7 and 3.8 use incompatible binary formats. The official
        // 3.7 Web Player only loads JSON, while the 3.8 runtime cannot parse
        // 3.7 SKEL data. Never report an empty skeleton as successfully loaded.
        if (/^3\\.7(?:\\.|$)/.test(skeletonVersion) && Boolean(activeSet.value.skelUrl)) {
          markPreviewBlocked("UNSUPPORTED_SPINE_3_7_BINARY");
          return;
        }
        // Spine 3.8.75 exports contain a known upstream IK/export bug and are
        // explicitly rejected by the official 3.8 runtime.
        if (skeletonVersion === "3.8.75") {
          markPreviewBlocked("UNSUPPORTED_SPINE_3_8_75");
          return;
        }
        // Binary sources use the exact option expected by their native runtime:
        // skelUrl (3.8), binaryUrl (4.0-4.2), skeleton (4.3).
        // Spine 3.7 binary is blocked above because its format is incompatible.
        // Do not silently feed 2.x / 3.0-3.6 / future unknown exports to 4.3:
        // those formats require their matching historical runtime and otherwise
        // fail with misleading parser errors such as "Slot name must not be null".
        if (skeletonVersion && !/^(?:3\.(?:7|8)(?:\.|$)|4\.[0-3](?:\.|$))/.test(skeletonVersion)) {
          markPreviewBlocked("UNSUPPORTED_SPINE_VERSION");
          return;
        }
        resetHealAttempts();
        try { player?.dispose?.(); } catch {}
        player = null;
        baseViewport.value = null;
        showPreviewVideoFallback();
        let SpinePlayer;
        try {
          SpinePlayer = await loadSpineRuntime(activeSet.value);
        } catch {
          if (!showPreviewVideoFallback()) markPreviewBlocked("SPINE_RUNTIME_LOAD_FAILED");
          return;
        }
        const requestedAnimation = activeAnimation.name;
        attemptedAnimationSets.add(animationSetKey(activeSet.value));
        // The index can lag behind the actual skeleton (especially for binary
        // .skel uploads). An explicit empty selectable list makes Spine Player
        // reject even a valid URL-selected animation before its success callback.
        // Omit an unknown list; when a list exists, always include the exact
        // requested name and let the loaded skeleton verify it below.
        const playerSet = { ...activeSet.value };
        if (requestedAnimation) {
          const indexedAnimations = Array.isArray(playerSet.animations)
            ? playerSet.animations.filter((name) => typeof name === "string" && name.trim())
            : [];
          // Only pass selectable tracks when a concrete track is requested.
          // An empty string is rejected by both legacy 3.8 and current 4.3
          // runtimes ("animation '' does not exist" / "animationName cannot be null").
          playerSet.animations = [...new Set([...indexedAnimations, requestedAnimation])];
          playerSet.animation = requestedAnimation;
        } else {
          // Keep the skeleton loadable without silently starting its first track.
          delete playerSet.animation;
          delete playerSet.animations;
        }
        try {
          const isSpine42Or43 = /^4[.][23](?:[.]|$)/.test(String(activeSet.value?.skeletonVersion || ""));
          const playerOptions = {
            ...playerSet,
            ...(requestedAnimation ? { animation: requestedAnimation } : {}),
            ...(isSpine42Or43
              ? { skeleton: activeSet.value.jsonUrl || activeSet.value.skelUrl || activeSet.value.skeleton, atlasUrl: activeSet.value.atlasUrl }
              : {}),
            ...(/^4[.][012](?:[.]|$)/.test(String(activeSet.value?.skeletonVersion || ""))
              ? { binaryUrl: activeSet.value.skelUrl || undefined, atlasUrl: activeSet.value.atlasUrl }
              : {}),
          };
          // Spine Player 4.2/4.3 detects JSON vs binary with skeleton.endsWith(".json").
          // Our immutable asset URLs carry a ?v= cache key, so the JSON URL no
          // longer ends with .json and 4.2/4.3 incorrectly feeds JSON bytes to its
          // binary parser ("boneData cannot be null"). Fetch the versioned URL
          // ourselves, then expose the exact bytes through rawDataURIs under a
          // query-free .json key so the official runtime selects SkeletonJson.
          if (isSpine42Or43) {
            const skeletonSource = String(activeSet.value.jsonUrl || activeSet.value.skelUrl || activeSet.value.skeleton || "");
            const skeletonPath = skeletonSource.split(/[?#]/, 1)[0];
            if (/\.json$/i.test(skeletonPath) && skeletonSource !== skeletonPath) {
              const atlasSource = String(activeSet.value.atlasUrl || activeSet.value.atlas || "");
              const atlasPath = atlasSource.split(/[?#]/, 1)[0];
              const rawDataURIs = { ...(playerOptions.rawDataURIs || {}) };

              // Keep query-free filenames for Spine's format detection, but
              // route each exact filename to its immutable, versioned asset URL.
              // Spine 4.2's Downloader treats data:application/json as a URL
              // because its legacy rawDataURIs heuristic sees the dot in MIME
              // types. URL-to-URL mappings avoid that ambiguity and preserve
              // the asset cache key.
              playerOptions.skeleton = skeletonPath;
              playerOptions.jsonUrl = skeletonPath;
              rawDataURIs[skeletonPath] = skeletonSource;

              if (atlasPath) {
                playerOptions.atlas = atlasPath;
                playerOptions.atlasUrl = atlasPath;
                rawDataURIs[atlasPath] = atlasSource;
              }

              for (const textureSource of Array.isArray(activeSet.value.textures) ? activeSet.value.textures : []) {
                const texturePath = String(textureSource || "").split(/[?#]/, 1)[0];
                const textureName = texturePath.slice(texturePath.lastIndexOf("/") + 1);
                if (!textureName) continue;
                rawDataURIs[texturePath] = textureSource;
                rawDataURIs[textureName] = textureSource;
              }

              playerOptions.rawDataURIs = rawDataURIs;
            }
          }
          player = new SpinePlayer("player", {
            ...playerOptions,
            // Spine Player 4.1 tries to calculate bounds for an empty animation
            // when a skeleton has no indexed default track. Keep the skeleton
            // loadable and expose its tracks for manual selection instead.
            // A generous setup-pose viewport prevents the runtime's empty-bounds
            // exception; selecting a real animation later calls setViewport().
            viewport: requestedAnimation
              ? measuredViewport(activeSet.value)
              : { ...measuredViewport(activeSet.value), x: -4096, y: -4096, width: 8192, height: 8192 },
            showControls: true,
            showLoading: true,
            alpha: true,
            preserveDrawingBuffer: false,
            backgroundColor: "00000000",
            success: (loadedPlayer) => {
              player = loadedPlayer;
              playerReady = true;
              const playerContainer = document.getElementById("player");
              if (playerContainer) {
                playerContainer.dataset.previewStatus = "ready";
                delete playerContainer.dataset.previewError;
              }
              limitPlayerFps(loadedPlayer, 30);
              releaseRuntimeWheelCapture();
              clearPreviewVideoFallback();
              // Read from the success callback's player instance rather than
              // the outer player closure: a cached/fast load can invoke
              // success before the assignment expression has completed.
              const runtimeAnimationData = loadedPlayer?.skeleton?.data?.animations;
              const runtimeNames = Array.isArray(runtimeAnimationData)
                ? runtimeAnimationData.map((animation) => animation.name).filter((name) => typeof name === "string" && name.trim())
                : [];
              const indexedNames = Array.isArray(activeSet.value?.animations)
                ? activeSet.value.animations.filter((name) => typeof name === "string" && name.trim())
                : [];
              if (playerContainer) {
                playerContainer.dataset.previewRuntimeAnimationCount = String(runtimeNames.length);
                playerContainer.dataset.previewRuntimeAnimationNames = runtimeNames.join("|");
                playerContainer.dataset.previewRuntimeBoneCount = String(loadedPlayer?.skeleton?.data?.bones?.length ?? 0);
                playerContainer.dataset.previewRuntimeSlotCount = String(loadedPlayer?.skeleton?.data?.slots?.length ?? 0);
              }
              const names = runtimeNames.length ? runtimeNames : indexedNames;
              if (names.length) {
                animationNames.value = names.filter(name => !name.startsWith("Backup/") || name === requestedAnimation);
              }
              const selectedAnimation = activeAnimation.name || requestedAnimation;
              if (selectedAnimation && names.length && !names.includes(selectedAnimation)) {
                // The selected clip can belong to another skeleton set in this
                // work. Try the remaining sets before reporting it unavailable.
                const nextSet = sets.find((set) => !attemptedAnimationSets.has(animationSetKey(set)));
                if (nextSet) {
                  try { loadedPlayer?.dispose?.(); } catch {}
                  player = null;
                  activeSet.value = nextSet;
                  animationNames.value = nextSet.animations || [];
                  syncSetInfo();
                  renderAnimationList();
                  createPlayer();
                  return;
                }
                // If the index supplied a stale default, but the URL did not
                // explicitly request that track, keep the verified skeleton
                // loaded and expose its real animation list for manual choice.
                // An explicitly requested missing animation remains blocked.
                if (!queryValue("animation")) {
                  activeAnimation.name = "";
                  attemptedAnimationSets.clear();
                  renderAnimationList();
                  disableMix();
                  installLoopButton();
                  return;
                }
                renderAnimationList();
                markPreviewBlocked("SELECTED_SPINE_ANIMATION_UNAVAILABLE");
                return;
              }
              attemptedAnimationSets.clear();
              renderAnimationList();
              // A missing index default is not a broken skeleton. Load the
              // verified runtime animation list and wait for an explicit choice.
              // Never silently substitute the first track or an "idle" track.
              if (selectedAnimation) {
                activeAnimation.name = selectedAnimation;
                syncUrl();
                disableMix();
                installLoopButton();
                if (!playActiveAnimationFromStart()) return;
              } else {
                disableMix();
                installLoopButton();
              }
              requestAnimationFrame(() => {
                rememberBaseViewport();
                captureStageOffset();
                applyZoom(currentZoom.value);
                window.setTimeout(ensureVisibleContent, 120);
                window.setTimeout(ensureVisibleContent, 420);
                window.setTimeout(applyStageAnchor, 560);
                window.setTimeout(applyStageAnchor, 900);
              });
            },
            error: (_player, reason) => {
              playerReady = false;
              if (showPreviewVideoFallback()) {
                const video = document.getElementById("preview-loading-video");
                if (video) {
                  video.controls = true;
                  video.style.pointerEvents = "auto";
                }
                return;
              }
              markPreviewBlocked("SPINE_PLAYER_ERROR", reason);
            },
          });
        } catch {
          if (!showPreviewVideoFallback()) markPreviewBlocked("SPINE_PLAYER_CREATE_FAILED");
        }
      }
      function renderAnimationList() {
        // Preserve the list position when a user switches animations. Replacing
        // the button nodes without this resets long menus back to the top.
        const previouslyRendered = animationMenu.childElementCount > 0;
        const previousScrollTop = animationMenu.scrollTop;
        animationMenu.innerHTML = "";
        animationNames.value.forEach((animationName) => {
          const button = document.createElement("button");
          button.type = "button";
          button.role = "menuitem";
          button.textContent = animationName;
          button.className = animationName === activeAnimation.name ? "active" : "";
          button.onclick = () => {
            activeAnimation.name = animationName;
            attemptedAnimationSets.clear();
            syncUrl();
            playActiveAnimationFromStart();
            renderAnimationList();
            resetHealAttempts();
            applyStageAnchor();
            window.setTimeout(ensureVisibleContent, 150);
            window.setTimeout(ensureVisibleContent, 500);
            window.setTimeout(applyStageAnchor, 700);
          };
          animationMenu.appendChild(button);
        });
        if (previouslyRendered) {
          animationMenu.scrollTop = previousScrollTop;
          // Keep the user's scroll position unless the newly selected animation
          // would be clipped. In that case move only enough to reveal the active
          // row; never scroll the surrounding page or substitute another track.
          const selected = animationMenu.querySelector("button.active");
          if (selected && window.innerWidth > 1000) {
            const listBox = animationMenu.getBoundingClientRect();
            const selectedBox = selected.getBoundingClientRect();
            if (selectedBox.top < listBox.top) {
              animationMenu.scrollTop -= listBox.top - selectedBox.top;
            } else if (selectedBox.bottom > listBox.bottom) {
              animationMenu.scrollTop += selectedBox.bottom - listBox.bottom;
            }
          }
        } else if (window.innerWidth > 1000 && animationMenu.scrollHeight > animationMenu.clientHeight) {
          // On first load reveal the animation from the URL (often near the
          // bottom), without scrolling the surrounding page or player.
          const selected = animationMenu.querySelector("button.active");
          if (selected) {
            const listBox = animationMenu.getBoundingClientRect();
            const selectedBox = selected.getBoundingClientRect();
            animationMenu.scrollTop += selectedBox.top - listBox.top -
              (animationMenu.clientHeight - selectedBox.height) / 2;
          }
        }
      }
      function syncPreviewLike() {
        return;
      }
      playerElement.addEventListener("wheel", (event) => { event.preventDefault(); applyZoom(currentZoom.value + (event.deltaY > 0 ? -0.1 : 0.1)); }, { passive: false });
playerElement.addEventListener("touchstart", (event) => {
         if (event.touches.length === 2) {
           swipeStart.value = null;
           pinchDistance.value = touchDistance(event.touches);
           return;
         }
         if (event.touches.length === 1) {
           const touch = event.touches.item(0);
           swipeStart.value = touch ? { x: touch.clientX, y: touch.clientY, time: performance.now() } : null;
           touchPanPosition.value = touch ? { x: touch.clientX, y: touch.clientY } : null;
         }
       }, { passive: false });
       playerElement.addEventListener("touchmove", (event) => {
         if (event.touches.length === 2 && pinchDistance.value !== null) {
           event.preventDefault();
           const nextDistance = touchDistance(event.touches);
           applyZoom(currentZoom.value + (nextDistance - pinchDistance.value) / 220);
           pinchDistance.value = nextDistance;
         } else if (event.touches.length === 1 && touchPanPosition.value) {
           event.preventDefault();
           const touch = event.touches.item(0);
           if (!touch) return;
           const deltaX = touch.clientX - touchPanPosition.value.x;
           const deltaY = touch.clientY - touchPanPosition.value.y;
           touchPanPosition.value = { x: touch.clientX, y: touch.clientY };
           panByPixels(deltaX, deltaY);
         }
       }, { passive: false });
       playerElement.addEventListener("touchend", (event) => {
         pinchDistance.value = null;
         touchPanPosition.value = null;
         const start = swipeStart.value;
         swipeStart.value = null;
         if (!start || event.changedTouches.length !== 1) return;
         const touch = event.changedTouches.item(0);
         if (!touch) return;
         const deltaX = touch.clientX - start.x;
         const deltaY = touch.clientY - start.y;
         const elapsed = performance.now() - start.time;
         if (elapsed > 800 || Math.abs(deltaX) < 64 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return;
         navigateSibling(deltaX < 0 ? "next" : "previous");
       });
       playerElement.addEventListener("touchcancel", () => { pinchDistance.value = null; swipeStart.value = null; touchPanPosition.value = null; });
       playerElement.addEventListener("click", (event) => {
         if (event.target.closest(".spine-player-controls")) return;
         event.preventDefault();
         event.stopImmediatePropagation();
         if (event.button === 2) togglePlayback();
       }, true);
       playerElement.addEventListener("dblclick", (event) => {
         if (event.target.closest(".spine-player-controls")) return;
         event.preventDefault();
         event.stopImmediatePropagation();
       }, true);
       playerElement.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
       playerElement.addEventListener("mousedown", (event) => {
         if (event.button !== 0) return;
         event.preventDefault();
         event.stopImmediatePropagation();
         panPosition.value = { x: event.clientX, y: event.clientY };
       }, true);
       window.addEventListener("mousemove", (event) => { if (!panPosition.value) return; event.preventDefault(); event.stopImmediatePropagation(); const deltaX = event.clientX - panPosition.value.x, deltaY = event.clientY - panPosition.value.y; panPosition.value = { x: event.clientX, y: event.clientY }; panByPixels(deltaX, deltaY); }, { passive: false, capture: true });
       window.addEventListener("mouseup", (event) => { if (event.button !== 0) return; event.preventDefault(); event.stopImmediatePropagation(); panPosition.value = null; }, true);
      setSelect.onchange = () => { attemptedAnimationSets.clear(); activeSet.value = sets.find((set) => set.label === setSelect.value) || null; activeAnimation.name = activeSet.value?.animation || ""; animationNames.value = activeSet.value?.animations || []; syncSetInfo(); renderAnimationList(); syncUrl(); createPlayer(); };
      window.addEventListener("popstate", applySelectionFromUrl);
      // Compact download picker: Format -> Size -> Files, each step sliding
      // the track sideways. The user picks a format and a size, then either
      // grabs every animation in one click or takes them one by one.
      // Note: this whole script block lives inside a server-side template
      // literal, so it is written with plain string concatenation and never
      // uses nested template interpolation of its own.
      function installDownloadPicker() {
        var block = document.querySelector("[data-dl-block]");
        if (!block) return;
        var configNode = block.querySelector("[data-dl-config]");
        var config = {};
        try { config = JSON.parse(configNode ? configNode.textContent : "{}") || {}; } catch (error) { config = {}; }
        var files = config.files || {};
        var track = block.querySelector(".dl-track");
        var steps = Array.prototype.slice.call(block.querySelectorAll(".dl-step"));
        var statusText = block.querySelector("[data-dl-status-text]");
        var list = block.querySelector("[data-dl-list]");
        var formatLabels = { webm: "WebM", mp4: "MP4", mov: "MOV \u03b1", gif: "GIF \u03b1", png: "PNG seq \u03b1" };
        var widths = (config && config.widths) || {};
        var sizeLabels = {
          high: widths.high ? widths.high + "px" : "Original",
          medium: widths.medium ? widths.medium + "px" : "Medium",
          low: widths.low ? widths.low + "px" : "Small",
        };
        var chosen = { format: "", size: "" };
        var order = ["format", "size", "files"];
        var icon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0-12l4 4m-4-4-4 4M5 17v3h14v-3"/></svg>';

        function escapeText(value) {
          return String(value).replace(/[&<>"]/g, function (character) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character];
          });
        }
        function say(message) { if (statusText) statusText.textContent = message; }
        // Show how heavy the current selection is before the user commits to a
        // download. A HEAD request only reads Content-Length, so nothing is
        // transferred; the result is cached per URL so re-picking a size is free.
        var sizeCache = {};
        function formatMegabytes(bytes) {
          if (!bytes || bytes < 0) return "";
          return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
        }
        function measureSelection() {
          if (!chosen.format || !chosen.size) return;
          var urls = Object.keys(files).map(urlFor).filter(Boolean);
          if (!urls.length) return;
          var pending = urls.length;
          var total = 0;
          var known = 0;
          urls.forEach(function (url) {
            if (sizeCache[url] !== undefined) { total += sizeCache[url]; known += 1; if (--pending === 0) reportSelection(total, urls.length, true); return; }
            fetch(url, { method: "HEAD" }).then(function (response) {
              var length = Number(response.headers.get("content-length"));
              if (Number.isFinite(length) && length > 0) sizeCache[url] = length;
            }).catch(function () {}).then(function () {
              if (--pending === 0) reportSelection(total, urls.length, true);
            });
          });
        }
        function reportSelection(total, count, done) {
          if (!done || !total) return;
          var size = formatMegabytes(total);
          var label = (formatLabels[chosen.format] || "") + " " + (sizeLabels[chosen.size] || "");
          say(label + " \u00b7 " + count + " file" + (count === 1 ? "" : "s") + " \u00b7 " + size + " total");
        }
        function go(step) {
          if (track) track.setAttribute("data-dl-step", step);
          var at = order.indexOf(step);
          steps.forEach(function (button) {
            var position = order.indexOf(button.dataset.dlGoto);
            button.classList.toggle("is-active", position === at);
            button.classList.toggle("is-done", position < at);
            button.setAttribute("aria-selected", position === at ? "true" : "false");
          });
        }
        function urlFor(name) {
          var group = files[name];
          if (!group) return "";
          return group[chosen.format + "-" + chosen.size] || "";
        }
        function renderRows() {
          if (!list) return;
          Array.prototype.slice.call(list.querySelectorAll(".dl-row")).forEach(function (row) {
            var name = row.dataset.dlAnimation || "";
            var url = urlFor(name);
            var holder = row.querySelector(".dl-row-links");
            if (!holder) return;
            if (!url) {
              holder.innerHTML = '<span class="dl-mini is-empty">not available</span>';
              return;
            }
            var anchor = document.createElement("a");
            anchor.className = "dl-mini";
            anchor.href = url;
            anchor.download = "";
            anchor.rel = "noreferrer";
            anchor.innerHTML = icon;
            anchor.appendChild(document.createTextNode(" " + name));
            holder.innerHTML = "";
            holder.appendChild(anchor);
          });
        }

        steps.forEach(function (button) {
          button.addEventListener("click", function () { go(button.dataset.dlGoto); });
        });
        block.querySelectorAll("[data-dl-format]").forEach(function (chip) {
          chip.addEventListener("click", function () {
            chosen.format = chip.dataset.dlFormat || "";
            block.classList.add("has-format");
            block.querySelectorAll("[data-dl-format]").forEach(function (other) {
              other.classList.toggle("is-picked", other === chip);
            });
            say((formatLabels[chosen.format] || "Format") + " selected \u2014 pick a size");
            go("size");
          });
        });
        block.querySelectorAll("[data-dl-quality]").forEach(function (chip) {
          chip.addEventListener("click", function () {
            chosen.size = chip.dataset.dlQuality || "";
            block.querySelectorAll("[data-dl-quality]").forEach(function (other) {
              other.classList.toggle("is-picked", other === chip);
            });
            say((formatLabels[chosen.format] || "") + " " + (sizeLabels[chosen.size] || "") + " \u2014 checking size");
            renderRows();
            go("files");
            measureSelection();
          });
        });
        block.querySelectorAll("[data-dl-scope]").forEach(function (chip) {
          chip.addEventListener("click", function () {
            if (chip.dataset.dlScope === "one") {
              if (list) list.hidden = false;
              renderRows();
              say("Pick an animation below to download it");
              return;
            }
            var targets = Object.keys(files).map(urlFor).filter(Boolean);
            if (!targets.length) { say("No files for this combination"); return; }
            targets.forEach(function (url, index) {
              window.setTimeout(function () {
                var link = document.createElement("a");
                link.href = url;
                link.download = "";
                link.rel = "noreferrer";
                document.body.appendChild(link);
                link.click();
                link.remove();
              }, index * 320);
            });
            say("Downloading " + targets.length + " files");
          });
        });

        go("format");
      }
      renderSetList(); syncSetInfo(); renderOwnerCard(); installOwnerLibraryChaos(); installDownloadPicker(); syncPreviewLike(); syncLibraryNavigationButtons(); syncUrl(true); createPlayer(); renderAnimationList();
      const seoVideo = document.querySelector('.video-watch-player');
      if (seoVideo && seoVideo.getAttribute('autoplay') !== null) {
        seoVideo.muted = true;
        seoVideo.playsInline = true;
        seoVideo.load();
        seoVideo.play().catch(() => {});
      }
    </script>
    <script>window.SpineLinkMetricsConfig = { viewId: ${JSON.stringify(entryMetricId)} };</script>
    <script src="/spine-metrics.js" defer></script>
    <script src="/drop-handoff.js" defer></script>
  </body>
</html>`;
}

/** Безопасная вставка JSON в разметку: экранируем < и разделители строк,
 *  чтобы данные не сломали HTML и корректно читались парсером. */
function jsonScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function createVideoFallbackHtml({ origin, entry, ownerProfile, note, entryId, metrics, videoSeo, robots, playerUrl, archiveUrl }) {
  const title = cleanPublicText(entry?.title || entryId || 'Spine preview');
  const target = resolvePreviewTarget(entry, origin);
  const poster = entryImageAsset(target.poster || '', entry, 'poster');
  const video = target.url ? entryVideoAsset(target.url, entry, 'webm') : '';
  const ownerUrl = ownerProfile?.url || (entry?.publicOwnerId ? `${origin}/u/${encodeURIComponent(String(entry.publicOwnerId))}` : '/');
  const metricId = String(entryId || title);
  const metric = metricCountsForId(metrics, metricId);
  // Сетка работ автора под видео. Текущая работа из списка убираем,
  // чтобы не показывать её дважды.
  const currentEntryId = String(entry?.id || entryId || '');
  const authorWorks = (Array.isArray(ownerProfile?.library) ? ownerProfile.library : [])
    .filter((item) => String(item?.url || '') !== `${origin}/p/${encodeURIComponent(currentEntryId)}`)
    .map((item) => ({
      title: cleanPublicText(item?.title || 'Spine preview', 80),
      url: String(item?.url || '/'),
      poster: item?.thumbnailPoster || item?.thumbnail || '',
      video: item?.previewAnimation ? item?.webmPreview || '' : '',
      animations: Number(item?.animations) || 0,
    }))
    .filter((item) => item.video || item.poster);
  const authorWorksJson = jsonScript({ works: authorWorks });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${seoHead({ origin, entryId, video: videoSeo, fallbackTitle: `${title} - Spine-Link video preview`, robots, playerUrl, archiveUrl })}
    <link rel="stylesheet" href="/page-transitions.css" />
    <script src="/page-transitions.js" defer></script>
    <script src="/spine-embers.js?v=2026-09-30" defer></script>
    <style>
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; color: #edf5ff; background: #050607; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .page { display: grid; gap: 18px; width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 42px; }
      .topbar { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
      .brand { color: #ff6a28; font-weight: 950; letter-spacing: .16em; text-transform: uppercase; }
      .back { color: #b3ff40; font-weight: 800; text-decoration: none; }
      .video-card { overflow: hidden; border: 2px solid rgba(255,185,214,.72); border-radius: 8px; background: #111; box-shadow: 0 24px 80px rgba(0,0,0,.42); }
      video { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #000; }
      .video-placeholder { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000 center / cover no-repeat; }
      .body { display: grid; gap: 10px; padding: 18px; background: rgba(17,17,20,.86); }
      h1 { margin: 0; color: #fff; font-size: clamp(28px, 6vw, 48px); line-height: 1; }
      p { margin: 0; color: rgba(237,245,255,.72); font-size: 16px; line-height: 1.45; }
      .preview-like-button { justify-self: start; display: inline-flex; align-items: center; justify-content: center; gap: 0; width: 44px; height: 44px; aspect-ratio: 1; border: 1px solid rgba(255,185,214,.42); border-radius: 50%; white-space: nowrap; color: #ffe4ef; background: rgba(8,9,11,.68); cursor: pointer; }
      .preview-like-button span { font-size: 22px; transform: translateY(-1px); white-space: nowrap; }
      .preview-like-button strong { font-size: 14px; font-weight: 950; white-space: nowrap; }
      .preview-like-button.is-liked { border-color: rgba(255,118,171,.78); color: #ff76ab; background: rgba(255,118,171,.14); }
      .preview-view-count { display: inline-flex; align-items: center; gap: 8px; color: rgba(237,245,255,.72); font-size: 14px; font-weight: 850; }
      .preview-view-count strong { color: #fff; }
      /* Логотип ведёт на главную: «Spine» белая, «link» оранжевая,
         при наведении вся надпись белеет. */
      .brand { display: inline-flex; align-items: baseline; gap: 6px; color: #f7fbff; font-weight: 900; letter-spacing: .04em; text-decoration: none; }
      .brand-link-part { color: #ff6a28; }
      .brand:hover, .brand:focus-visible { color: #fff; }
      .brand:hover .brand-link-part, .brand:focus-visible .brand-link-part { color: #fff; }
      .brand:focus-visible { outline: 2px solid #ff6a28; outline-offset: 3px; border-radius: 4px; }
      /* Видео зациклено и перезапускается само, если браузер снял паузу. */
      .video-card video { width: 100%; display: block; background: #050607; }
      /* Сетка работ автора: каждая ячейка случайно показывает свою работу. */
      .author-works { margin-top: 22px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.1); }
      .author-works-title { margin: 0 0 12px; color: rgba(237,245,255,.72); font-size: 13px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
      .author-works-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(140px, 22vw, 240px), 1fr)); gap: 10px; }
      .author-works-empty { margin: 0; color: rgba(237,245,255,.5); font-size: 14px; }
      .author-work { position: relative; display: block; overflow: hidden; aspect-ratio: var(--work-ratio, 16 / 9); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: #050607; text-decoration: none; }
      .author-work:hover { border-color: rgba(179,255,64,.7); }
      .author-work img, .author-work video { width: 100%; height: 100%; object-fit: cover; }
      .author-work-label { position: absolute; right: 0; bottom: 0; left: 0; padding: 16px 10px 8px; color: #fff; background: linear-gradient(transparent, rgba(3,5,7,.86)); font-size: 12px; font-weight: 850; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
      @media (prefers-reduced-motion: reduce) { .author-work { content-visibility: auto; } }
      /* Server-rendered video is visible while Spine/WebGL initializes, for users and crawlers alike. */
      .preview-video-card { display: grid; gap: 10px; }
      .preview-video-card video { display: block; width: 100%; max-height: 260px; aspect-ratio: 16 / 9; object-fit: contain; border: 1px solid rgba(140,199,255,.2); border-radius: 6px; background: #000; }
      .player-frame > #preview-loading-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; z-index: 2; pointer-events: none; }
      .player-frame > #preview-loading-video[hidden] { display: none !important; }
      .player-frame > .library-nav-button { z-index: 3; }
    </style>
  </head>
  <body>
    <main class="page">
      <div class="topbar"><a class="brand" href="/" aria-label="Spine-Link home" title="На главную"><span class="brand-spine">Spine</span><span class="brand-link-part">link</span></a><a class="back" href="${ownerUrl}">Open portfolio</a></div>
      <section class="video-card">
        ${video
          ? "<video id=\"video-fallback-player\" src=\"".concat(escapeHtml(video)).concat("\"").concat(poster ? " poster=\"".concat(escapeHtml(poster)).concat("\"") : "").concat(" muted loop playsinline preload=\"metadata\" autoplay controls></video>")
          : "<div class=\"video-placeholder\" role=\"img\" aria-label=\"".concat(escapeHtml(title)).concat("\"").concat(poster ? " style=\"background-image:url(\'".concat(escapeHtml(poster)).concat("\')\"") : "").concat("></div>")}
        <div class="body">
          <h1>${title}</h1>
          ${note ? "<p>".concat(cleanPublicText(note, 240)).concat("</p>") : "<p>No preview video is available for this item yet.</p>"}
          <button class="preview-like-button" id="preview-like-button" type="button" data-metric-id="${escapeHtml(metricId)}" data-metric-like data-metric-current-likes="${metric.likes}" data-metric-current-views="${metric.views}" aria-pressed="false"><span data-metric-like-icon aria-hidden="true">♡</span><strong data-metric-likes>${metric.likes}</strong></button>
          <div class="preview-view-count" data-metric-id="${escapeHtml(metricId)}" data-metric-label="stats" aria-label="${metric.likes} likes and ${metric.views} views"><span aria-hidden="true">◉</span><strong data-metric-views>${metric.views}</strong><span>views</span></div>
        </div>
      </section>
      ${authorWorks.length
        ? "<section class=\"author-works\" aria-label=\"More work by ".concat(escapeHtml(ownerProfile?.name || 'this author')).concat("\">\n            <h2 class=\"author-works-title\">More work by ").concat(escapeHtml(ownerProfile?.name || 'this author')).concat("</h2>\n            <div class=\"author-works-grid\" id=\"author-works-grid\" data-works=\"'").concat(authorWorksJson).concat("'\'></div>\n          </section>")
        : ""}
    </main>
    <script>
      // Главное видео играет по кругу и само перезапускается,
      // если браузер остановил его из-за экономии энергии.
      const v = document.getElementById('video-fallback-player');
      if (v) {
        v.loop = true;
        v.muted = true;
        v.playsInline = true;
        v.addEventListener('ended', () => { v.currentTime = 0; v.play().catch(() => {}); });
        v.load();
        v.play().catch(() => {});
      }

      // Сетка работ автора: каждая ячейка показывает свою работу, а при
      // наведении переключается на следующую по случайному порядку.
      const grid = document.getElementById('author-works-grid');
      if (grid) {
        const works = (() => {
          try { return JSON.parse(grid.dataset.works || '{}').works || []; } catch { return []; }
        })();
        if (works.length) {
          const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          // По одной работе на ячейку, порядок перемешан.
          const shuffled = works
            .map((w) => ({ w, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map((item) => item.w);

          grid.textContent = '';
          shuffled.forEach((work) => {
            const cell = document.createElement('a');
            cell.className = 'author-work';
            cell.href = work.url;
            cell.setAttribute('aria-label', work.title);
            if (work.video) {
              const video = document.createElement('video');
              video.src = work.video;
              if (work.poster) video.poster = work.poster;
              video.muted = true;
              video.loop = true;
              video.playsInline = true;
              video.preload = 'none';
              video.setAttribute('aria-hidden', 'true');
              cell.appendChild(video);
              if (!reduceMotion) {
                // Запуск в случайный момент: сетка выглядит живой,
                // но не грузит всё видео разом.
                const delay = 400 + Math.random() * 2600;
                const play = () => {
                  if (video.readyState >= 2) { video.play().catch(() => {}); return; }
                  video.addEventListener('loadeddata', () => video.play().catch(() => {}), { once: true });
                  video.load();
                };
                setTimeout(play, delay);
              }
            } else if (work.poster) {
              const img = document.createElement('img');
              img.src = work.poster;
              img.alt = '';
              img.loading = 'lazy';
              cell.appendChild(img);
            }
            const label = document.createElement('span');
            label.className = 'author-work-label';
            label.textContent = work.title;
            cell.appendChild(label);
            grid.appendChild(cell);
          });
        }
      }
    </script>
    <script>window.SpineLinkMetricsConfig = { viewId: ${JSON.stringify(metricId)} };</script>
    <script src="/spine-metrics.js" defer></script>
    <script src="/drop-handoff.js" defer></script>
  </body>
</html>`;
}

async function createDynamicPreview(settings, uploadPath, origin, knownEntryRecord = undefined) {
  const sets = [];
  let note = '';
  let ownerProfile = null;
  let entry = null;
  let exclusions = { rules: [] };
  const pathParts = cleanRepoPath(uploadPath).split('/').filter(Boolean);
  let indexPath = joinRepoPath(pathParts.slice(0, -1).join('/'), 'index.json');
  const metricsPath = joinRepoPath(settings.basePath || defaultBasePath, 'metrics.json');
  const exclusionsPath = joinRepoPath(settings.basePath || defaultBasePath, 'archive-exclusions.json');
  const uploadId = pathParts[pathParts.length - 1] || '';
  const entryId = uploadId || uploadPath;
  let entries = [];
  let metrics = {};
  // Legacy works keep assets at repository root while their entry lives in a
  // library collection. Asset location cannot determine the metadata index.
  const entryRecord = knownEntryRecord === undefined
    ? await resolveEntryRecord(settings, uploadId)
    : knownEntryRecord;
  if (entryRecord) {
    indexPath = joinRepoPath(entryRecord.basePath, 'index.json');
    entry = entryRecord.entry;
    entries = entryRecord.entries;
  }

  const setDirectories = await findSpineSetDirectories(settings, uploadPath, 3, entry);
  for (const directory of setDirectories) {
    const items = Array.isArray(directory.items) ? directory.items : await githubList(settings, directory.path);
    const skeleton = selectSpineRuntimeSkeleton(items.filter(item => item.type === 'file'),
      items.find(item => item.type === 'file' && isAtlas(item.name))?.name);
    const atlas = items.find((item) => item.type === 'file' && isAtlas(item.name));
    const textures = items.filter((item) => item.type === 'file' && isImage(item.name));
    if (!skeleton || !atlas || textures.length === 0) continue;

    let skeletonJson = null;
    let skeletonVersion = '';
    let skeletonIsBinary = /\.(?:skel|bytes)$/i.test(skeleton.name);
    const atlasText = await githubText(settings, atlas.path);
    // This is a text atlas, never binary; do not interpret control bytes as
    // texture filenames and leak corrupted URLs into the browser.
    if (!isValidSpineAtlasHeader(atlasText)) {
      console.warn('SPINE_ATLAS_INVALID_TEXT');
      continue;
    }
    if (skeleton.name.toLowerCase().endsWith('.json')) {
      try {
        skeletonJson = sanitizeSkeletonData(JSON.parse(await githubText(settings, skeleton.path)));
        skeletonVersion = typeof skeletonJson?.skeleton?.spine === 'string' ? skeletonJson.skeleton.spine : '';
      } catch {
        skeletonJson = null;
        // Some uploads contain genuine Spine binary data with a .json suffix.
        // Detect the binary header instead of telling Spine Player to JSON.parse it.
        const binaryVersion = spineBinaryVersionFromBase64(await githubFileHead(settings, skeleton.path, 256));
        if (binaryVersion) {
          skeletonVersion = binaryVersion;
          skeletonIsBinary = true;
        }
      }
    } else if (skeletonIsBinary) {
      skeletonVersion = spineBinaryVersionFromBase64(await githubFileHead(settings, skeleton.path, 256));
    }

    const runtimeAnimationNames = animationNamesFromJson(skeletonJson);
    // Binary .skel files cannot be enumerated server-side as JSON. The public
    // index already stores the exact animation names for this work; pass them
    // to Spine Player so its selectable-animation validation does not receive
    // an empty list and reject a valid indexed default animation.
    const indexedAnimationNames = Array.isArray(entry?.animations)
      ? entry.animations.filter((name) => typeof name === 'string' && name.trim())
      : [];
    const animations = runtimeAnimationNames.length
      ? runtimeAnimationNames
      : skeleton.name.toLowerCase().endsWith('.skel')
        ? indexedAnimationNames
        : runtimeAnimationNames;
    const skinNames = skinNamesFromSkeletonJson(skeletonJson);
    const atlasPages = extractAtlasPages(atlasText);
    // Historical Spine 3.8 exports can reference DXT5 .dds page files.
    // Those original assets remain immutable; /assets/...dds decodes them
    // on demand to PNG for the web player.
    const textureUrls = atlasPages.map((pageName) => {
      const matchedTexture =
        textures.find((texture) => imageMatchesAtlasPage(texture.name, pageName)) ??
        (textures.length === 1 ? textures[0] : null);
      return matchedTexture ? versionedAssetUrl(origin, matchedTexture, matchedTexture.sha) : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5U9WcAAAAASUVORK5CYII=';
    });
    const defaultAnimation = typeof entry?.defaultAnimation === 'string' ? entry.defaultAnimation : '';
    const runtimeVersionOverride = runtimeVersionOverrideForSpineSkeleton(skeletonVersion, skeletonIsBinary);

    const assetVersion = [
      skeleton.sha,
      atlas.sha,
      ...textures.map((texture) => texture.sha),
      ...(atlasPages.some((page) => /\.dds$/i.test(page)) ? ['dds-png-v1'] : []),
      ...(runtimeVersionOverride === '3.8' || /^3\.8\./.test(skeletonVersion) ? ['spine38-runtime-compat-v2'] : []),
    ].filter(Boolean).join('-');

    // Version the skeleton JSON/binary as well as atlas pages and textures.
    // Without this query, replacing a broken export at the same path can leave
    // the old cached binary in the browser even after GitHub has the new JSON.
    const skeletonUrl = versionedAssetUrl(origin, skeleton, assetVersion);
    const atlasUrlBase = versionedAssetUrl(origin, atlas, assetVersion);
    // Spine 3.8 predates the pma page field; the asset route strips it for 3.8 only.
    const atlasUrl = runtimeVersionOverride === '3.8' || /^3\.8\./.test(skeletonVersion)
      ? `${atlasUrlBase}&spineRuntime=3.8`
      : atlasUrlBase;
    sets.push({
      label: directory.name,
      skeleton: skeletonUrl,
      ...(skeletonIsBinary ? { skelUrl: skeletonUrl } : { jsonUrl: skeletonUrl }),
      atlas: atlasUrl,
      atlasUrl,
      animation: defaultAnimation,
      animations,
      skeletonVersion,
      runtimeVersionOverride,
      textures: textureUrls,
      skin: preferredSkinName(skinNames),
      premultipliedAlpha: hasPremultipliedAlpha(atlasText),
      viewport: entry?.layout && Number.isFinite(Number(entry.layout.width)) && Number(entry.layout.width) > 0
        ? {
            __locked: true,
            x: Number(entry.layout.x) || 0,
            y: Number(entry.layout.y) || 0,
            width: Number(entry.layout.width),
            height: Number(entry.layout.height) || 1,
            padLeft: Number.isFinite(Number(entry.layout.padLeft)) ? Number(entry.layout.padLeft) : 0,
            padRight: Number.isFinite(Number(entry.layout.padRight)) ? Number(entry.layout.padRight) : 0,
            padTop: Number.isFinite(Number(entry.layout.padTop)) ? Number(entry.layout.padTop) : 0,
            padBottom: Number.isFinite(Number(entry.layout.padBottom)) ? Number(entry.layout.padBottom) : 0,
          }
        : viewportFromJson(skeletonJson)
          ? { ...viewportFromJson(skeletonJson), padLeft: PREVIEW_PAD, padRight: PREVIEW_PAD, padTop: PREVIEW_PAD, padBottom: PREVIEW_PAD }
          : { padLeft: PREVIEW_PAD, padRight: PREVIEW_PAD, padTop: PREVIEW_PAD, padBottom: PREVIEW_PAD },
    });
  }

  try {
    const [metricsText, exclusionsText] = await Promise.all([
      metricsPath ? githubText(settings, metricsPath) : '',
      exclusionsPath ? githubText(settings, exclusionsPath) : '',
    ]);
    metrics = parseMetricsJson(metricsText);
    exclusions = exclusionsText ? JSON.parse(exclusionsText) : { rules: [] };
    if (!entryRecord) {
      const indexText = indexPath ? await githubText(settings, indexPath) : '';
      entries = indexText ? JSON.parse(indexText) : [];
      entry = Array.isArray(entries)
        ? entries.find((item) => item?.id === uploadId || cleanRepoPath(item?.previewPath || '') === cleanRepoPath(uploadPath))
        : null;
    }
    note = String(entry?.note || '').trim();
    if (entry?.showOwnerLibrary) {
      const ownerEmail = String(entry?.ownerEmail || '').toLowerCase();
      const ownerAnonId = String(entry?.ownerAnonId || '').toLowerCase();
      const ownerEntries = Array.isArray(entries)
        ? entries.filter((item) => {
            const itemEmail = String(item?.ownerEmail || '').toLowerCase();
            const itemAnonId = String(item?.ownerAnonId || '').toLowerCase();
            const sameOwner = (ownerEmail && itemEmail === ownerEmail) || (ownerAnonId && itemAnonId === ownerAnonId);
            return sameOwner && item?.showOwnerLibrary;
          })
        : [];
      ownerEntries.sort(compareLibraryEntries);
      const ownerLibraryItems = ownerEntries.map((item) => {
        const target = resolvePreviewTarget(item, origin);
        // The owner library is a dense strip of thumbnails that autoplays several
        // clips at once, so the cards use the LOW (360p) WebM. The full-quality
        // clip stays on the page's big video preview below the player.
        const lowWebm = target.lowUrl ? entryVideoAsset(target.lowUrl, item, 'webm') : '';
        return {
          title: cleanPublicText(item?.title || item?.id || 'Spine preview'),
          url: `${origin}/p/${encodeURIComponent(String(item?.id || '').trim())}`,
          thumbnail: item?.thumbnailType === 'gif' || /^data:image\/gif;base64,/i.test(String(item?.thumbnail || '')) ? '' : entryImageAsset(item?.thumbnail || '', item, 'thumbnail'),
          thumbnailPoster: entryImageAsset(target.poster || '', item, 'poster'),
          webmPreview: lowWebm,
          webmPreviewFull: target.url ? entryVideoAsset(target.url, item, 'webm') : '',
          previewDuration: target.url && Number.isFinite(target.duration) && target.duration > 0 ? target.duration : undefined,
          previewAnimation: target.name || '',
          thumbnailType: '',
          animations: Array.isArray(item?.animations) ? item.animations.length : 0,
        };
      });
      ownerProfile = {
        id: entry.ownerAnonId || entry.publicOwnerId || "",
        visible: true,
        name: cleanPublicText(entry.ownerName || ownerEmail.split('@')[0] || 'anonim'),
        picture: safePublicImage(entry.ownerPicture || ''),
        subtitle: `${ownerEntries.length} SPINE WORK'S`,
        url: entry.publicOwnerId ? `${origin}/u/${encodeURIComponent(String(entry.publicOwnerId))}` : '',
        library: ownerLibraryItems.slice(0, 6),
        navigation: ownerLibraryItems.map((item) => ({ title: item.title, url: item.url })),
      };
    }
  } catch {
    note = '';
  }
  const publicArchiveEntry = isPublicArchiveEntry(entry, exclusions);
  const playerUrl = publicArchiveEntry ? playerUrlForEntry(origin, entry, entryId) : pageUrlForEntry(origin, entryId);
  const archiveUrl = publicArchiveEntry ? archiveUrlForEntry(origin, entry, entryId) : '';
  const canonicalUrl = publicArchiveEntry ? playerUrl : '';
  const robots = entry && (entry.hiddenFromPublicLibrary === true || entryExcludedFromArchive(entry, exclusions))
    ? 'noindex,follow'
    : 'index,follow,max-image-preview:large,max-video-preview:-1,max-snippet:-1';
  const video = videoMetadataForEntry(origin, entry, entryId, note, canonicalUrl, playerUrl);
  if (sets.length === 0 && entry?.sourceKind === 'spine-project') {
    // A .spine editor project cannot run in spine-player. Do not display the
    // misleading video fallback until the licensed CLI has exported runtime
    // JSON, atlas and textures. The permanent link is available immediately.
    const status = String(entry?.conversionStatus || 'pending');
    const waiting = status === 'pending' || status === 'running';
    const projectFile = String(entry?.projectFile || 'project.spine');
    const download = `${origin}/assets/${encodeRepoPath(joinRepoPath(uploadPath, projectFile))}`;
    const message = waiting
      ? 'Project uploaded. Waiting for Spine Editor 4.3.26 export.'
      : status === 'ready'
        ? 'Spine export is marked ready, but its runtime assets were not found.'
        : 'Automatic Spine Editor export is not configured or failed. The source project and images have been preserved.';
    const title = escapeHtml(cleanPublicText(entry?.title || entryId || 'Spine project'));
    return {
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Spine-Link</title>
<meta name="robots" content="noindex,follow">
${waiting ? '<meta http-equiv="refresh" content="15">' : ''}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08131d;color:#ecffff;font:16px/1.5 system-ui}main{max-width:570px;padding:32px;border:1px solid #41646b;border-radius:18px;background:#0b202d}a{color:#76e9d4}small{color:#a0b9c0}h1{font-size:25px}</style>
</head><body><main><p><a href="/">Spine-Link</a></p><h1>${title}</h1>
<p>${escapeHtml(message)}</p>
<p><small>Source: ${escapeHtml(projectFile)} + images/</small></p>
<p><a href="${escapeHtml(download)}">Download original .spine</a></p>
${waiting ? '<small>This page will refresh when the editor export finishes.</small>' : '<small>Only licensed Spine Editor can export a project to playable JSON/SKEL and atlas.</small>'}
</main></body></html>`,
      robots: 'noindex,follow',
    };
  }
  if (sets.length === 0) {
    return {
      html: createVideoFallbackHtml({ origin, entry, ownerProfile, note, entryId, metrics, videoSeo: video, robots, playerUrl, archiveUrl }),
      robots,
    };
  }
  return {
    html: createHtml({ sets, note, ownerProfile, entryId, entry, origin, video, metrics, robots, playerUrl, archiveUrl }),
    robots,
  };
}

// Finds the folder of a work by id across every library collection, so /p/<id>
// keeps working while rotations move works between folders.
async function resolveEntryRecord(settings, entryId) {
  const id = cleanRepoPath(entryId).split('/').pop() || '';
  if (!id) return null;
  const basePaths = await libraryCollectionPaths(settings);
  for (let index = 0; index < basePaths.length; index++) {
    const basePath = basePaths[index];
    try {
      const indexPath = `${basePath}/index.json`;
      const lookupPath = previewIndexPath(basePath, id);
      // library_01's full historical index is ~20 MB. Resolve those older
      // works through a compact first-character shard so a cold Vercel
      // invocation never downloads and reparses the entire archive.
      let indexText = await githubText(settings, lookupPath, { ttlMs: 60_000, preferRaw: true });
      if (!indexText && basePath === 'library_01') {
        // Preserve a safe fallback for legacy entries that predate the shards,
        // without fetching the oversized historical index.
        const directPath = joinRepoPath(basePath, id);
        const directItems = await githubList(settings, directPath);
        if (directItems.length) {
          const files = directItems
            .filter((item) => item?.type === 'file')
            .map((item) => cleanRepoPath(item.path || joinRepoPath(directPath, item.name)))
            .filter((file) => file && (isSkeleton(file) || isAtlas(file) || isImage(file)));
          const entry = { id, previewPath: directPath, files, showOwnerLibrary: false };
          return { previewPath: directPath, entry, entries: [entry], basePath };
        }
        continue;
      }
      let entries = indexText ? JSON.parse(indexText) : [];
      if (!Array.isArray(entries)) entries = [];
      let match = entries.find((entry) => String(entry?.id || '') === id);

      // A just-published work may not be present in the cached newest index.
      if (!match && index === 0) {
        indexText = await githubText(settings, lookupPath, {
          ttlMs: 0,
          preferRaw: true,
          cacheBust: true,
        });
        entries = indexText ? JSON.parse(indexText) : [];
        if (!Array.isArray(entries)) entries = [];
        match = entries.find((entry) => String(entry?.id || '') === id);
      }

      const previewPath = cleanRepoPath(match?.previewPath || '');
      if (previewPath) return { previewPath, entry: match, entries, basePath };
    } catch (error) {
      // One legacy/corrupt/oversized index must never hide newer previews.
      console.warn('[preview] collection lookup failed:', basePath, String(error));
    }
  }

  // Three older public works were preserved in the immutable pre-rotation
  // index and their files now live under library_01/<id>. The archive feed
  // already restores these records; mirror that lookup here so /p/<id> works
  // as well. Keep this allowlist narrow so normal misses never fetch a 2 MB
  // historical index.
  const recoveredIds = new Set([
    '1036_1-2026-07-24T21-06-04-535Z',
    '8000021-2026-07-02T04-52-57-380Z',
    '8000021-2026-07-02T04-43-24-403Z',
  ]);
  if (!recoveredIds.has(id)) return null;
  try {
    const recoveredRef = 'f4e51c6c420d4ff1f4d2028c12492b04153cc862';
    const snapshotBase = cleanRepoPath(settings.basePath || 'library');
    const snapshotText = await githubText(
      { ...settings, branch: recoveredRef },
      `${snapshotBase}/index.json`,
      { ttlMs: 60000 },
    );
    const recoveredEntries = snapshotText ? JSON.parse(snapshotText) : [];
    if (!Array.isArray(recoveredEntries)) return null;
    const restoreEntry = (entry) => {
      const entryId = String(entry?.id || '');
      const oldPath = cleanRepoPath(entry?.previewPath || '');
      const newPath = `library_01/${entryId}`;
      const rewrite = (value) => {
        if (typeof value === 'string') return oldPath ? value.replaceAll(oldPath, newPath) : value;
        if (Array.isArray(value)) return value.map(rewrite);
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
        }
        return value;
      };
      return { ...rewrite(entry), previewPath: newPath };
    };
    const restoredEntries = recoveredEntries
      .filter((entry) => recoveredIds.has(String(entry?.id || '')))
      .map(restoreEntry);
    const match = restoredEntries.find((entry) => String(entry?.id || '') === id);
    if (match?.previewPath) {
      return {
        previewPath: match.previewPath,
        entry: match,
        entries: restoredEntries,
        basePath: 'library_01',
      };
    }
  } catch (error) {
    console.warn('[preview] legacy recovery lookup failed:', id, String(error));
  }
  return null;
}

// The asset directory is a durable source of truth even when an index write
// is delayed or temporarily unreadable. Verify actual Spine files are present
// rather than returning "Preview not found" for an otherwise valid upload.
async function findDirectPreviewPath(settings, entryId) {
  const id = cleanRepoPath(entryId);
  if (!/^[a-z0-9._-]{3,180}$/i.test(id) || id === '.' || id === '..') return '';
  for (const basePath of await libraryCollectionPaths(settings)) {
    const candidate = joinRepoPath(basePath, id);
    try {
      const items = await githubList(settings, candidate);
      if (items.some((file) => file?.type === 'file' && isSkeleton(file.name)) &&
          items.some((file) => file?.type === 'file' && isAtlas(file.name)) &&
          items.some((file) => file?.type === 'file' && isImage(file.name))) {
        return candidate;
      }
    } catch {
      // Keep looking; the work may have moved to a different collection.
    }
  }
  return '';
}

async function resolveEntryPath(settings, entryId) {
  return (await resolveEntryRecord(settings, entryId))?.previewPath ||
    (await findDirectPreviewPath(settings, entryId));
}

function sendPreviewUnavailable(response) {
  setNoStoreHeaders(response);
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Retry-After', '30');
  return response.status(503).send('Preview temporarily unavailable');
}

export default async function handler(request, response) {
  setNoStoreHeaders(response);
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    return response.status(405).send('Method not allowed');
  }

  const token = process.env.GITHUB_TOKEN || '';
  const owner = process.env.GITHUB_OWNER || defaultOwner;
  const repo = process.env.GITHUB_REPO || defaultRepo;
  if (!canReadPublicSpineWithoutToken(token, owner, repo)) {
    console.error('[preview] private repository access is not configured');
    return sendPreviewUnavailable(response);
  }

  const settings = {
    owner,
    repo,
    branch: process.env.GITHUB_BRANCH || defaultBranch,
    basePath: cleanRepoPath(process.env.GITHUB_BASE_PATH || defaultBasePath),
    token,
  };

  // Entry discovery also performs remote GitHub requests. Keep it inside the
  // handler boundary so rejected fetches/timeouts become an HTTP response
  // instead of an unhandled Vercel FUNCTION_INVOCATION_FAILED.
  try {
    let path = cleanRepoPath(request.query?.path || '');
  let entryRecord;
  if (!path) {
    const entryId = cleanRepoPath(request.query?.entry || '');
    if (!entryId) return response.status(400).send('Invalid preview path');
    entryRecord = await resolveEntryRecord(settings, entryId);
    path = entryRecord?.previewPath || await findDirectPreviewPath(settings, entryId);
    if (!path) return response.status(404).send('Preview not found');
  }
  const origin = `${request.headers['x-forwarded-proto'] || 'https'}://${request.headers['x-forwarded-host'] || request.headers.host}`;

    let html = '';
    let robotsHeader = 'index,follow,max-image-preview:large,max-video-preview:-1,max-snippet:-1';
    if (path.endsWith('.html')) {
      html = await githubText(settings, path);
      if (!html) return response.status(404).send('Preview not found');
    } else {
      const preview = await createDynamicPreview(settings, path, origin, entryRecord);
      html = preview.html;
      robotsHeader = preview.robots;
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('X-Robots-Tag', robotsHeaderValue(robotsHeader));
    if (request.method === 'HEAD') {
      setNoStoreHeaders(response);
      return response.status(200).send('');
    }
    // Work pages must not survive deletion in a browser/CDN for minutes.
    // The assets can remain cacheable; the entry lookup is always fresh.
    setNoStoreHeaders(response);
    return response.status(200).send(html);
  } catch (error) {
    console.error('[preview] request failed:', error);
    if (response.headersSent) return response.end();
    return sendPreviewUnavailable(response);
  }
}

