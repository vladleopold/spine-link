import "./styles.css";

const root = document.getElementById("root");
export {};
let isAppLoading = false;
let isAppMounted = false;
let mountedFileReceiver: ((files: File[]) => void) | null = null;
let pendingMountedFiles: File[] | null = null;
let bootDraggingState: boolean | null = null;

declare global {
  interface Window {
    __spineLinkReceiveFiles?: (files: File[]) => void;
  }
}

type HomeFeedItem = {
  id?: string;
  title?: string;
  ownerName?: string;
  previewUrl?: string;
  webmPreview?: string;
  thumbnailPoster?: string;
  thumbnail?: string;
  previewWidth?: number;
  previewHeight?: number;
  mediaAspectRatio?: number;
  animations?: number;
  pageMode?: string;
  metrics?: { likes?: number; views?: number };
};

const siteReadingPages = [
  { href: "/spine-link.html", title: "Spine-Link", description: "Platform overview" },
  { href: "/spine-preview.html", title: "Spine Preview", description: "Open JSON, SKEL and atlas files" },
  { href: "/spine-preview-online.html", title: "Preview Online", description: "Browser Spine preview guide" },
  { href: "/spine-web-viewer.html", title: "Web Viewer", description: "Open Spine files online" },
  { href: "/spine-animation-preview.html", title: "Animation Preview", description: "Preview Spine animations" },
  { href: "/spine-animation-dataset.html", title: "Animation Dataset", description: "Commercial source database" },
  { href: "/spine-library.html", title: "Spine Library", description: "Online animation gallery" },
  { href: "/spine-portfolio.html", title: "Spine Portfolio", description: "Portfolio animation library" },
  { href: "/share-spine-animation-link.html", title: "Share Animation Link", description: "Create shareable previews" },
  { href: "/spine-portfolio-link.html", title: "Portfolio Link", description: "Public portfolio sharing" },
  { href: "/spine-animator.html", title: "Spine Animator", description: "Animator workflow notes" },
  { href: "/spine-animations.html", title: "Spine Animations", description: "Preview, save and share" },
  { href: "/spine-work.html", title: "Spine Work", description: "Share work previews" },
  { href: "/spine-link-manifesto.html", title: "Manifesto", description: "AI animator agreement" },
];

function receiveFiles(files: File[]) {
  if (!files.length) return;
  if (isAppMounted && window.__spineLinkReceiveFiles) {
    window.__spineLinkReceiveFiles(files);
    return;
  }
  if (isAppMounted) {
    pendingMountedFiles = files;
    window.setTimeout(() => {
      if (pendingMountedFiles && window.__spineLinkReceiveFiles) {
        const nextFiles = pendingMountedFiles;
        pendingMountedFiles = null;
        window.__spineLinkReceiveFiles(nextFiles);
      }
    }, 0);
    return;
  }
  if (mountedFileReceiver) {
    mountedFileReceiver(files);
    return;
  }
  window.setTimeout(() => {
    void mountApp(files);
  }, 50);
}

function renderHomeShell(isDragging = false) {
  if (!root || isAppMounted) return;
  if (bootDraggingState === isDragging && root.querySelector(".app-shell")) return;
  bootDraggingState = isDragging;

  root.innerHTML = `
    <main class="app-shell is-empty">
      <section class="seo-intro" aria-label="Spine-Link SEO description">
        <h1>Spine-Link is an animation portfolio platform with Google accounts and uploads</h1>
        <p>World SPINE ARCHIVE is the public archive of user Spine animation works. Anyone can create an anonymous preview with the Create preview button, or sign in with Google to create a profile, choose public portfolio mode with likes, views, showcase and archive publishing, or keep a private library profile that is not listed on the site or in Google.</p>
      </section>
      <section class="workspace">
        <header class="topbar">
          <a class="brand-link" href="/" aria-label="Spine-Link home">
            <span class="brand-mobile-text">spine link</span>
            <span class="brand-logo" aria-hidden="true">
              <span>s</span>
              <span>p</span>
              <span class="brand-spine-mark"><i></i><i></i><i></i><i></i><i></i></span>
              <span>n</span>
              <span>e</span>
              <span class="brand-plus">link</span>
            </span>
            <img class="brand-logo-image brand-logo-mobile" src="/logo-mobile.png" alt="" aria-hidden="true">
          </a>
          <div class="top-actions-row">
            <a class="world-archive-link" href="/world-spine-archive">BROWSE</a>
            <div class="auth-panel">
              <a class="my-library-button" href="/?portfolio=1" data-open-library>Portfolio</a>
              <button class="guest-account-button" type="button" data-open-login title="Sign in" aria-label="Sign in">
                <svg class="user_icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </button>
            </div>
            <div class="site-menu-group">
              <button class="site-add-button" type="button" data-open-upload aria-label="Add new animation card" title="Add new animation card">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
              </button>
              <details class="site-menu">
                <summary class="site-menu-toggle" aria-label="Open site menu" title="Menu"><span></span><span></span><span></span></summary>
                <nav class="site-menu-panel" aria-label="Site pages">
                  ${siteReadingPages.map((page) => `<a href="${page.href}"><strong>${page.title}</strong><span>${page.description}</span></a>`).join("")}
                </nav>
              </details>
            </div>
          </div>
        </header>
        <section class="home-portfolio-feed" id="home-feed" aria-label="World SPINE ARCHIVE public portfolio and library work feed" style="display:none">
          <div class="home-feed-heading">
            <span class="home-feed-archive-label">World SPINE ARCHIVE</span>
            <strong>Public user works from portfolios and libraries</strong>
            <small>Anyone can add a Spine animation with Create preview or publish through a Google account profile.</small>
          </div>
          <div class="home-feed-viewport">
            <div class="home-feed-track" id="home-feed-track"></div>
          </div>
        </section>
         <div class="stage">
           <div class="home-drop-panel">
             <label class="drop-zone main-drop-zone ${isDragging ? "is-dragging" : ""}" id="home-drop-zone">
               <input name="spine-files" type="file" multiple accept=".json,.skel,.atlas,.txt,.docx,.png,.jpg,.jpeg,.webp" aria-label="Upload Spine JSON SKEL atlas and texture files" data-file-input>
               <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v13m0-13 5 5m-5-5-5 5M5 15v4h14v-4"/></svg>
               <strong>Drag'and'Drop files here</strong>
               <span>JSON or SKEL, atlas, and textures become a Spine preview.</span>
             </label>
             <p class="home-drop-caption" style="font-size: 8px; line-height: 1.2">
               <strong>Upload agreement:</strong> by adding files here, you agree to the{" "}
               <a href="/spine-link-manifesto.html">Spine-Link Manifesto</a>. Public works and uploaded animation
               files may be analyzed by automated systems and used as learning, testing, and reference material for
               AI animator agents. Personal account data is not sold or shared for unrelated marketing.
             </p>
             <p class="upload-agreement main-upload-agreement" style="font-size: 8px; line-height: 1.2">
               Upload agreement: by dropping or choosing files here, you agree to the{" "}
               <a href="/spine-link-manifesto.html">Spine-Link Manifesto</a>. Public animation files may be
               processed, indexed, studied, and used to build educational datasets, evaluation material, and
               training examples for AI animator agents. Upload only work you own or have permission to publish.
             </p>
           </div>
         </div>
         <div id="upload-toast" class="upload-toast" style="display:none">
           <strong>Upload complete</strong>
           <a href="" target="_blank" rel="noreferrer">Open page</a>
           <button class="upload-toast-close" type="button" aria-label="Close notification">&times;</button>
         </div>
      </section>
    </main>
  `;

  wireHomeShell();
  wireUploadToast();
}

function wireHomeShell() {
  if (!root) return;

  root.querySelectorAll<HTMLElement>("[data-open-library], [data-open-login]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const isLibrary = button.hasAttribute("data-open-library");
      void mountApp([], { openLibrary: isLibrary, login: !isLibrary });
    });
  });

  root.querySelectorAll<HTMLElement>("[data-open-upload]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      void mountApp([], { upload: true });
    });
  });

  const bootFileInput = root.querySelector<HTMLInputElement>("[data-file-input]");
  const handleBootFileInput = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    window.setTimeout(() => {
      input.value = "";
    }, 0);
    receiveFiles(files);
  };
  bootFileInput?.addEventListener("click", () => {
    bootFileInput.value = "";
  });
  bootFileInput?.addEventListener("input", handleBootFileInput);
  bootFileInput?.addEventListener("change", handleBootFileInput);

  void loadHomeFeed();
}

async function loadHomeFeed() {
  if (!root) return;
  const feedSection = root.querySelector<HTMLElement>("#home-feed");
  const track = root.querySelector<HTMLElement>("#home-feed-track");
  if (!feedSection || !track) return;

  let entries: HomeFeedItem[] = [];
  try {
    const response = await fetch("/api/github-archive?feed=home", { credentials: "same-origin" });
    const payload = (await response.json().catch(() => ({}))) as { entries?: HomeFeedItem[] };
    entries = (Array.isArray(payload.entries) ? payload.entries : []).filter((entry) => entry?.id).slice(0, 10);
  } catch {
    return;
  }
  if (!entries.length) return;

  const fragment = document.createDocumentFragment();
  const pushCard = (entry: HomeFeedItem) => {
    const id = String(entry.id || "");
    const title = String(entry.title || id || "Spine preview");
    const ownerName = String(entry.ownerName || "Spine creator");
    const poster = entry.thumbnailPoster || entry.thumbnail || "";
    const likes = Number(entry.metrics?.likes || 0);
    const views = Number(entry.metrics?.views || 0);
    const previewWidth = Number(entry.previewWidth || 0);
    const previewHeight = Number(entry.previewHeight || 0);
    const mediaRatio =
      previewWidth > 0 && previewHeight > 0
        ? previewWidth / previewHeight
        : Number(entry.mediaAspectRatio || 0);

    const card = document.createElement("a");
    card.className = "home-feed-card";
    card.href = String(entry.previewUrl || "/world-spine-archive");
    card.setAttribute("aria-label", `Open ${title}`);
    if (Number.isFinite(mediaRatio) && mediaRatio > 0) {
      card.style.setProperty("--home-feed-ratio", `${Math.max(1, Math.round(mediaRatio * 1000))} / 1000`);
    }
    if (poster) card.style.setProperty("--home-feed-poster", `url("${poster}")`);

    if (poster) {
      const img = document.createElement("img");
      img.src = poster;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      card.appendChild(img);
    } else {
      const fallback = document.createElement("span");
      fallback.className = "home-feed-fallback";
      fallback.textContent = String(entry.animations ?? 0);
      card.appendChild(fallback);
    }

    const webmSrc = entry.webmPreview || "";
    if (webmSrc) {
      const video = document.createElement("video");
      video.className = "home-feed-video";
      video.src = webmSrc;
      if (poster) video.poster = poster;
      video.muted = true;
      video.playsInline = true;
      video.preload = "none";
      video.setAttribute("aria-hidden", "true");
      card.appendChild(video);
    }

    const like = document.createElement("span");
    like.className = "home-feed-like";
    like.setAttribute("aria-hidden", "true");
    like.innerHTML =
      '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
    like.appendChild(document.createTextNode(` ${likes}`));
    card.appendChild(like);

    const overlay = document.createElement("span");
    overlay.className = "home-feed-overlay";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const em = document.createElement("em");
    em.textContent = `${ownerName} · ${entry.pageMode || "Library"} · ${views} views`;
    overlay.appendChild(strong);
    overlay.appendChild(em);
    card.appendChild(overlay);

    fragment.appendChild(card);
  };

  entries.slice(0, 12).forEach(pushCard);

  track.appendChild(fragment);
  const cards = track.querySelectorAll(".home-feed-card");
  const cloneFragment = document.createDocumentFragment();
  cards.forEach((card) => {
    cloneFragment.appendChild(card.cloneNode(true));
  });
  track.appendChild(cloneFragment);
  track.classList.add("is-scrolling");
  feedSection.style.display = "";

  startHomeFeedAutoplay(track);
}

function startHomeFeedAutoplay(track: HTMLElement) {
  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const saveData = Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);
  if (prefersReducedMotion || saveData) return;

  const stopVideo = (video: HTMLVideoElement) => {
    video.pause();
    video.onended = null;
    try { video.currentTime = 0; } catch {}
  };

  const playVideo = (video: HTMLVideoElement) => {
    if (!video.currentSrc && !video.src) return;
    video.muted = true;
    video.loop = false;
    video.playsInline = true;
    const doPlay = () => {
      try { video.currentTime = 0; } catch {}
      void video.play().catch(() => undefined);
    };
    if (video.readyState >= 1) {
      doPlay();
    } else {
      video.onloadedmetadata = doPlay;
      video.load();
    }
  };

  const visibleCards = new Set<Element>();
  let currentPlayIdx = 0;
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;

  const stopAllVisible = () => {
    visibleCards.forEach((card) => {
      const v = (card as HTMLElement).querySelector<HTMLVideoElement>(".home-feed-video");
      if (v && !v.paused) stopVideo(v);
    });
  };

  const rotateVisible = () => {
    const cardsArr = Array.from(visibleCards);
    if (!cardsArr.length) { rotationTimer = null; return; }

    stopAllVisible();

    if (currentPlayIdx >= cardsArr.length) currentPlayIdx = 0;
    const card = cardsArr[currentPlayIdx];
    const video = (card as HTMLElement).querySelector<HTMLVideoElement>(".home-feed-video");
    if (video) playVideo(video);

    rotationTimer = setTimeout(() => {
      currentPlayIdx = (currentPlayIdx + 1) % cardsArr.length;
      rotateVisible();
    }, 3500);
  };

  const scheduleRotate = () => {
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = null;
    if (visibleCards.size > 0) {
      currentPlayIdx = 0;
      rotateVisible();
    }
  };

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        entries.forEach((entry) => {
          const video = (entry.target as HTMLElement).querySelector<HTMLVideoElement>(".home-feed-video");
          if (!video) return;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.15) {
            visibleCards.add(entry.target);
            if (video.readyState < 2) { video.preload = "metadata"; video.load(); }
            changed = true;
          } else if (visibleCards.has(entry.target)) {
            visibleCards.delete(entry.target);
            stopVideo(video);
            changed = true;
          }
        });
        if (changed) scheduleRotate();
      },
      { threshold: [0, 0.15, 0.5, 1] },
    );
    track.querySelectorAll<HTMLElement>(".home-feed-card").forEach((card) => observer.observe(card));
  }

  const handleVisibilityChange = () => {
    if (document.hidden) {
      if (rotationTimer) clearTimeout(rotationTimer);
      rotationTimer = null;
      track.querySelectorAll<HTMLVideoElement>(".home-feed-video").forEach(stopVideo);
    } else {
      scheduleRotate();
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", () => {
    if (rotationTimer) clearTimeout(rotationTimer);
    track.querySelectorAll<HTMLVideoElement>(".home-feed-video").forEach(stopVideo);
  });

  setTimeout(scheduleRotate, 500);
}

function renderLoadingShell() {
  if (!root) return;
  bootDraggingState = null;
  root.innerHTML = `
    <main class="app-shell is-empty">
      <section class="workspace">
        <div class="stage">
          <div class="preview-panel">
            <div class="empty-state">
              <span class="boot-icon" aria-hidden="true">SP</span>
              <span>Loading Spine-Link</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  `;
}

async function mountApp(initialFiles: File[] = [], options: { openLibrary?: boolean; login?: boolean; upload?: boolean } = {}) {
  if (!root || isAppLoading || isAppMounted) return;
  isAppLoading = true;
  renderLoadingShell();

  const [{ createElement, StrictMode }, { createRoot }, { App }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./SpineApp"),
  ]);

  isAppMounted = true;
  mountedFileReceiver = (files: File[]) => {
    window.__spineLinkReceiveFiles?.(files);
  };

  createRoot(root).render(
    createElement(
      StrictMode,
      null,
      createElement(App, {
        initialFiles,
        initialOpenLibrary: options.openLibrary,
        initialLogin: options.login,
        initialUpload: options.upload,
      }),
    ),
  );
}

const bootSearchParams = new URLSearchParams(window.location.search);
const shouldOpenLogin = bootSearchParams.get("login") === "google";
const shouldOpenPortfolio = bootSearchParams.has("portfolio") || bootSearchParams.has("library");
const shouldOpenUpload = bootSearchParams.get("upload") === "work";
const shouldOpenEdit = bootSearchParams.has("edit");
const shouldOpenAdmin = bootSearchParams.get("admin") === "1";

renderHomeShell();

// The heavy React app loads ONLY when the user actually needs it:
// upload, portfolio, login, edit, or admin pages. The homepage stays
// a static lightweight shell with a CSS-transform poster feed.
if (shouldOpenEdit || shouldOpenLogin || shouldOpenPortfolio || shouldOpenUpload || shouldOpenAdmin) {
  globalThis.setTimeout(() => {
    void mountApp([], { login: shouldOpenLogin, openLibrary: shouldOpenPortfolio, upload: shouldOpenUpload });
  }, 100);
}

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  renderHomeShell(true);
});

document.addEventListener("dragleave", (event) => {
  if (!root || root.contains(event.relatedTarget as Node | null)) return;
  renderHomeShell(false);
});

document.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  renderHomeShell(false);
  receiveFiles(files);
});

function clearSpineCacheWorker() {
  if (!("serviceWorker" in navigator)) return;
  const clear = () => {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then(() => caches?.keys?.())
      .then((keys) => Promise.all((keys ?? []).filter((key) => key.startsWith("spine-link-cache-")).map((key) => caches.delete(key))))
      .catch(() => undefined);
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(clear, { timeout: 1600 });
  } else {
    globalThis.setTimeout(clear, 800);
  }
}

clearSpineCacheWorker();

function wireUploadToast() {
  const toast = document.getElementById("upload-toast");
  if (!toast) return;

  const closeBtn = toast.querySelector(".upload-toast-close");
  const link = toast.querySelector<HTMLAnchorElement>("a");
  let hideTimer: number | undefined;

  const show = (url: string) => {
    if (link) link.href = url;
    toast.style.display = "";
    toast.classList.add("is-visible");
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
      window.setTimeout(() => { toast.style.display = "none"; }, 300);
    }, 10000);
  };

  closeBtn?.addEventListener("click", () => {
    toast.classList.remove("is-visible");
    window.setTimeout(() => { toast.style.display = "none"; }, 300);
  });

  window.addEventListener("spine-upload-complete", ((event: any) => {
    const url = String(event.detail?.url || "");
    if (url) show(url);
  }) as EventListener);

  window.addEventListener("storage", (event) => {
    if (event.key === "__spineUploadComplete" && event.newValue) {
      try {
        const data = JSON.parse(event.newValue);
        if (data?.url) show(data.url);
      } catch {}
    }
  });

  try {
    const raw = localStorage.getItem("__spineUploadComplete");
    if (raw) {
      const data = JSON.parse(raw);
      if (data?.url && Date.now() - Number(data.timestamp || 0) < 300000) {
        show(data.url);
      }
    }
  } catch {}
}
