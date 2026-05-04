const defaultOwner = 'vladleopold';
const defaultRepo = 'spine';
const defaultBranch = 'main';
const defaultBasePath = 'library';
const legacyPublicOwnerAliases = {
  u_rdrnig: 'u_yois91',
};

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

function assetUrlForRepoPath(origin, path) {
  return `${origin}/assets/${encodeRepoPath(path)}`;
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
  return /^https:\/\/[^\s"'<>]+\.webm(?:[?#][^\s"'<>]*)?$/i.test(url) ? url : '';
}

function derivedMediaFromFiles(origin, entry, extensions) {
  const previewPath = cleanRepoPath(entry?.previewPath || '');
  const files = Array.isArray(entry?.files) ? entry.files : [];
  const file = files.find((item) => extensions.some((extension) => String(item || '').toLowerCase().endsWith(extension)));
  return previewPath && file ? assetUrlForRepoPath(origin, joinRepoPath(previewPath, String(file))) : '';
}

function generatedThumbnailUrl(origin, entry) {
  const id = String(entry?.id || '').trim();
  const poster = String(entry?.thumbnailPoster || '');
  return id && /^data:image\/webp;base64,/i.test(poster)
    ? `${origin}/assets/library/${encodeURIComponent(id)}/generated-preview.webp`
    : '';
}

function generatedPreviewWebmUrl(origin, entry) {
  const id = String(entry?.id || '').trim();
  return id ? `${origin}/v_holder.webm` : '';
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

function createLibraryHtml({ origin, publicOwnerId, entries }) {
  const firstEntry = entries[0] || {};
  const showOwnerName = firstEntry.showOwnerLibrary !== false;
  const ownerName = escapeHtml(showOwnerName ? firstEntry.ownerName || 'Spine-Link creator' : 'Spine-Link library');
  const ownerPicture = showOwnerName ? safeImage(firstEntry.ownerPicture || '') : '';
  const ownerInitial = ownerName.replace(/&[^;]+;/g, '').slice(0, 1).toUpperCase() || 'S';
  const title = `${ownerName} - Spine portfolio media gallery`;
  const cards = entries
    .map((entry) => {
      const itemTitle = escapeHtml(entry.title || entry.id || 'Spine preview');
      const previewUrl = `/p/${encodeURIComponent(String(entry.id || ''))}`;
      const rawThumbnail = safeImage(entry.thumbnail || '');
      const derivedTexture = derivedMediaFromFiles(origin, entry, ['.png', '.jpg', '.jpeg', '.webp']);
      const thumbnailPoster = safeImage(entry.thumbnailPoster || '') || generatedThumbnailUrl(origin, entry) || derivedTexture;
      const webmPreview = safeVideo(entry.webmPreview || '') || derivedMediaFromFiles(origin, entry, ['.webm']) || generatedPreviewWebmUrl(origin, entry);
      const isGifPreview = entry.thumbnailType === 'gif' || /^data:image\/gif;base64,/i.test(rawThumbnail);
      const thumbnail = isGifPreview ? '' : rawThumbnail;
      const date = entry.uploadedAt ? new Date(entry.uploadedAt) : null;
      const dateText = date && !Number.isNaN(date.getTime())
        ? `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : 'Saved';
      const animations = Array.isArray(entry.animations) ? entry.animations.length : 0;
      const files = Array.isArray(entry.files) ? entry.files.length : 0;
      const entryId = escapeHtml(String(entry.id || ''));
      const likeId = String(entry.id || itemTitle);
      const likeCount = baseLikeCount(likeId);
      const thumbnailStyle = thumbnail || thumbnailPoster ? ` style="--library-thumbnail: url('${escapeHtml(thumbnailPoster || thumbnail)}')"` : '';
      const previewMedia = `<video class="library-card-webm"${webmPreview ? ` src="${escapeHtml(webmPreview)}" data-video-src="${escapeHtml(webmPreview)}"` : ''}${thumbnailPoster ? ` poster="${escapeHtml(thumbnailPoster)}"` : ''} muted playsinline loop preload="metadata" aria-hidden="true"></video>`;
      return `<article class="library-card" data-entry-id="${entryId}"${thumbnailStyle}>
        <button class="portfolio-like-button" type="button" data-like-id="${escapeHtml(likeId)}" data-base-likes="${likeCount}" aria-pressed="false" title="Like"><span aria-hidden="true">♡</span><strong>${likeCount}</strong></button>
        <a class="library-card-link" href="${previewUrl}" aria-label="Open ${itemTitle}">
          <div class="library-card-visual">
            ${previewMedia}
            <span class="stack-icon" aria-hidden="true"></span>
            <span>${animations}</span>
          </div>
          <div class="library-card-body">
            <div class="library-card-title-row">
              <strong>${itemTitle}</strong>
              <span class="library-card-date">${escapeHtml(dateText)}</span>
            </div>
            ${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ''}
            <div class="library-card-meta"><span>${files} files</span></div>
          </div>
        </a>
      </article>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="${origin}/u/${encodeURIComponent(publicOwnerId)}" />
    <style>
      * { box-sizing: border-box; }
      * { scrollbar-width: thin; scrollbar-color: rgba(74,78,84,.72) transparent; }
      *::-webkit-scrollbar { width: 8px; height: 8px; }
      *::-webkit-scrollbar-track { background: transparent; }
      *::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: rgba(74,78,84,.72); background-clip: content-box; }
      *::-webkit-scrollbar-thumb:hover { background: rgba(100,106,115,.78); background-clip: content-box; }
      body { min-height: 100vh; margin: 0; color: #edf5ff; background: #070809; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .particle-field { position: fixed; inset: 0; z-index: 0; width: 100%; height: 100%; pointer-events: none; opacity: .78; }
      .page { position: relative; z-index: 1; width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
      .creator-card { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 28px; width: 100%; margin-bottom: 28px; padding: 24px 26px 26px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: rgba(8,9,10,.78); box-shadow: inset 0 0 0 1px rgba(255,255,255,.02), 0 22px 70px rgba(0,0,0,.32); backdrop-filter: blur(10px); }
      .creator-kicker { align-self: center; color: #ff6a28; font-size: clamp(16px, 2vw, 22px); font-weight: 950; letter-spacing: .18em; text-transform: uppercase; }
      .creator-row { display: flex; align-items: center; justify-self: end; gap: 18px; min-width: 0; max-width: 100%; }
      .creator-avatar { flex: 0 0 auto; width: 62px; height: 62px; overflow: hidden; border: 1px solid rgba(255,255,255,.22); border-radius: 999px; background: #181b20; box-shadow: 0 0 0 1px rgba(140,199,255,.08); }
      .creator-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .creator-avatar-fallback { display: grid; place-items: center; width: 100%; height: 100%; color: #111; background: #b3ff40; font-size: 25px; font-weight: 950; }
      .creator-name-line { display: flex; align-items: baseline; gap: 40px; min-width: 0; }
      .creator-name { color: #fff; font-size: clamp(24px, 3.2vw, 34px); font-weight: 950; line-height: 1.05; white-space: nowrap; }
      .creator-count { color: rgba(237,245,255,.62); font-size: clamp(16px, 2vw, 22px); font-weight: 900; letter-spacing: .05em; white-space: nowrap; text-transform: uppercase; }
      .library-grid { column-count: 3; column-gap: 18px; }
      .library-card { position: relative; display: inline-block; width: 100%; margin: 0 0 18px; overflow: hidden; break-inside: avoid; border: 2px solid rgba(255,185,214,.72); border-radius: 8px; color: inherit; background: radial-gradient(circle at 22% 22%, rgba(255,106,40,.28), transparent 36%), radial-gradient(circle at 78% 16%, rgba(140,199,255,.32), transparent 32%), linear-gradient(135deg, rgba(32,35,38,.98), rgba(20,22,25,.98)); box-shadow: 0 0 0 1px rgba(255,185,214,.2), 0 20px 56px rgba(0,0,0,.34); transition: transform 150ms ease, border-color 150ms ease; }
      .library-card:hover { transform: translateY(-3px); border-color: #ffe4ef; }
      .library-card::before { content: ""; position: absolute; inset: 0; z-index: 0; background-image: var(--library-thumbnail); background-position: center; background-repeat: no-repeat; background-size: cover; opacity: .92; transform: scale(1.18); transform-origin: center; }
      .library-card::after { content: ""; position: absolute; inset: 0; z-index: 0; background: linear-gradient(rgba(8,10,12,.34), rgba(8,10,12,.52)), radial-gradient(circle at 22% 22%, rgba(255,106,40,.14), transparent 36%), radial-gradient(circle at 78% 16%, rgba(140,199,255,.18), transparent 32%); pointer-events: none; }
      .library-card-link { position: relative; z-index: 1; display: block; color: inherit; text-decoration: none; }
      .library-card-visual { position: relative; display: flex; align-items: flex-end; justify-content: space-between; min-height: 230px; padding: 24px; color: #fff; background: linear-gradient(rgba(9,11,13,.05), rgba(9,11,13,.18)); overflow: hidden; }
      .library-card-webm { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; object-fit: cover; opacity: .96; transform: scale(1.08); transform-origin: center; pointer-events: none; }
      .portfolio-like-button { position: absolute; top: 14px; right: 14px; z-index: 3; display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 10px; border: 1px solid rgba(255,185,214,.42); border-radius: 999px; color: #ffe4ef; background: rgba(8,9,11,.68); box-shadow: 0 12px 30px rgba(0,0,0,.32); backdrop-filter: blur(10px); cursor: pointer; }
      .portfolio-like-button span { color: currentColor; font-size: 20px; line-height: 1; transform: translateY(-1px); }
      .portfolio-like-button strong { color: currentColor; font-size: 12px; font-weight: 950; line-height: 1; }
      .portfolio-like-button.is-liked { border-color: rgba(255,118,171,.78); color: #ff76ab; background: rgba(255,118,171,.14); }
      .library-card-visual > span { position: relative; z-index: 1; }
      .library-card-visual > span:last-child { font-size: 64px; font-weight: 900; line-height: .9; text-shadow: 0 2px 0 #000, 0 14px 34px rgba(0,0,0,.48); }
      .stack-icon { width: 28px; height: 28px; background: linear-gradient(#fff, #fff) 50% 4px / 24px 4px no-repeat, linear-gradient(#fff, #fff) 50% 12px / 24px 4px no-repeat, linear-gradient(#fff, #fff) 50% 20px / 24px 4px no-repeat; filter: drop-shadow(0 2px 0 #000); transform: skewY(-24deg); }
      .library-card-body { display: grid; gap: 8px; padding: 14px; background: rgba(17,17,20,.72); backdrop-filter: blur(10px); }
      .library-card-title-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px; }
      .library-card-body strong { overflow: hidden; font-size: 17px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
      .library-card-date { display: inline-flex; align-items: center; justify-content: flex-end; color: rgba(237,245,255,.58); font-size: 12px; white-space: nowrap; }
      .library-card-body p { display: -webkit-box; margin: 0; overflow: hidden; color: rgba(255,228,239,.78); font-size: 13px; line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
      .library-card-meta { display: flex; justify-content: flex-end; gap: 10px; color: rgba(237,245,255,.66); font-size: 12px; font-weight: 700; }
      .empty { padding: 34px; border: 1px dashed rgba(255,255,255,.16); border-radius: 8px; color: rgba(237,245,255,.68); text-align: center; }
      @media (max-width: 900px) { .library-grid { column-count: 2; } }
      @media (max-width: 640px) { * { scrollbar-width: none; } *::-webkit-scrollbar { width: 0; height: 0; display: none; } .creator-card { grid-template-columns: 1fr; gap: 22px; padding: 20px; } .creator-row { align-items: center; justify-self: stretch; flex-direction: row; gap: 14px; } .creator-avatar { width: clamp(44px, 15vw, 56px); height: clamp(44px, 15vw, 56px); } .creator-name-line { flex: 1 1 auto; min-width: 0; display: grid; grid-template-columns: minmax(0, max-content); column-gap: 40px; row-gap: 7px; } .creator-name { max-width: calc(100vw - 140px); font-size: clamp(18px, 6.2vw, 30px); white-space: nowrap; } .creator-count { font-size: clamp(14px, 4.4vw, 18px); } .library-grid { column-count: 1; } .library-card-visual { min-height: 210px; } }
    </style>
  </head>
  <body>
    <canvas class="particle-field" id="particle-field" aria-hidden="true"></canvas>
    <main class="page">
      <section class="creator-card" aria-label="Portfolio">
        <div class="creator-kicker">Portfolio</div>
        <div class="creator-row">
          <div class="creator-avatar" aria-hidden="true">
            ${ownerPicture ? `<img src="${ownerPicture}" alt="" />` : `<div class="creator-avatar-fallback">${ownerInitial}</div>`}
          </div>
          <div class="creator-name-line">
            <strong class="creator-name">${ownerName}</strong><span class="creator-count">${entries.length} SPINE WORK'S</span>
          </div>
        </div>
      </section>
      ${entries.length ? `<section class="library-grid">${cards}</section>` : '<div class="empty">This public portfolio is empty or hidden.</div>'}
    </main>
    <script>
      function startParticleField() {
        const canvas = document.getElementById("particle-field");
        const context = canvas?.getContext?.("2d");
        if (!canvas || !context || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
        const colors = ["255,255,255", "140,199,255", "255,106,40"];
        const particles = [];
        let width = 0;
        let height = 0;
        let pixelRatio = 1;
        let frame = 0;
        function resetParticle(particle, randomizePosition) {
          particle.x = Math.random() * width;
          particle.y = randomizePosition ? Math.random() * height : height + Math.random() * 60;
          particle.radius = 0.55 + Math.random() * 1.8;
          particle.speedX = (Math.random() - 0.5) * 0.16;
          particle.speedY = -(0.08 + Math.random() * 0.34);
          particle.alpha = 0.18 + Math.random() * 0.64;
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
          const targetCount = Math.min(170, Math.max(72, Math.floor((width * height) / 9000)));
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
            particle.x += particle.speedX + Math.sin(time * 0.00025 + particle.pulse) * 0.035;
            particle.y += particle.speedY;
            if (particle.y < -24 || particle.x < -32 || particle.x > width + 32) resetParticle(particle, false);
            const alpha = particle.alpha * (0.68 + Math.sin(time * 0.0012 + particle.pulse) * 0.32);
            const glowRadius = particle.radius * 5.5;
            const gradient = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, glowRadius);
            gradient.addColorStop(0, "rgba(" + particle.color + ", " + alpha + ")");
            gradient.addColorStop(0.42, "rgba(" + particle.color + ", " + (alpha * 0.24) + ")");
            gradient.addColorStop(1, "rgba(" + particle.color + ", 0)");
            context.fillStyle = gradient;
            context.beginPath();
            context.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2);
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
      document.querySelectorAll(".library-card").forEach((card) => {
        const video = card.querySelector(".library-card-webm");
        if (!video) return;
        card.addEventListener("mouseenter", () => {
          const source = video.dataset.videoSrc || video.getAttribute("src") || "";
          if (!source) return;
          if (!video.getAttribute("src")) video.setAttribute("src", source);
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.play().catch(() => {});
        });
        card.addEventListener("mouseleave", () => {
          video.pause();
          try { video.currentTime = 0; } catch {}
        });
      });
      function stopVideo(video) {
        video.pause();
        try { video.currentTime = 0; } catch {}
      }
      function playVideo(video) {
        const source = video.dataset.videoSrc || video.getAttribute("src") || "";
        if (!source) return;
        if (!video.getAttribute("src")) video.setAttribute("src", source);
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.play().catch(() => {});
      }
      function randomVideoPulse() {
        const videos = Array.from(document.querySelectorAll(".library-card-webm")).filter((video) => video.dataset.videoSrc || video.getAttribute("src"));
        if (!videos.length) {
          window.setTimeout(randomVideoPulse, 4200);
          return;
        }
        const sample = videos.sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.min(3, Math.ceil(videos.length * 0.3))));
        sample.forEach((video) => {
          playVideo(video);
          window.setTimeout(() => {
            if (!video.matches(":hover")) stopVideo(video);
          }, 1800 + Math.random() * 1600);
        });
        window.setTimeout(randomVideoPulse, 3600 + Math.random() * 2600);
      }
      window.setTimeout(randomVideoPulse, 900);
      document.querySelectorAll(".portfolio-like-button").forEach((button) => {
        const id = button.dataset.likeId || "";
        const base = Number(button.dataset.baseLikes || "0") || 0;
        const key = "spine-link-like:" + id;
        const count = button.querySelector("strong");
        const icon = button.querySelector("span");
        function syncLike() {
          const liked = localStorage.getItem(key) === "true";
          button.classList.toggle("is-liked", liked);
          button.setAttribute("aria-pressed", String(liked));
          if (count) count.textContent = String(base + (liked ? 1 : 0));
          if (icon) icon.textContent = liked ? "♥" : "♡";
        }
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          localStorage.setItem(key, String(localStorage.getItem(key) !== "true"));
          syncLike();
        });
        syncLike();
      });
    </script>
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

  const requestedPublicOwnerId = String(request.query?.user || '').trim();
  const publicOwnerId = legacyPublicOwnerAliases[requestedPublicOwnerId] || requestedPublicOwnerId;
  if (!/^u_[a-z0-9]{3,32}$/i.test(requestedPublicOwnerId)) return response.status(400).send('Invalid public library');

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
    const allEntries = indexText ? JSON.parse(indexText) : [];
    const entries = Array.isArray(allEntries)
      ? allEntries.filter((entry) => String(entry?.publicOwnerId || '') === publicOwnerId)
      : [];
    entries.sort(compareLibraryEntries);

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    return response.status(200).send(createLibraryHtml({ origin, publicOwnerId, entries }));
  } catch (error) {
    return response.status(500).send(error instanceof Error ? error.message : 'Library failed');
  }
}
