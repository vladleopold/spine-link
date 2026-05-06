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

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeImage(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function safeVideo(value = '') {
  const url = String(value).trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

function textFromEntry(entry, field = 'all') {
  if (!entry || typeof entry !== 'object') return '';
  const files = Array.isArray(entry.files) ? entry.files.join(' ') : '';
  const animations = Array.isArray(entry.animations) ? entry.animations.join(' ') : '';
  const values = {
    all: [
      entry.id,
      entry.title,
      entry.ownerEmail,
      entry.ownerName,
      entry.note,
      entry.skeleton,
      entry.atlas,
      files,
      animations,
      entry.previewPath,
      entry.repositoryUrl,
    ],
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

function generatedThumbnailUrl(origin, entry) {
  const id = String(entry?.id || '').trim();
  const poster = String(entry?.thumbnailPoster || '');
  return origin && id && /^data:image\/webp;base64,/i.test(poster)
    ? `${origin}/assets/library/${encodeURIComponent(id)}/generated-preview.webp`
    : '';
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

async function githubBuffer(settings, path) {
  const encodedPath = encodeURIComponent(cleanRepoPath(path)).replace(/%2F/g, '/');
  const response = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}?ref=${encodeURIComponent(settings.branch)}`, {
    headers: githubHeaders(settings.token),
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (typeof data?.content === 'string' && data.content.trim()) {
    return Buffer.from(data.content.replace(/\s/g, ''), 'base64');
  }
  if (typeof data?.download_url === 'string' && data.download_url) {
    const rawResponse = await fetch(data.download_url, { headers: githubHeaders(settings.token) });
    if (!rawResponse.ok) return null;
    return Buffer.from(await rawResponse.arrayBuffer());
  }
  return null;
}

function compareArchiveEntries(a, b) {
  return String(b?.uploadedAt || '').localeCompare(String(a?.uploadedAt || ''));
}

function previewUrl(entry) {
  const id = encodeURIComponent(String(entry?.id || ''));
  const animation = String(entry?.defaultAnimation || '').trim();
  return animation ? `/p/${id}?animation=${encodeURIComponent(animation)}` : `/p/${id}`;
}

function stableMetric(value = '', min = 1, range = 99) {
  let hash = 0;
  for (const character of String(value)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return min + (hash % range);
}

function imageSizeFromBuffer(buffer) {
  if (!buffer || buffer.length < 32) return null;
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const chunkType = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const dataOffset = offset + 8;
      if (chunkType === 'VP8 ' && dataOffset + 10 <= buffer.length) {
        return { width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff, height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff };
      }
      if (chunkType === 'VP8L' && dataOffset + 5 <= buffer.length) {
        const bits = buffer.readUInt32LE(dataOffset + 1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunkType === 'VP8X' && dataOffset + 10 <= buffer.length) {
        return {
          width: 1 + buffer.readUIntLE(dataOffset + 4, 3),
          height: 1 + buffer.readUIntLE(dataOffset + 7, 3),
        };
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
  }
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buffer.length) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function repoPathFromAssetUrl(entry, value) {
  const url = String(value || '');
  const marker = '/assets/';
  const markerIndex = url.indexOf(marker);
  if (markerIndex >= 0) return decodeURIComponent(url.slice(markerIndex + marker.length).split(/[?#]/)[0]);
  const path = cleanRepoPath(entry?.thumbnailPosterPath || entry?.thumbnailPath || '');
  return path || '';
}

async function enrichArchiveEntryLayout(settings, origin, entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const width = Number(entry.previewWidth || entry.thumbnailWidth || entry.mediaWidth);
  const height = Number(entry.previewHeight || entry.thumbnailHeight || entry.mediaHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { ...entry, mediaAspectRatio: width / height };
  }

  const posterUrl = safeImage(entry.thumbnailPoster || '') || generatedThumbnailUrl(origin, entry) || safeImage(entry.thumbnail || '');
  const repoPath = repoPathFromAssetUrl(entry, posterUrl);
  if (!repoPath || repoPath.includes('/generated-preview.webp')) return entry;
  const buffer = await githubBuffer(settings, repoPath);
  const size = imageSizeFromBuffer(buffer);
  return size ? { ...entry, mediaAspectRatio: size.width / size.height, mediaWidth: size.width, mediaHeight: size.height } : entry;
}

async function enrichArchiveLayout(settings, origin, entries) {
  const enriched = [];
  for (const entry of entries) enriched.push(await enrichArchiveEntryLayout(settings, origin, entry));
  return enriched;
}

function tileClassForEntry(entry) {
  const ratio = Number(entry?.mediaAspectRatio || 0);
  if (Number.isFinite(ratio) && ratio >= 1.28) return 'tile tile--wide';
  if (Number.isFinite(ratio) && ratio <= 0.78) return 'tile tile--tall';
  return 'tile tile--square';
}

function mediaHtml(entry, { origin = '', posterClass = '' } = {}) {
  const video = safeVideo(entry?.webmPreview || '');
  const poster = safeImage(entry?.thumbnailPoster || '') || generatedThumbnailUrl(origin, entry);
  const isGifThumbnail = entry?.thumbnailType === 'gif' || /^data:image\/gif;base64,/i.test(String(entry?.thumbnail || ''));
  const thumbnail = isGifThumbnail ? poster : safeImage(entry?.thumbnail || '');
  if (video) {
    return `<video class="${posterClass}" src="${escapeHtml(video)}" data-video-src="${escapeHtml(video)}" muted playsinline preload="metadata"></video>`;
  }
  if (thumbnail) {
    return `<img class="${posterClass}" src="${escapeHtml(thumbnail)}" alt="" loading="lazy" decoding="async" />`;
  }
  return `<div class="media-fallback">${Array.isArray(entry?.animations) ? entry.animations.length : 0}</div>`;
}

function baseStyles() {
  return `
      * { box-sizing: border-box; }
      * { scrollbar-width: thin; scrollbar-color: rgba(74,78,84,.72) transparent; }
      *::-webkit-scrollbar { width: 8px; height: 8px; }
      *::-webkit-scrollbar-track { background: transparent; }
      *::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: rgba(74,78,84,.72); background-clip: content-box; }
      html, body { min-height: 100%; margin: 0; }
      body { color: #edf5ff; background: #050607; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .page { width: min(1440px, calc(100% - 28px)); margin: 0 auto; padding: 26px 0 46px; }
      .top { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
      .brand { color: #fff; text-decoration: none; font-size: clamp(32px, 5vw, 72px); font-weight: 950; letter-spacing: .02em; line-height: .9; }
      .brand span { display: block; color: #ff6a28; font-size: 12px; letter-spacing: .32em; text-transform: uppercase; }
      .back { color: #b3ff40; font-weight: 800; text-decoration: none; }
      .muted { color: rgba(237,245,255,.62); }
      @media (max-width: 700px) {
        * { scrollbar-width: none; }
        *::-webkit-scrollbar { width: 0; height: 0; display: none; }
        .page { width: min(100% - 18px, 1440px); padding-top: 18px; }
        .top { align-items: flex-start; flex-direction: column; }
      }
  `;
}

function archiveHtml({ origin, entries, exclusions }) {
  const cards = entries
    .map((entry) => {
      const title = escapeHtml(entry?.title || entry?.id || 'Spine preview');
      const spineUrl = previewUrl(entry);
      const metricId = String(entry?.id || entry?.title || '');
      const likes = stableMetric(metricId, 12, 87);
      const views = stableMetric(`${metricId}:views`, 140, 2860);
      return `<a class="${tileClassForEntry(entry)}" href="${escapeHtml(spineUrl)}" aria-label="Open ${title}">
        <div class="tile-media">${mediaHtml(entry, { origin })}</div>
        <div class="tile-overlay">
          <strong class="tile-title">${title}</strong>
          <span class="tile-stats" aria-label="${likes} likes and ${views} views">
            <span class="tile-stat"><span aria-hidden="true">♡</span>${likes}</span>
            <span class="tile-stat"><span aria-hidden="true">◉</span>${views}</span>
          </span>
        </div>
      </a>`;
    })
    .join('');

  const googleClientId = escapeHtml(process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '');
  const archiveRulesJson = JSON.stringify({
    updatedAt: exclusions?.updatedAt || '',
    updatedBy: exclusions?.updatedBy || '',
    rules: Array.isArray(exclusions?.rules) ? exclusions.rules : [],
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>World Spine Archive - Spine Portfolio Library</title>
    <meta name="description" content="Browse World Spine Archive, a growing Spine portfolio library with animation work from beginner, intermediate and professional Spine animators." />
    <meta name="keywords" content="spine portfolio, portfolio spine, spine animation portfolio, spine animator portfolio, world spine archive, spine library" />
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="${origin}/world-spine-archive" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="World Spine Archive - Spine Portfolio Library" />
    <meta property="og:description" content="A growing public archive of Spine animation portfolios and preview cards from many animator levels." />
    <meta property="og:url" content="${origin}/world-spine-archive" />
    <script type="application/ld+json">
      ${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'World Spine Archive',
        url: `${origin}/world-spine-archive`,
        description:
          'A growing public portfolio Spine library with animation preview cards from beginner, intermediate, senior and professional Spine animators.',
        keywords:
          'spine portfolio, portfolio spine, spine animation portfolio, spine animator portfolio, world spine archive, spine library',
      }).replace(/</g, '\\u003c')}
    </script>
    <style>
      ${baseStyles()}
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); grid-auto-flow: dense; gap: 10px; }
      .tile { position: relative; min-height: 220px; overflow: hidden; border: 1px solid rgba(140,199,255,.18); border-radius: 8px; color: inherit; background: #090b0d; text-decoration: none; }
      .tile--wide { grid-column: span 2; min-height: 220px; }
      .tile--tall { grid-row: span 2; min-height: 450px; }
      .tile--square { min-height: 220px; }
      .tile:hover { border-color: rgba(179,255,64,.68); }
      .tile-media, .tile-media img, .tile-media video { position: absolute; inset: 0; width: 100%; height: 100%; }
      .tile-media img, .tile-media video { object-fit: cover; transform: scale(1.08); background: #050607; }
      .tile::after { content: ""; position: absolute; inset: 0; z-index: 1; background: linear-gradient(180deg, rgba(0,0,0,.72), rgba(0,0,0,.12) 35%, rgba(0,0,0,.22)); pointer-events: none; }
      .tile-overlay { position: absolute; top: 10px; right: 10px; left: 10px; z-index: 2; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; }
      .tile-title { min-width: 0; overflow: hidden; color: #fff; font-size: 14px; font-weight: 950; text-overflow: ellipsis; text-shadow: 0 2px 14px rgba(0,0,0,.86); white-space: nowrap; }
      .tile-stats { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .tile-stat { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 8px; border: 1px solid rgba(255,255,255,.14); border-radius: 999px; color: rgba(237,245,255,.9); background: rgba(5,7,9,.58); box-shadow: 0 10px 24px rgba(0,0,0,.22); font-size: 12px; font-weight: 900; line-height: 1; backdrop-filter: blur(10px); }
      .tile-stat:first-child { color: #ffd6e7; border-color: rgba(255,185,214,.24); }
      .media-fallback { display: grid; place-items: center; width: 100%; height: 100%; color: #fff; font-size: 60px; font-weight: 950; background: radial-gradient(circle, rgba(140,199,255,.15), rgba(0,0,0,.92)); }
      .archive-admin-toggle { position: fixed; right: 14px; bottom: 14px; z-index: 20; min-height: 42px; padding: 0 14px; border: 1px solid rgba(179,255,64,.58); border-radius: 8px; color: #eaffc2; background: rgba(7,10,12,.84); font-weight: 900; cursor: pointer; backdrop-filter: blur(10px); }
      .archive-admin { display: none; position: fixed; right: 14px; bottom: 68px; z-index: 21; width: min(520px, calc(100vw - 28px)); max-height: min(720px, calc(100vh - 96px)); overflow: auto; padding: 14px; border: 1px solid rgba(140,199,255,.32); border-radius: 8px; background: rgba(8,10,12,.96); box-shadow: 0 24px 70px rgba(0,0,0,.48); }
      .archive-admin.is-open { display: grid; gap: 12px; }
      .archive-admin h2 { margin: 0; font-size: 18px; line-height: 1.2; }
      .archive-admin p { margin: 0; color: rgba(237,245,255,.66); font-size: 12px; line-height: 1.45; }
      .archive-admin-row { display: grid; grid-template-columns: 120px 104px minmax(0, 1fr) 66px 36px; gap: 8px; align-items: center; }
      .archive-admin-row select,
      .archive-admin-row input { min-width: 0; height: 36px; border: 1px solid rgba(255,255,255,.14); border-radius: 6px; color: #edf5ff; background: rgba(255,255,255,.06); }
      .archive-admin-row input[type="checkbox"] { width: 18px; height: 18px; justify-self: center; }
      .archive-admin button { min-height: 36px; border: 1px solid rgba(255,255,255,.16); border-radius: 6px; color: #edf5ff; background: rgba(255,255,255,.07); font-weight: 800; cursor: pointer; }
      .archive-admin-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .archive-admin-actions button:first-child { border-color: rgba(179,255,64,.58); color: #eaffc2; background: rgba(179,255,64,.12); }
      .archive-admin-status { min-height: 18px; color: rgba(237,245,255,.72); font-size: 12px; }
      @media (max-width: 700px) {
        .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .tile, .tile--wide, .tile--tall, .tile--square { min-height: 230px; grid-column: span 1; grid-row: span 1; }
        .tile-overlay { grid-template-columns: 1fr; align-items: start; gap: 8px; }
        .tile-stats { justify-self: start; }
        .archive-admin-row { grid-template-columns: 1fr 90px; }
        .archive-admin-row input[type="text"] { grid-column: 1 / -1; }
      }
    </style>
    ${googleClientId ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : ''}
  </head>
  <body>
    <main class="page">
      <header class="top">
        <h1 class="brand"><span>Spine portfolio library</span>WORLD SPINE ARCHIVE</h1>
        <a class="back" href="/">Create preview</a>
      </header>
      <p class="muted">
        Browse a growing portfolio Spine library with public animation preview cards from beginners, freelancers,
        technical artists, studio animators, and professional Spine-animation creators.
      </p>
      ${entries.length ? `<section class="grid">${cards}</section>` : '<p class="muted">No public previews yet.</p>'}
    </main>
    <button class="archive-admin-toggle" type="button" id="archive-admin-toggle">Archive rules</button>
    <section class="archive-admin" id="archive-admin" aria-label="Archive exclusion rules">
      <h2>Archive exclusion rules</h2>
      <p>Available for archive administrators. Matching cards are excluded from this page and item URLs.</p>
      <div id="archive-admin-rules"></div>
      <div class="archive-admin-actions">
        <button type="button" id="archive-admin-save">Save rules</button>
        <button type="button" id="archive-admin-add">Add rule</button>
        <button type="button" id="archive-admin-signin">Sign in with Google</button>
      </div>
      <div class="archive-admin-status" id="archive-admin-status"></div>
    </section>
    <script>
      const archiveRulesState = ${archiveRulesJson};
      const archiveGoogleClientId = "${googleClientId}";
      let archiveGoogleToken = "";
      const archiveAdmin = document.getElementById("archive-admin");
      const archiveRulesRoot = document.getElementById("archive-admin-rules");
      const archiveStatus = document.getElementById("archive-admin-status");
      function setArchiveStatus(message) {
        if (archiveStatus) archiveStatus.textContent = message || "";
      }
      function blankArchiveRule() {
        return { enabled: true, type: "contains", field: "all", pattern: "", flags: "i" };
      }
      function renderArchiveRules() {
        if (!archiveRulesRoot) return;
        const rules = Array.isArray(archiveRulesState.rules) ? archiveRulesState.rules : [];
        archiveRulesRoot.innerHTML = "";
        rules.concat(rules.length ? [] : [blankArchiveRule()]).forEach((rule, index) => {
          if (!rules.length) archiveRulesState.rules = [rule];
          const row = document.createElement("div");
          row.className = "archive-admin-row";
          row.innerHTML = '<select data-key="field"><option value="all">All text</option><option value="id">ID</option><option value="title">Title</option><option value="ownerEmail">Owner email</option><option value="ownerName">Owner name</option><option value="note">Note</option><option value="files">Files</option><option value="animations">Animations</option><option value="path">Path</option></select><select data-key="type"><option value="contains">Rule</option><option value="regex">Regex</option></select><input data-key="pattern" type="text" placeholder="Text or regular expression" /><input data-key="flags" type="text" placeholder="flags" /><button type="button" data-remove title="Remove rule">x</button>';
          row.querySelector('[data-key="field"]').value = rule.field || "all";
          row.querySelector('[data-key="type"]').value = rule.type === "regex" ? "regex" : "contains";
          row.querySelector('[data-key="pattern"]').value = rule.pattern || "";
          row.querySelector('[data-key="flags"]').value = rule.flags || "i";
          row.querySelectorAll("[data-key]").forEach((control) => {
            control.addEventListener("input", () => {
              archiveRulesState.rules[index] = { ...archiveRulesState.rules[index], [control.dataset.key]: control.value };
            });
          });
          row.querySelector("[data-remove]").addEventListener("click", () => {
            archiveRulesState.rules.splice(index, 1);
            renderArchiveRules();
          });
          archiveRulesRoot.appendChild(row);
        });
      }
      document.getElementById("archive-admin-toggle")?.addEventListener("click", () => {
        archiveAdmin?.classList.toggle("is-open");
        renderArchiveRules();
      });
      document.getElementById("archive-admin-add")?.addEventListener("click", () => {
        archiveRulesState.rules = Array.isArray(archiveRulesState.rules) ? archiveRulesState.rules : [];
        archiveRulesState.rules.push(blankArchiveRule());
        renderArchiveRules();
      });
      document.getElementById("archive-admin-signin")?.addEventListener("click", () => {
        if (!archiveGoogleClientId || !window.google?.accounts?.oauth2) {
          setArchiveStatus("Google sign in is not configured.");
          return;
        }
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: archiveGoogleClientId,
          scope: "openid email profile",
          callback: (response) => {
            archiveGoogleToken = response.access_token || "";
            setArchiveStatus(archiveGoogleToken ? "Signed in. Save rules when ready." : "Google sign in failed.");
          },
        });
        client.requestAccessToken({ prompt: archiveGoogleToken ? "" : "consent" });
      });
      document.getElementById("archive-admin-save")?.addEventListener("click", async () => {
        if (!archiveGoogleToken) {
          document.getElementById("archive-admin-signin")?.click();
          return;
        }
        setArchiveStatus("Saving...");
        try {
          const rules = (archiveRulesState.rules || []).map((rule) => ({
            enabled: rule.enabled !== false,
            type: rule.type === "regex" ? "regex" : "contains",
            field: rule.field || "all",
            pattern: String(rule.pattern || "").trim(),
            flags: String(rule.flags || "i").trim() || "i",
          })).filter((rule) => rule.pattern);
          const result = await fetch("/api/github-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + archiveGoogleToken },
            body: JSON.stringify({ action: "update-archive-exclusions", rules, commitPrefix: "Update World Spine Archive rules" }),
          });
          const payload = await result.json().catch(() => ({}));
          if (!result.ok) throw new Error(payload.error || "Could not save rules.");
          setArchiveStatus("Saved. Refreshing...");
          window.location.reload();
        } catch (error) {
          setArchiveStatus(error instanceof Error ? error.message : "Could not save rules.");
        }
      });
      function playArchiveVideo(video) {
        const source = video.dataset.videoSrc || video.getAttribute("src") || "";
        if (!source) return;
        if (!video.getAttribute("src")) video.setAttribute("src", source);
        video.muted = true;
        video.loop = false;
        video.playsInline = true;
        try { video.currentTime = 0; } catch {}
        video.play().catch(() => {});
      }
      function stopArchiveVideo(video) {
        video.pause();
        video.onended = null;
        try { video.currentTime = 0; } catch {}
      }
      let archiveSequenceIndex = 0;
      let activeArchiveVideo = null;
      let lastArchiveVideo = null;
      function sequenceArchivePulse() {
        const videos = Array.from(document.querySelectorAll(".tile video")).filter((video) => video.dataset.videoSrc || video.getAttribute("src"));
        if (!videos.length) {
          window.setTimeout(sequenceArchivePulse, 1200);
          return;
        }
        if (activeArchiveVideo) {
          activeArchiveVideo.onended = null;
          stopArchiveVideo(activeArchiveVideo);
        }
        let video = videos[archiveSequenceIndex % videos.length];
        archiveSequenceIndex += 1;
        if (videos.length > 1 && video === lastArchiveVideo) {
          video = videos[archiveSequenceIndex % videos.length];
          archiveSequenceIndex += 1;
        }
        lastArchiveVideo = video;
        activeArchiveVideo = video;
        video.onended = () => {
          stopArchiveVideo(video);
          window.setTimeout(sequenceArchivePulse, 420);
        };
        playArchiveVideo(video);
      }
      window.setTimeout(sequenceArchivePulse, 900);
    </script>
  </body>
</html>`;
}

function archiveItemHtml({ origin, entry }) {
  const title = escapeHtml(entry?.title || entry?.id || 'Spine preview');
  const animations = Array.isArray(entry?.animations) ? entry.animations.length : 0;
  const spineUrl = previewUrl(entry);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title} - World Spine Archive</title>
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="${origin}/world-spine-archive/${encodeURIComponent(String(entry?.id || ''))}" />
    <style>
      ${baseStyles()}
      .viewer { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 18px; align-items: stretch; }
      .media-panel { min-height: min(74vh, 760px); overflow: hidden; border: 1px solid rgba(140,199,255,.2); border-radius: 8px; background: #050607; }
      .media-panel img, .media-panel video { width: 100%; height: 100%; min-height: min(74vh, 760px); object-fit: contain; background: #050607; }
      .side { display: flex; flex-direction: column; justify-content: space-between; gap: 18px; padding: 18px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(255,255,255,.045); }
      h1 { margin: 0 0 8px; font-size: clamp(30px, 5vw, 56px); line-height: .95; }
      .spine-link { display: inline-flex; justify-content: center; align-items: center; min-height: 48px; padding: 0 16px; border: 1px solid rgba(179,255,64,.72); border-radius: 8px; color: #eaffc2; font-weight: 900; text-decoration: none; background: rgba(179,255,64,.12); }
      @media (max-width: 860px) { .viewer { grid-template-columns: 1fr; } .media-panel, .media-panel img, .media-panel video { min-height: 58vh; } }
    </style>
  </head>
  <body>
    <main class="page">
      <header class="top">
        <a class="back" href="/world-spine-archive">WORLD SPINE ARCHIVE</a>
        <a class="back" href="/">Create preview</a>
      </header>
      <section class="viewer">
        <div class="media-panel">${mediaHtml(entry, { origin, posterClass: 'media-main' })}</div>
        <aside class="side">
          <div>
            <p class="muted">Spine media preview</p>
            <h1>${title}</h1>
            <p class="muted">${animations} animations</p>
          </div>
          <a class="spine-link" href="${spineUrl}">Open Spine animation</a>
        </aside>
      </section>
    </main>
  </body>
</html>`;
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).send('Method not allowed');
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return response.status(500).send('GITHUB_TOKEN is not configured');

  const settings = {
    owner: process.env.GITHUB_OWNER || defaultOwner,
    repo: process.env.GITHUB_REPO || defaultRepo,
    branch: process.env.GITHUB_BRANCH || defaultBranch,
    basePath: cleanRepoPath(process.env.GITHUB_BASE_PATH || defaultBasePath),
    token,
  };
  const origin = `${request.headers['x-forwarded-proto'] || 'https'}://${request.headers['x-forwarded-host'] || request.headers.host}`;

  try {
    const indexText = await githubText(settings, `${settings.basePath}/index.json`);
    const exclusionsText = await githubText(settings, `${settings.basePath}/archive-exclusions.json`);
    const exclusions = exclusionsText ? JSON.parse(exclusionsText) : { rules: [] };
    const allEntries = indexText ? JSON.parse(indexText) : [];
    const entries = Array.isArray(allEntries)
      ? allEntries.filter((entry) => (
          entry?.hiddenFromPublicLibrary !== true &&
          (entry?.webmPreview || entry?.thumbnail || entry?.thumbnailPoster) &&
          !entryExcludedFromArchive(entry, exclusions)
        ))
      : [];
    entries.sort(compareArchiveEntries);
    const layoutEntries = await enrichArchiveLayout(settings, origin, entries);

    const archiveId = String(request.query?.id || '').trim();
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    if (archiveId) {
      const entry = layoutEntries.find((item) => String(item?.id || '') === archiveId);
      return response.status(entry ? 200 : 404).send(entry ? archiveItemHtml({ origin, entry }) : 'Archive item not found');
    }

    return response.status(200).send(archiveHtml({ origin, entries: layoutEntries, exclusions }));
  } catch (error) {
    return response.status(500).send(error instanceof Error ? error.message : 'Archive failed');
  }
}
