const defaultOwner = 'vladleopold';
const defaultRepo = 'spine';
const defaultBranch = 'main';

function cleanRepoPath(value = '') {
  return String(value).trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
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
  const url = `${origin}/assets/${encodeRepoPath(item.path)}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

function base64ToText(base64) {
  return Buffer.from(String(base64).replace(/\s/g, ''), 'base64').toString('utf8');
}

function escapedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

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
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function safePublicVideo(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+\.webm(?:[?#][^\s"'<>]*)?$/i.test(url) ? url : '';
}

function generatedThumbnailUrl(origin, entry) {
  const id = String(entry?.id || '').trim();
  const poster = String(entry?.thumbnailPoster || '');
  return id && /^data:image\/webp;base64,/i.test(poster)
    ? `${origin}/assets/library/${encodeURIComponent(id)}/generated-preview.webp`
    : '';
}

function isoDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function pageUrlForEntry(origin, entryId) {
  return `${origin}/p/${encodeURIComponent(String(entryId || '').trim())}`;
}

function videoMetadataForEntry(origin, entry, entryId, note = '') {
  const id = String(entry?.id || entryId || '').trim();
  const contentUrl = safePublicVideo(entry?.webmPreview || '');
  const poster =
    safePublicImage(entry?.thumbnailPoster || '') ||
    generatedThumbnailUrl(origin, entry) ||
    safePublicImage(entry?.thumbnail || '');
  if (!id || !contentUrl || !poster) return null;
  const name = cleanPublicText(entry?.title || id || 'Spine animation preview', 110);
  const description =
    cleanPublicText(note || entry?.note || `${name} Spine animation video preview and interactive Spine web player on Spine-Link.`, 260) ||
    `${name} Spine animation video preview and interactive Spine web player on Spine-Link.`;
  return {
    id,
    name,
    description,
    thumbnailUrl: poster,
    contentUrl,
    embedUrl: pageUrlForEntry(origin, id),
    url: pageUrlForEntry(origin, id),
    uploadDate: isoDate(entry?.uploadedAt) || '2026-05-04T00:00:00.000Z',
  };
}

function seoHead({ origin, entryId, video, fallbackTitle = 'Spine-Link' }) {
  const title = video?.name ? `${video.name} - Spine animation video preview` : fallbackTitle;
  const description = video?.description || 'Spine-Link interactive Spine animation preview and Spine web viewer.';
  const url = video?.url || (entryId ? pageUrlForEntry(origin, entryId) : origin);
  const image = video?.thumbnailUrl || `${origin}/spine-link-video-thumbnail.png`;
  const structuredData = video
    ? {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name: video.name,
        description: video.description,
        thumbnailUrl: [video.thumbnailUrl],
        uploadDate: video.uploadDate,
        contentUrl: video.contentUrl,
        embedUrl: video.embedUrl,
        url: video.url,
        isFamilyFriendly: true,
        publisher: {
          '@type': 'Organization',
          name: 'Spine-Link',
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
  return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index,follow,max-image-preview:large,max-video-preview:-1" />
    <link rel="canonical" href="${escapeHtml(url)}" />
    <meta property="og:type" content="${video ? 'video.other' : 'website'}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:image" content="${escapeHtml(image)}" />${video ? `
    <meta property="og:video" content="${escapeHtml(video.contentUrl)}" />
    <meta property="og:video:secure_url" content="${escapeHtml(video.contentUrl)}" />
    <meta property="og:video:type" content="video/webm" />` : ''}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(image)}" />${structuredData ? `
    <script type="application/ld+json">${escapedJson(structuredData)}</script>
    <script type="application/ld+json">${escapedJson(imageStructuredData)}</script>` : ''}`;
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
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
  return /\.(png|jpe?g|webp)$/i.test(name);
}

function stem(name) {
  return name
    .replace(/\.atlas(?:\.txt|\.docx)?$/i, '')
    .replace(/\.(json|skel|png|jpe?g|webp)$/i, '');
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

function baseLikeCount(value = '') {
  let hash = 0;
  for (const character of String(value)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return 12 + (hash % 87);
}

async function githubJson(settings, path) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
  const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings.token),
  });
  if (!response.ok) return null;
  return response.json();
}

async function githubText(settings, path) {
  const data = await githubJson(settings, path);
  if (!data?.content) return '';
  return base64ToText(data.content);
}

async function githubList(settings, path) {
  const data = await githubJson(settings, path);
  return Array.isArray(data) ? data : [];
}

async function findSpineSetDirectories(settings, uploadPath, maxDepth = 3) {
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
      found.push({ name: cleanPath.split('/').pop() || cleanPath, path: cleanPath });
      return;
    }
    const directories = items.filter((item) => item.type === 'dir');
    for (const directory of directories) await visit(directory.path, depth + 1);
  }
  await visit(uploadPath, 0);
  return found;
}

function createHtml(config) {
  const video = config.video || null;
  const origin = config.origin || 'https://spine-link.vercel.app';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${seoHead({ origin, entryId: config.entryId, video, fallbackTitle: 'Spine-Link interactive Spine animation preview' })}
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.2.113/dist/spine-player.css" />
    <style>
      * { box-sizing: border-box; }
      * { scrollbar-width: thin; scrollbar-color: rgba(74,78,84,.72) transparent; }
      *::-webkit-scrollbar { width: 8px; height: 8px; }
      *::-webkit-scrollbar-track { background: transparent; }
      *::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: rgba(74,78,84,.72); background-clip: content-box; }
      *::-webkit-scrollbar-thumb:hover { background: rgba(100,106,115,.78); background-clip: content-box; }
      html, body, #app { width: 100%; height: 100%; margin: 0; }
      body { overflow: hidden; background: #000; color: #e7edf4; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .particle-field { position: fixed; inset: 0; z-index: 0; width: 100%; height: 100%; pointer-events: none; opacity: .78; }
      #app { position: relative; z-index: 1; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 18px; padding: 24px; background: rgba(0,0,0,.78); }
      .topbar { display: flex; justify-content: space-between; gap: 18px; align-items: center; }
      .brand-link { display: inline-block; color: inherit; text-decoration: none; }
      .brand-logo { display: inline-flex; align-items: center; gap: 8px; color: #fff; font-family: "Trebuchet MS", Inter, ui-sans-serif, system-ui, sans-serif; font-size: clamp(34px, 4.4vw, 58px); font-weight: 500; line-height: .78; letter-spacing: .18em; text-shadow: 0 0 1px rgba(255,255,255,.86), 0 6px 18px rgba(0,0,0,.42); }
      .brand-spine-mark { display: inline-grid; gap: 4px; width: 16px; margin: 0 -3px 0 -5px; transform: translateY(1px); }
      .brand-spine-mark i { display: block; width: 16px; height: 7px; border-radius: 999px; background: #ff5a1f; box-shadow: 0 0 8px rgba(255,90,31,.22); }
      .brand-spine-mark i:nth-child(1) { transform: translateX(-1px); }
      .brand-spine-mark i:nth-child(2) { width: 14px; transform: translateX(2px); }
      .brand-spine-mark i:nth-child(3) { width: 12px; transform: translateX(4px); }
      .brand-spine-mark i:nth-child(4) { width: 10px; transform: translateX(6px); }
      .brand-spine-mark i:nth-child(5) { width: 8px; transform: translateX(8px); }
      .brand-plus { margin-left: 8px; color: #ff6a28; font-size: .72em; font-weight: 800; letter-spacing: .22em; line-height: 1; text-transform: uppercase; transform: translate(-15px, .18em); }
      .brand-link:hover .brand-plus { color: #8cc7ff; }
      .stage { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 18px; }
      .player-frame { position: relative; min-width: 0; min-height: 0; }
      #player { width: 100%; height: 100%; min-height: 0; touch-action: none; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; overflow: hidden; background: conic-gradient(#565656 25%, #505052 0 50%, #565656 0 75%, #505052 0); background-size: var(--preview-pattern-size, 140px) var(--preview-pattern-size, 140px); }
      .library-nav-button { position: absolute; top: 50%; z-index: 8; display: grid; place-items: center; width: 52px; min-height: 78px; padding: 0; border: 1px solid rgba(140,199,255,.55); border-radius: 8px; color: #f7fbff; background: rgba(9,13,17,.68); box-shadow: 0 16px 34px rgba(0,0,0,.38), inset 0 0 22px rgba(140,199,255,.08); font-size: 42px; font-weight: 800; line-height: 1; transform: translateY(-50%); backdrop-filter: blur(10px); }
      .library-nav-button:hover { border-color: rgba(179,255,64,.78); background: rgba(23,31,18,.78); }
      .library-nav-button:disabled { display: none; }
      .library-nav-button--prev { left: 14px; }
      .library-nav-button--next { right: 14px; }
      #sidebar { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 14px; padding-right: 2px; }
      .preview-card { padding: 16px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(255,255,255,.05); box-shadow: 0 18px 40px rgba(0,0,0,.18); }
      .section-title { margin: 0 0 10px; color: #f7fbff; font-size: 13px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
      .seo-video-card { display: none; }
      .seo-video-card.is-visible { display: block; }
      .seo-video-preview { display: block; width: 100%; aspect-ratio: 16 / 9; border: 1px solid rgba(140,199,255,.22); border-radius: 8px; object-fit: cover; background: #030405; }
      .preview-like-button { display: inline-flex; align-items: center; justify-content: center; gap: 9px; width: 100%; min-height: 44px; border: 1px solid rgba(255,185,214,.42); border-radius: 999px; color: #ffe4ef; background: rgba(8,9,11,.68); box-shadow: 0 12px 30px rgba(0,0,0,.22); cursor: pointer; }
      .preview-like-button span { color: currentColor; font-size: 22px; line-height: 1; transform: translateY(-1px); }
      .preview-like-button strong { color: currentColor; font-size: 14px; font-weight: 950; line-height: 1; }
      .preview-like-button.is-liked { border-color: rgba(255,118,171,.78); color: #ff76ab; background: rgba(255,118,171,.14); }
      select, button { width: 100%; }
      select { min-height: 48px; padding: 0 12px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: #e7edf4; background: #1a2027; }
      button { min-height: 38px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; color: rgba(231,237,244,.86); background: rgba(255,255,255,.045); cursor: pointer; }
      button.active, button:hover { border-color: rgba(140,199,255,.82); color: #fff; background: rgba(71,156,255,.22); }
      #animation-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 8px; }
      .note-text { margin: 0; color: rgba(231,237,244,.88); font-size: 16px; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
      .note-card:empty { display: none; }
      .owner-card { display: none; gap: 14px; }
      .owner-card.is-visible { display: grid; }
      .owner-profile { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .owner-avatar { width: 46px; height: 46px; border: 1px solid rgba(255,255,255,.14); border-radius: 50%; object-fit: cover; background: rgba(255,255,255,.08); }
      .owner-avatar-fallback { display: grid; place-items: center; color: #111; font-weight: 900; background: #b3ff40; }
      .owner-profile-text { display: flex; flex: 1 1 auto; align-items: baseline; gap: 40px; min-width: 0; max-width: 100%; flex-wrap: wrap; }
      .owner-profile strong, .owner-profile span { white-space: nowrap; }
      .owner-profile strong { flex: 0 1 auto; min-width: 0; color: #fff; font-size: 16px; overflow-wrap: anywhere; }
      .owner-profile span { flex: 0 0 auto; color: rgba(231,237,244,.62); font-size: 12px; }
      .owner-library { display: none; gap: 10px; }
      .owner-library.is-visible { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); align-items: stretch; }
      .owner-library a { position: relative; display: block; overflow: hidden; min-height: 154px; border: 1px solid rgba(255,255,255,.09); border-radius: 8px; color: inherit; text-decoration: none; background: rgba(255,255,255,.045); isolation: isolate; }
      .owner-library a::after { content: ""; position: absolute; inset: 0; z-index: 1; background: linear-gradient(rgba(0,0,0,.18), rgba(0,0,0,.18) 45%, rgba(8,10,12,.82)); pointer-events: none; }
      .owner-library a:hover { border-color: rgba(179,255,64,.55); background: rgba(179,255,64,.08); transform: translateY(-2px); }
      .owner-thumb { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; border-radius: 0; object-fit: cover; background: rgba(255,255,255,.08); transform: scale(1.08); transform-origin: center; }
      .owner-library a > div { position: absolute; right: 10px; bottom: 10px; left: 10px; z-index: 2; display: grid; gap: 3px; min-width: 0; }
      .owner-library strong, .owner-library span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .owner-library strong { color: #fff; font-size: 13px; text-shadow: 0 2px 12px rgba(0,0,0,.75); }
      .owner-library span { color: rgba(231,237,244,.7); font-size: 11px; }
      .page-transition { position: fixed; inset: 0; z-index: 80; overflow: hidden; pointer-events: none; }
      .page-transition::before { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 50% 46%, rgba(140,199,255,.24), transparent 28%), radial-gradient(circle at 50% 52%, rgba(255,185,214,.2), transparent 34%), rgba(2,4,7,.34); animation: transitionWash 720ms cubic-bezier(.18,.86,.26,1) both; backdrop-filter: blur(2px); }
      .page-transition-card { position: fixed; top: var(--transition-top); left: var(--transition-left); width: var(--transition-width); height: var(--transition-height); overflow: hidden; border: 2px solid rgba(255,185,214,.86); border-radius: 8px; background: linear-gradient(rgba(7,9,12,.18), rgba(7,9,12,.46)), var(--transition-image, radial-gradient(circle at 50% 42%, rgba(255,185,214,.28), transparent 34%)), radial-gradient(circle at 50% 48%, rgba(140,199,255,.22), rgba(0,0,0,.92)); background-position: center; background-size: cover; box-shadow: 0 0 0 1px rgba(255,255,255,.12), 0 30px 90px rgba(0,0,0,.54), 0 0 70px rgba(140,199,255,.32); animation: transitionCardPortal 720ms cubic-bezier(.18,.86,.26,1) both; }
      .page-transition-card::before { content: ""; position: absolute; inset: 0; background: linear-gradient(110deg, transparent 0 34%, rgba(255,255,255,.42) 48%, transparent 62% 100%); animation: transitionShine 720ms ease both; }
      .page-transition-card span { position: absolute; right: 18px; bottom: 16px; left: 18px; z-index: 1; overflow: hidden; color: #fff; font-size: clamp(24px,5vw,56px); font-weight: 950; line-height: .96; text-overflow: ellipsis; text-shadow: 0 4px 26px rgba(0,0,0,.82); white-space: nowrap; animation: transitionTitle 720ms ease both; }
      .page-transition-ring { position: absolute; inset: 0; display: grid; place-items: center; }
      .page-transition-ring i { position: absolute; width: 16vmin; height: 16vmin; border: 1px solid rgba(140,199,255,0); border-radius: 999px; animation: transitionRing 720ms ease-out both; }
      .page-transition-ring i:nth-child(2) { animation-delay: 90ms; }
      .page-transition-ring i:nth-child(3) { animation-delay: 170ms; }
      @keyframes transitionCardPortal { 0% { opacity: .98; transform: scale(1); } 58% { top: max(22px, 9vh); left: max(22px, 8vw); width: min(84vw, 980px); height: min(74vh, 720px); opacity: 1; transform: scale(1.015); } 100% { top: 0; left: 0; width: 100vw; height: 100vh; opacity: 0; border-radius: 0; transform: scale(1.04); } }
      @keyframes transitionWash { 0% { opacity: 0; } 48% { opacity: 1; } 100% { opacity: .82; } }
      @keyframes transitionShine { 0% { opacity: 0; transform: translateX(-80%); } 42% { opacity: 1; } 100% { opacity: 0; transform: translateX(82%); } }
      @keyframes transitionTitle { 0% { opacity: 0; transform: translateY(16px); } 38% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-18px); } }
      @keyframes transitionRing { 0% { opacity: 0; border-color: rgba(140,199,255,0); transform: scale(.4); } 36% { opacity: .9; border-color: rgba(179,255,64,.42); } 100% { opacity: 0; border-color: rgba(140,199,255,0); transform: scale(7); } }
      @media (max-width: 760px) { * { scrollbar-width: none; } *::-webkit-scrollbar { width: 0; height: 0; display: none; } body { overflow: auto; } #app { height: auto; min-height: 100%; padding: 16px; } .stage { grid-template-columns: 1fr; } .player-frame { height: 60vh; min-height: 360px; } #player { width: 100%; height: 100%; min-height: 0; } .library-nav-button { display: none; } .topbar { align-items: flex-start; flex-direction: column; } }
      .spine-link-loop-button { position: relative; margin-right: 12px !important; }
      .spine-player-controls { z-index: 4; }
      .spine-player-controls.spine-player-controls-hidden { pointer-events: auto; opacity: 1; }
      .spine-link-loop-button::before, .spine-link-loop-button::after { position: absolute; inset: 0; display: grid; place-items: center; font-size: 30px; font-weight: 900; line-height: 1; }
      .spine-link-loop-button.is-on::before { content: "↻"; color: #54cfff; text-shadow: 0 0 14px rgba(84, 207, 255, 0.72); transform: translateY(-1px); }
      .spine-link-loop-button.is-off::before { content: "↻"; color: rgba(210, 216, 222, 0.42); transform: translateY(-1px); }
      .spine-link-loop-button.is-off::after { content: none; }
    </style>
  </head>
  <body>
    <canvas class="particle-field" id="particle-field" aria-hidden="true"></canvas>
    <div id="app">
      <header class="topbar">
        <a class="brand-link" href="/" aria-label="Spine-Link home"><span class="brand-logo" aria-hidden="true"><span>s</span><span>p</span><span class="brand-spine-mark"><i></i><i></i><i></i><i></i><i></i></span><span>n</span><span>e</span><span class="brand-plus">link</span></span></a>
      </header>
      <div class="stage">
        <div class="player-frame">
          <button class="library-nav-button library-nav-button--prev" id="library-nav-prev" type="button" aria-label="Previous Spine work" title="Previous Spine work">&lsaquo;</button>
          <div id="player"></div>
          <button class="library-nav-button library-nav-button--next" id="library-nav-next" type="button" aria-label="Next Spine work" title="Next Spine work">&rsaquo;</button>
        </div>
        <aside id="sidebar">
          <div class="preview-card" id="set-card"><div class="section-title">Set</div><select id="set-select"></select></div>
          <div class="preview-card owner-card" id="owner-card"><div class="section-title">Creator</div><div id="owner-profile"></div></div>
          <div class="preview-card note-card" id="note-card"><div class="section-title">Text</div><p class="note-text" id="note-text"></p></div>
          <div class="preview-card seo-video-card${video ? ' is-visible' : ''}" id="seo-video-card"><div class="section-title">Video preview</div>${video ? `<video class="seo-video-preview" src="${escapeHtml(video.contentUrl)}" poster="${escapeHtml(video.thumbnailUrl)}" muted loop playsinline preload="metadata" controls></video>` : ''}</div>
          <div class="preview-card like-card"><div class="section-title">Likes</div><button class="preview-like-button" id="preview-like-button" type="button" data-like-id="${String(config.entryId || 'spine-preview').replace(/"/g, '&quot;')}" data-base-likes="${baseLikeCount(config.entryId || 'spine-preview')}" aria-pressed="false"><span aria-hidden="true">♡</span><strong>${baseLikeCount(config.entryId || 'spine-preview')}</strong></button></div>
          <div class="preview-card animation-card"><div class="section-title">Animations</div><div id="animation-list"></div></div>
          <div class="preview-card owner-library" id="owner-library"></div>
        </aside>
      </div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.2.113/dist/iife/spine-player.js"></script>
    <script type="application/json" id="spine-preview-config">${escapedJson(config)}</script>
    <script>
      function startParticleField() {
        const canvas = document.getElementById("particle-field");
        const context = canvas?.getContext?.("2d");
        if (!canvas || !context || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
        const colors = ["92, 169, 255", "179, 255, 64", "255, 106, 40", "238, 246, 255"];
        const particles = [];
        let width = 0;
        let height = 0;
        let pixelRatio = 1;
        let frame = 0;
        function resetParticle(particle, randomizePosition) {
          particle.x = Math.random() * width;
          particle.y = randomizePosition ? Math.random() * height : height + Math.random() * 60;
          particle.radius = 0.45 + Math.random() * 1.15;
          particle.speedX = (Math.random() - 0.5) * 0.11;
          particle.speedY = -(0.045 + Math.random() * 0.16);
          particle.alpha = 0.08 + Math.random() * 0.22;
          particle.pulse = Math.random() * Math.PI * 2;
          particle.color = colors[Math.floor(Math.random() * colors.length)];
        }
        function resizeParticles() {
          width = window.innerWidth || 1;
          height = window.innerHeight || 1;
          pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.floor(width * pixelRatio);
          canvas.height = Math.floor(height * pixelRatio);
          canvas.style.width = width + "px";
          canvas.style.height = height + "px";
          context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
          const targetCount = Math.max(28, Math.min(82, Math.floor((width * height) / 18000)));
          while (particles.length < targetCount) {
            const particle = {};
            resetParticle(particle, true);
            particles.push(particle);
          }
          particles.length = targetCount;
        }
        function drawParticles(time) {
          context.clearRect(0, 0, width, height);
          for (const particle of particles) {
            particle.x += particle.speedX + Math.sin(time * 0.00018 + particle.pulse) * 0.018;
            particle.y += particle.speedY;
            if (particle.y < -20 || particle.x < -28 || particle.x > width + 28) resetParticle(particle, false);
            const alpha = particle.alpha * (0.72 + Math.sin(time * 0.001 + particle.pulse) * 0.28);
            context.beginPath();
            context.fillStyle = "rgba(" + particle.color + ", " + alpha + ")";
            context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
            context.fill();
          }
          frame = window.requestAnimationFrame(drawParticles);
        }
        resizeParticles();
        window.addEventListener("resize", resizeParticles, { passive: true });
        frame = window.requestAnimationFrame(drawParticles);
        window.addEventListener("pagehide", () => window.cancelAnimationFrame(frame), { once: true });
      }
      startParticleField();
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
        return sets.find((set) => set.label === querySet) || sets.find((set) => setHasAnimation(set, queryAnimation)) || sets.find((set) => set.label === config.activeLabel) || sets[0];
      }
      function initialAnimation(set) {
        const queryAnimation = queryValue("animation");
        return setHasAnimation(set, queryAnimation) ? queryAnimation : set?.animation || "";
      }
      const activeSet = { value: initialSet() };
      const activeAnimation = { name: initialAnimation(activeSet.value) };
      const loopEnabled = { value: true };
      const currentZoom = { value: config.zoom || 1 };
      const baseViewport = { value: null };
      const animationNames = { value: activeSet.value?.animations || [] };
      const animationList = document.getElementById("animation-list");
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
      const pinchDistance = { value: null };
      const panPosition = { value: null };
      const swipeStart = { value: null };
      let player;
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
      function startPageTransition(source, href, title) {
        if (!source || !href || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
          window.location.href = href;
          return;
        }
        const rect = source.getBoundingClientRect();
        const media = source.querySelector?.("img, video") || document.querySelector(".spine-player canvas");
        const image = media?.currentSrc || media?.poster || media?.src || "";
        const overlay = document.createElement("div");
        overlay.className = "page-transition";
        overlay.innerHTML = '<div class="page-transition-card"><span></span></div><div class="page-transition-ring"><i></i><i></i><i></i></div>';
        const transitionCard = overlay.querySelector(".page-transition-card");
        overlay.querySelector(".page-transition-card span").textContent = title || document.title.replace(" - Spine-Link", "") || "Spine preview";
        transitionCard.style.setProperty("--transition-top", rect.top + "px");
        transitionCard.style.setProperty("--transition-left", rect.left + "px");
        transitionCard.style.setProperty("--transition-width", rect.width + "px");
        transitionCard.style.setProperty("--transition-height", rect.height + "px");
        if (image) transitionCard.style.setProperty("--transition-image", "url(" + JSON.stringify(image) + ")");
        document.body.appendChild(overlay);
        window.setTimeout(() => { window.location.href = href; }, 720);
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
        const avatar = owner.picture ? document.createElement("img") : document.createElement("div");
        avatar.className = owner.picture ? "owner-avatar" : "owner-avatar owner-avatar-fallback";
        if (owner.picture) {
          avatar.src = owner.picture;
          avatar.alt = "";
        } else {
          avatar.setAttribute("aria-hidden", "true");
          avatar.textContent = String(owner.name || "S").slice(0, 1).toUpperCase();
        }
        const ownerText = document.createElement("div");
        ownerText.className = "owner-profile-text";
        const ownerName = document.createElement("strong");
        ownerName.textContent = owner.name || "Spine-Link creator";
        const ownerSubtitle = document.createElement("span");
        ownerSubtitle.textContent = owner.subtitle || "Public Spine library";
        ownerText.append(ownerName, ownerSubtitle);
        ownerProfile.append(avatar, ownerText);
        if (owner.url) {
          ownerProfile.style.cursor = "pointer";
          ownerProfile.onclick = () => { startPageTransition(document.querySelector(".player-frame") || ownerProfile, owner.url, "Open portfolio"); };
          ownerProfile.title = "Open public library";
        }
        items.forEach((item) => {
          const link = document.createElement("a");
          link.href = item.url;
          link.addEventListener("click", (event) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
            event.preventDefault();
            startPageTransition(link, link.href, item.title || "Spine preview");
          });
          const thumbSrc = item.thumbnailType === "gif" ? item.thumbnailPoster || "" : item.thumbnail || item.thumbnailPoster || "";
          const videoSrc = item.webmPreview || "";
          const thumb = videoSrc ? document.createElement("video") : thumbSrc ? document.createElement("img") : document.createElement("div");
          thumb.className = "owner-thumb";
          if (videoSrc) {
            thumb.src = videoSrc;
            if (item.thumbnailPoster) thumb.poster = item.thumbnailPoster;
            thumb.muted = true;
            thumb.loop = true;
            thumb.playsInline = true;
            thumb.preload = "metadata";
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
      }
      function rememberBaseViewport() { if (!player?.currentViewport) return; const v = player.currentViewport; baseViewport.value = { x: v.x, y: v.y, width: v.width * currentZoom.value, height: v.height * currentZoom.value, padLeft: v.padLeft * currentZoom.value, padRight: v.padRight * currentZoom.value, padTop: v.padTop * currentZoom.value, padBottom: v.padBottom * currentZoom.value }; }
      function touchDistance(touches) { const a = touches.item(0), b = touches.item(1); if (!a || !b) return 0; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
      function applyZoom(nextZoom) { currentZoom.value = Math.min(4, Math.max(0.25, Number(nextZoom))); playerElement.style.setProperty("--preview-pattern-size", (140 * currentZoom.value) + "px"); const b = baseViewport.value; if (!b || !player?.currentViewport) return; const cx = b.x + b.width / 2, cy = b.y + b.height / 2, width = b.width / currentZoom.value, height = b.height / currentZoom.value; const next = { x: cx - width / 2, y: cy - height / 2, width, height, padLeft: b.padLeft / currentZoom.value, padRight: b.padRight / currentZoom.value, padTop: b.padTop / currentZoom.value, padBottom: b.padBottom / currentZoom.value }; player.previousViewport = { ...next }; player.currentViewport = next; player.viewportTransitionStart = performance.now(); }
      function updateLoopButtonState(button) { button.classList.toggle("is-on", loopEnabled.value); button.classList.toggle("is-off", !loopEnabled.value); button.title = loopEnabled.value ? "Loop on" : "Loop off"; button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", String(loopEnabled.value)); }
      function setTrackLoop() { const entry = player?.animationState?.getCurrent?.(0); if (entry) entry.loop = loopEnabled.value; }
      function disableMix() { if (player?.animationState?.data) player.animationState.data.defaultMix = 0; }
      function playActiveAnimationFromStart() { if (!player || !activeAnimation.name) return; disableMix(); const entry = player.setAnimation(activeAnimation.name, loopEnabled.value); entry.mixDuration = 0; entry.mixTime = 0; entry.listener = { ...(entry.listener || {}), complete: () => { if (!loopEnabled.value) player.pause(); } }; player.play(); }
      function togglePlayback() { if (!player) return; if (player.paused === false) { player.pause(); return; } playActiveAnimationFromStart(); }
      function installLoopButton() { const buttons = player?.dom?.querySelector(".spine-player-buttons"); const playButton = buttons?.querySelector(".spine-player-button"); if (!buttons || !playButton) return; playButton.onclick = (event) => { event.preventDefault(); event.stopPropagation(); togglePlayback(); }; if (buttons.querySelector(".spine-link-loop-button")) return; const button = document.createElement("button"); button.type = "button"; button.className = "spine-player-button spine-link-loop-button"; updateLoopButtonState(button); button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); loopEnabled.value = !loopEnabled.value; setTrackLoop(); updateLoopButtonState(button); }; playButton.insertAdjacentElement("afterend", button); }
      function panByPixels(deltaX, deltaY) { const v = player?.currentViewport, b = baseViewport.value, canvas = player?.canvas; if (!v || !b || !canvas) return; const totalWidth = v.width + v.padLeft + v.padRight, totalHeight = v.height + v.padTop + v.padBottom; const worldDeltaX = deltaX / Math.max(1, canvas.clientWidth) * totalWidth, worldDeltaY = deltaY / Math.max(1, canvas.clientHeight) * totalHeight; v.x -= worldDeltaX; v.y += worldDeltaY; b.x -= worldDeltaX * currentZoom.value; b.y += worldDeltaY * currentZoom.value; player.previousViewport = { ...v }; player.viewportTransitionStart = performance.now(); }
      function createPlayer() { if (!activeSet.value) return; player?.dispose(); document.getElementById("player").innerHTML = ""; baseViewport.value = null; player = new spine.SpinePlayer("player", { ...activeSet.value, showControls: true, showLoading: true, alpha: true, preserveDrawingBuffer: true, backgroundColor: "00000000", success: (loadedPlayer) => { player = loadedPlayer; disableMix(); installLoopButton(); playActiveAnimationFromStart(); requestAnimationFrame(() => { rememberBaseViewport(); applyZoom(currentZoom.value); }); } }); }
      function renderAnimationList() { animationList.innerHTML = ""; animationNames.value.forEach((animationName) => { const button = document.createElement("button"); button.type = "button"; button.textContent = animationName; button.className = animationName === activeAnimation.name ? "active" : ""; button.onclick = () => { activeAnimation.name = animationName; syncUrl(); playActiveAnimationFromStart(); applyZoom(currentZoom.value); renderAnimationList(); }; animationList.appendChild(button); }); }
      function syncPreviewLike() {
        if (!previewLikeButton) return;
        const id = previewLikeButton.dataset.likeId || "spine-preview";
        const base = Number(previewLikeButton.dataset.baseLikes || "0") || 0;
        const key = "spine-link-like:" + id;
        const liked = localStorage.getItem(key) === "true";
        previewLikeButton.classList.toggle("is-liked", liked);
        previewLikeButton.setAttribute("aria-pressed", String(liked));
        const icon = previewLikeButton.querySelector("span");
        const count = previewLikeButton.querySelector("strong");
        if (icon) icon.textContent = liked ? "♥" : "♡";
        if (count) count.textContent = String(base + (liked ? 1 : 0));
      }
      previewLikeButton?.addEventListener("click", () => {
        const id = previewLikeButton.dataset.likeId || "spine-preview";
        const key = "spine-link-like:" + id;
        localStorage.setItem(key, String(localStorage.getItem(key) !== "true"));
        syncPreviewLike();
      });
      function randomOwnerVideoPulse() {
        const videos = Array.from(document.querySelectorAll(".owner-thumb")).filter((video) => video.tagName === "VIDEO" && video.getAttribute("src"));
        if (!videos.length) {
          window.setTimeout(randomOwnerVideoPulse, 4200);
          return;
        }
        const sample = videos.sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.min(2, Math.ceil(videos.length * 0.35))));
        sample.forEach((video) => {
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.play().catch(() => {});
          window.setTimeout(() => {
            if (video.matches(":hover")) return;
            video.pause();
            try { video.currentTime = 0; } catch {}
          }, 1800 + Math.random() * 1600);
        });
        window.setTimeout(randomOwnerVideoPulse, 3600 + Math.random() * 2600);
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
        }
      }, { passive: false });
      playerElement.addEventListener("touchmove", (event) => { if (event.touches.length !== 2 || pinchDistance.value === null) return; event.preventDefault(); const nextDistance = touchDistance(event.touches); applyZoom(currentZoom.value + (nextDistance - pinchDistance.value) / 220); pinchDistance.value = nextDistance; }, { passive: false });
      playerElement.addEventListener("touchend", (event) => {
        pinchDistance.value = null;
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
      playerElement.addEventListener("touchcancel", () => { pinchDistance.value = null; swipeStart.value = null; });
      playerElement.addEventListener("click", (event) => { if (event.target.closest(".spine-player-controls")) return; event.preventDefault(); event.stopImmediatePropagation(); if (event.button === 0) togglePlayback(); }, true);
      playerElement.addEventListener("dblclick", (event) => { if (event.target.closest(".spine-player-controls")) return; event.preventDefault(); event.stopImmediatePropagation(); }, true);
      playerElement.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
      playerElement.addEventListener("mousedown", (event) => { if (event.button !== 2) return; event.preventDefault(); event.stopImmediatePropagation(); panPosition.value = { x: event.clientX, y: event.clientY }; }, true);
      window.addEventListener("mousemove", (event) => { if (!panPosition.value) return; event.preventDefault(); event.stopImmediatePropagation(); const deltaX = event.clientX - panPosition.value.x, deltaY = event.clientY - panPosition.value.y; panPosition.value = { x: event.clientX, y: event.clientY }; panByPixels(deltaX, deltaY); }, { passive: false, capture: true });
      window.addEventListener("mouseup", (event) => { if (event.button !== 2) return; event.preventDefault(); event.stopImmediatePropagation(); panPosition.value = null; }, true);
      setSelect.onchange = () => { activeSet.value = sets.find((set) => set.label === setSelect.value) || sets[0]; activeAnimation.name = activeSet.value?.animation || ""; syncSetInfo(); renderAnimationList(); syncUrl(); createPlayer(); };
      window.addEventListener("popstate", applySelectionFromUrl);
      renderSetList(); syncSetInfo(); renderOwnerCard(); syncPreviewLike(); window.setTimeout(randomOwnerVideoPulse, 900); syncLibraryNavigationButtons(); syncUrl(true); createPlayer(); renderAnimationList();
    </script>
  </body>
</html>`;
}

function createVideoFallbackHtml({ origin, entry, ownerProfile, note, entryId }) {
  const title = cleanPublicText(entry?.title || entryId || 'Spine preview');
  const poster = safePublicImage(entry?.thumbnailPoster || '') || generatedThumbnailUrl(origin, entry);
  const video = safePublicVideo(entry?.webmPreview || '') || `${origin}/v_holder.webm`;
  const videoSeo = videoMetadataForEntry(origin, entry, entryId, note);
  const ownerUrl = ownerProfile?.url || (entry?.publicOwnerId ? `${origin}/u/${encodeURIComponent(String(entry.publicOwnerId))}` : '/');
  const likes = baseLikeCount(entryId || title);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${seoHead({ origin, entryId, video: videoSeo, fallbackTitle: `${title} - Spine-Link video preview` })}
    <style>
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; color: #edf5ff; background: #050607; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .page { display: grid; gap: 18px; width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 42px; }
      .topbar { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
      .brand { color: #ff6a28; font-weight: 950; letter-spacing: .16em; text-transform: uppercase; }
      .back { color: #b3ff40; font-weight: 800; text-decoration: none; }
      .video-card { overflow: hidden; border: 2px solid rgba(255,185,214,.72); border-radius: 8px; background: #111; box-shadow: 0 24px 80px rgba(0,0,0,.42); }
      video { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #000; }
      .body { display: grid; gap: 10px; padding: 18px; background: rgba(17,17,20,.86); }
      h1 { margin: 0; color: #fff; font-size: clamp(28px, 6vw, 48px); line-height: 1; }
      p { margin: 0; color: rgba(237,245,255,.72); font-size: 16px; line-height: 1.45; }
      .preview-like-button { justify-self: start; display: inline-flex; align-items: center; gap: 9px; min-height: 42px; padding: 0 14px; border: 1px solid rgba(255,185,214,.42); border-radius: 999px; color: #ffe4ef; background: rgba(8,9,11,.68); cursor: pointer; }
      .preview-like-button span { font-size: 22px; transform: translateY(-1px); }
      .preview-like-button strong { font-size: 14px; font-weight: 950; }
      .preview-like-button.is-liked { border-color: rgba(255,118,171,.78); color: #ff76ab; background: rgba(255,118,171,.14); }
      .page-transition { position: fixed; inset: 0; z-index: 80; overflow: hidden; pointer-events: none; }
      .page-transition::before { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 50% 46%, rgba(140,199,255,.24), transparent 28%), radial-gradient(circle at 50% 52%, rgba(255,185,214,.2), transparent 34%), rgba(2,4,7,.34); animation: transitionWash 720ms cubic-bezier(.18,.86,.26,1) both; backdrop-filter: blur(2px); }
      .page-transition-card { position: fixed; top: var(--transition-top); left: var(--transition-left); width: var(--transition-width); height: var(--transition-height); overflow: hidden; border: 2px solid rgba(255,185,214,.86); border-radius: 8px; background: linear-gradient(rgba(7,9,12,.18), rgba(7,9,12,.46)), var(--transition-image, radial-gradient(circle at 50% 42%, rgba(255,185,214,.28), transparent 34%)), radial-gradient(circle at 50% 48%, rgba(140,199,255,.22), rgba(0,0,0,.92)); background-position: center; background-size: cover; box-shadow: 0 30px 90px rgba(0,0,0,.54), 0 0 70px rgba(140,199,255,.32); animation: transitionCardPortal 720ms cubic-bezier(.18,.86,.26,1) both; }
      .page-transition-card span { position: absolute; right: 18px; bottom: 16px; left: 18px; overflow: hidden; color: #fff; font-size: clamp(24px,5vw,56px); font-weight: 950; line-height: .96; text-overflow: ellipsis; text-shadow: 0 4px 26px rgba(0,0,0,.82); white-space: nowrap; animation: transitionTitle 720ms ease both; }
      @keyframes transitionCardPortal { 0% { opacity: .98; transform: scale(1); } 58% { top: max(22px, 9vh); left: max(22px, 8vw); width: min(84vw, 980px); height: min(74vh, 720px); opacity: 1; transform: scale(1.015); } 100% { top: 0; left: 0; width: 100vw; height: 100vh; opacity: 0; border-radius: 0; transform: scale(1.04); } }
      @keyframes transitionWash { 0% { opacity: 0; } 48% { opacity: 1; } 100% { opacity: .82; } }
      @keyframes transitionTitle { 0% { opacity: 0; transform: translateY(16px); } 38% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-18px); } }
    </style>
  </head>
  <body>
    <main class="page">
      <div class="topbar"><div class="brand">Spine-Link</div><a class="back" href="${ownerUrl}">Open portfolio</a></div>
      <section class="video-card">
        <video src="${escapeHtml(video)}"${poster ? ` poster="${escapeHtml(poster)}"` : ''} muted loop playsinline autoplay controls></video>
        <div class="body">
          <h1>${title}</h1>
          ${note ? `<p>${cleanPublicText(note, 240)}</p>` : '<p>This older library item uses the portfolio video holder because its original Spine source files are no longer available.</p>'}
          <button class="preview-like-button" id="preview-like-button" type="button" data-like-id="${String(entryId || title).replace(/"/g, '&quot;')}" data-base-likes="${likes}" aria-pressed="false"><span aria-hidden="true">♡</span><strong>${likes}</strong></button>
        </div>
      </section>
    </main>
    <script>
      function startPageTransition(source, href) {
        if (!source || !href || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
          window.location.href = href;
          return;
        }
        const rect = source.getBoundingClientRect();
        const media = document.querySelector(".video-card video");
        const image = media?.poster || "";
        const overlay = document.createElement("div");
        overlay.className = "page-transition";
        overlay.innerHTML = '<div class="page-transition-card"><span>Open portfolio</span></div>';
        const transitionCard = overlay.querySelector(".page-transition-card");
        transitionCard.style.setProperty("--transition-top", rect.top + "px");
        transitionCard.style.setProperty("--transition-left", rect.left + "px");
        transitionCard.style.setProperty("--transition-width", rect.width + "px");
        transitionCard.style.setProperty("--transition-height", rect.height + "px");
        if (image) transitionCard.style.setProperty("--transition-image", "url(" + JSON.stringify(image) + ")");
        document.body.appendChild(overlay);
        window.setTimeout(() => { window.location.href = href; }, 720);
      }
      document.querySelector(".back")?.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
        event.preventDefault();
        startPageTransition(document.querySelector(".video-card") || event.currentTarget, event.currentTarget.href);
      });
      const button = document.getElementById("preview-like-button");
      function syncLike() {
        const id = button.dataset.likeId || "spine-preview";
        const base = Number(button.dataset.baseLikes || "0") || 0;
        const key = "spine-link-like:" + id;
        const liked = localStorage.getItem(key) === "true";
        button.classList.toggle("is-liked", liked);
        button.setAttribute("aria-pressed", String(liked));
        button.querySelector("span").textContent = liked ? "♥" : "♡";
        button.querySelector("strong").textContent = String(base + (liked ? 1 : 0));
      }
      button.addEventListener("click", () => {
        const key = "spine-link-like:" + (button.dataset.likeId || "spine-preview");
        localStorage.setItem(key, String(localStorage.getItem(key) !== "true"));
        syncLike();
      });
      syncLike();
    </script>
  </body>
</html>`;
}

async function createDynamicPreview(settings, uploadPath, origin) {
  const setDirectories = await findSpineSetDirectories(settings, uploadPath);
  const sets = [];
  let note = '';
  let ownerProfile = null;
  let entry = null;
  const pathParts = cleanRepoPath(uploadPath).split('/').filter(Boolean);
  const indexPath = joinRepoPath(pathParts.slice(0, -1).join('/'), 'index.json');
  const uploadId = pathParts[pathParts.length - 1] || '';
  const entryId = uploadId || uploadPath;
  let entries = [];

  for (const directory of setDirectories) {
    const items = await githubList(settings, directory.path);
    const skeleton = items.find((item) => item.type === 'file' && isSkeleton(item.name));
    const atlas = items.find((item) => item.type === 'file' && isAtlas(item.name));
    const textures = items.filter((item) => item.type === 'file' && isImage(item.name));
    if (!skeleton || !atlas || textures.length === 0) continue;

    let skeletonJson = null;
    const atlasText = await githubText(settings, atlas.path);
    if (skeleton.name.toLowerCase().endsWith('.json')) {
      try {
        skeletonJson = JSON.parse(await githubText(settings, skeleton.path));
      } catch {
        skeletonJson = null;
      }
    }

    const animations = animationNamesFromJson(skeletonJson);
    const defaultAnimation =
      animations.find((name) => name.toLowerCase() === 'idle') ??
      animations.find((name) => name.toLowerCase().includes('idle')) ??
      animations[0] ??
      '';

    const assetVersion = [skeleton.sha, atlas.sha, ...textures.map((texture) => texture.sha)].filter(Boolean).join('-');

    sets.push({
      label: directory.name,
      skeleton: `${origin}/assets/${encodeRepoPath(skeleton.path)}`,
      atlas: versionedAssetUrl(origin, atlas, assetVersion),
      animation: defaultAnimation,
      animations,
      textures: textures.map((texture) => texture.name),
      skin: 'default',
      premultipliedAlpha: hasPremultipliedAlpha(atlasText),
      viewport: viewportFromJson(skeletonJson)
        ? { ...viewportFromJson(skeletonJson), padLeft: '14%', padRight: '14%', padTop: '14%', padBottom: '14%' }
        : { padLeft: '14%', padRight: '14%', padTop: '14%', padBottom: '14%' },
    });
  }

  try {
    const indexText = indexPath ? await githubText(settings, indexPath) : '';
    entries = indexText ? JSON.parse(indexText) : [];
    entry = Array.isArray(entries)
      ? entries.find((item) => item?.id === uploadId || cleanRepoPath(item?.previewPath || '') === cleanRepoPath(uploadPath))
      : null;
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
      const ownerLibraryItems = ownerEntries.map((item) => ({
        title: cleanPublicText(item?.title || item?.id || 'Spine preview'),
        url: `${origin}/p/${encodeURIComponent(String(item?.id || '').trim())}`,
        thumbnail: item?.thumbnailType === 'gif' || /^data:image\/gif;base64,/i.test(String(item?.thumbnail || '')) ? '' : safePublicImage(item?.thumbnail || ''),
        thumbnailPoster: safePublicImage(item?.thumbnailPoster || '') || generatedThumbnailUrl(origin, item),
        webmPreview: safePublicVideo(item?.webmPreview || '') || `${origin}/v_holder.webm`,
        thumbnailType: '',
        animations: Array.isArray(item?.animations) ? item.animations.length : 0,
      }));
      ownerProfile = {
        visible: true,
        name: cleanPublicText(entry.ownerName || ownerEmail.split('@')[0] || 'Spine-Link creator'),
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
  const video = videoMetadataForEntry(origin, entry, entryId, note);
  if (sets.length === 0) return createVideoFallbackHtml({ origin, entry, ownerProfile, note, entryId });
  return createHtml({ sets, note, ownerProfile, entryId, origin, video });
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).send('Method not allowed');
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return response.status(500).send('GITHUB_TOKEN is not configured');

  const path = cleanRepoPath(request.query?.path || '');
  if (!path) return response.status(400).send('Invalid preview path');

  const settings = {
    owner: process.env.GITHUB_OWNER || defaultOwner,
    repo: process.env.GITHUB_REPO || defaultRepo,
    branch: process.env.GITHUB_BRANCH || defaultBranch,
    token,
  };
  const origin = `${request.headers['x-forwarded-proto'] || 'https'}://${request.headers['x-forwarded-host'] || request.headers.host}`;

  try {
    let html = '';
    if (path.endsWith('/preview.html')) {
      html = await githubText(settings, path);
      if (!html) return response.status(404).send('Preview not found');
    } else {
      html = await createDynamicPreview(settings, path, origin);
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    return response.status(200).send(html);
  } catch (error) {
    return response.status(500).send(error instanceof Error ? error.message : 'Preview failed');
  }
}
