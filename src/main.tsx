import "./styles.css";
import { getPublishProgress, hidePublishProgress, resumePendingJobs, subscribePublishProgress } from "./publish-job";
import { startParticleField } from "./particles";

const root = document.getElementById("root");
export {};
let isAppLoading = false;
let isAppMounted = false;
let mountedFileReceiver: ((files: File[]) => void) | null = null;
let pendingMountedFiles: File[] | null = null;
let bootDraggingState: boolean | null = null;

const backgroundUploadKey = "__spineBackgroundUpload";
const uploadCompletePopupKey = "__spineUploadPopupShown";

type BackgroundUploadEntry = {
  id: string;
  uploadId: string;
  uploadPath: string;
  uploadUrl: string;
  files: Array<{ name: string; size: number }>;
  startedAt: number;
  status: "pending" | "uploading" | "ready" | "complete" | "failed";
  error?: string;
};

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
      <canvas class="particle-field" data-home-embers aria-hidden="true"></canvas>
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

  startHomeEmbers();
  wireHomeShell();
  wireUploadToast();
  wirePublishProgressMirror();
}

/**
 * Главная до загрузки React рисуется этой статической оболочкой, поэтому
 * искры запускаем здесь же — иначе фон пустой до первого клика. При
 * перерисовке оболочки предыдущее поле останавливается, чтобы не было
 * двух анимаций поверх друг друга.
 */
let stopHomeEmbers: (() => void) | null = null;

function startHomeEmbers() {
  stopHomeEmbers?.();
  const canvas = root?.querySelector<HTMLCanvasElement>("[data-home-embers]");
  if (!canvas) return;
  stopHomeEmbers = startParticleField(canvas);
}

/**
 * The save popup is a document-level concern: a publish started on the upload
 * screen keeps going while the reader is on another page, and the status has to
 * be visible there too. The React tree only renders it once it is mounted, so
 * until then (and on the home shell) this mirror draws the same node from the
 * shared store.
 */
let publishProgressMirrorWired = false;
function wirePublishProgressMirror() {
  if (publishProgressMirrorWired) return;
  publishProgressMirrorWired = true;

  const render = () => {
    const progress = getPublishProgress();
    const existing = document.getElementById("spine-publish-mirror");
    // The mounted app renders the same popup; only one of the two should exist.
    // The mirror must not match itself here, otherwise it deletes itself on the
    // next progress update and the popup disappears mid-save.
    const appPopup = document.querySelector(".publish-progress-overlay:not(#spine-publish-mirror)");
    if (appPopup || !progress.open) {
      existing?.remove();
      return;
    }
    const node = existing || document.createElement("div");
    node.id = "spine-publish-mirror";
    node.className = `publish-progress-overlay is-compact is-${progress.status}`;
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    const value = Math.min(100, Math.max(0, progress.value));
    const body =
      progress.status === "failed"
        ? `<p class="publish-progress-error">${escapeHtml(progress.error || "Saving failed")}</p>`
        : progress.status === "done" && progress.permalink
          ? `<a class="publish-progress-link" href="${escapeHtml(progress.permalink)}">Open permanent page</a>`
          : `<div class="publish-progress-bar"><span style="width:${value}%"></span></div>`;
    node.innerHTML = `
      <div class="publish-progress-dialog">
        <div class="publish-progress-kicker">${escapeHtml(progress.kicker)}</div>
        <strong>${escapeHtml(progress.label || "Saving Spine preview")}</strong>
        ${body}
        <div class="publish-progress-meta">
          <span>${progress.status === "done" ? "Permanent link ready" : progress.status === "failed" ? "Save failed" : "Saving to library"}</span>
          <b>${progress.status === "failed" ? "!" : `${value}%`}</b>
        </div>
        <button type="button" class="publish-progress-close" aria-label="Close save status">&times;</button>
      </div>`;
    if (!existing) document.body.appendChild(node);
    node.querySelector(".publish-progress-close")?.addEventListener("click", () => hidePublishProgress());
  };

  subscribePublishProgress(render);
  render();

  // React's popup mounts/unmounts independently of progress notifications
  // (e.g. the detail-modal early return), so keep the mirror in sync.
  const sync = () => {
    const appPopup = document.querySelector(".publish-progress-overlay:not(#spine-publish-mirror)");
    const mirror = document.getElementById("spine-publish-mirror");
    if (appPopup && mirror) mirror.remove();
    else if (!appPopup && getPublishProgress().open && !mirror) render();
  };
  new MutationObserver(sync).observe(document.documentElement, { childList: true, subtree: true });
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

  // The file input is stretched over the whole drop zone so the label can act
  // as a click target, which puts it directly under the pointer during a real
  // drag. Chrome does not fire `drop` on a file input and swallows the event,
  // so dropping a file onto the panel did nothing at all. Intercepting in the
  // capture phase means the drop is handled before the input ever sees it,
  // while clicks are left alone so click-to-pick keeps working.
  const homeZone = root.querySelector<HTMLElement>("#home-drop-zone");
  if (homeZone) {
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const zoneDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const zoneDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = Array.from(event.dataTransfer?.files ?? []);
      renderHomeShell(false);
      if (files.length) receiveFiles(files);
    };
    homeZone.addEventListener("dragover", zoneDragOver, true);
    homeZone.addEventListener("drop", zoneDrop, true);
  }

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
    // Берём с запасом: 10 работ на сцену по 2 хватило бы на пять сцен,
    // после чего карточки начали бы повторяться.
    entries = (Array.isArray(payload.entries) ? payload.entries : []).filter((entry) => entry?.id).slice(0, 60);
  } catch {
    return;
  }
  if (!entries.length) return;

  // Карточки переиспользуются по кругу: движок сцен берёт их из этого
  // массива в случайном порядке, поэтому заново создавать их не нужно.
  const pushCard = (entry: HomeFeedItem): HTMLElement | null => {
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

    const webmSrc = /(^|\/)v_holder\.webm(?:[?#][^\s"'<>]*)?$/i.test(String(entry.webmPreview || "").trim())
      ? ""
      : String(entry.webmPreview || "");
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

    return card;
  };

  const cards: HTMLElement[] = [];
  entries.forEach((entry) => {
    const card = pushCard(entry);
    if (card) cards.push(card);
  });
  if (!cards.length) return;

  // #home-feed-track остаётся контейнером сцены; движок создаёт внутри
  // него две ленты и перекладывает в них карточки.
  const viewport = track.parentElement;
  track.textContent = "";
  feedSection.style.display = "";

  startHomeFeedScenes(track, cards, viewport);
}

/**
 * Лента анимаций внизу главной.
 *
 * Движение цикличное и всегда в одну сторону: лента очень медленно ползёт
 * (DRIFT_PX пикселей за DRIFT_MS), затем быстро перематывается на 2–4 карточки
 * и снова ползёт. Отката назад нет, поэтому лента не прыгает.
 *
 * Смещение только накапливается: ушедшие за левый край карточки удаляются,
 * справа добавляются новые, поэтому полоса всегда длиннее окна и движение
 * не прерывается.
 */
function startHomeFeedScenes(lane: HTMLElement, cards: HTMLElement[], viewport: HTMLElement | null) {
  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const saveData = Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);

  // Медленный ход: почти на месте, с плавным разгоном и торможением.
  const DRIFT_MS = 6800;
  const DRIFT_PX = 14;
  const DRIFT_EASE = "cubic-bezier(0.45, 0, 0.55, 1)";
  // Быстрая перемотка на 2–4 карточки.
  const JUMP_MS = 700;
  const JUMP_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const GAP = 10;

  const metrics = () => {
    const width = viewport?.clientWidth || window.innerWidth;
    const rows = width < 760 ? 2 : 1;
    const perRow = width >= 1400 ? 4 : width >= 900 ? 3 : 2;
    const padding = 20;
    const cardWidth = Math.max(120, (width - padding - GAP * (perRow - 1)) / perRow);
    return { width, rows, perRow, visible: rows * perRow, cardWidth };
  };

  let m = metrics();

  let deck = shuffled(cards);
  function nextCard(): HTMLElement {
    if (!deck.length) deck = shuffled(cards);
    return deck.pop() as HTMLElement;
  }

  const stopVideo = (video: HTMLVideoElement) => {
    try { video.pause(); } catch {}
    try { video.currentTime = 0; } catch {}
  };

  const playVideo = (video: HTMLVideoElement) => {
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    const start = () => {
      try { video.currentTime = 0; } catch {}
      void video.play().catch(() => undefined);
    };
    if (video.readyState >= 1) start();
    else {
      video.addEventListener("loadedmetadata", start, { once: true });
      video.load();
      setTimeout(start, 350);
    }
  };

  /** Накопленное смещение. Только растёт, никогда не уменьшается. */
  let offset = 0;

  const applyCardSize = () => {
    lane.style.setProperty("--home-feed-card-width", `${Math.round(m.cardWidth)}px`);
  };

  const append = (count: number) => {
    for (let i = 0; i < count; i++) lane.appendChild(nextCard());
    lane.querySelectorAll<HTMLVideoElement>(".home-feed-video").forEach(playVideo);
  };

  /**
   * Убираем карточки за левым краем и подтягиваем смещение, чтобы полоса
   * не уехала из-под окн��. Считаем по реальным координатам, поэтому
   * работает и при переносе карточек в несколько рядов.
   */
  const trim = () => {
    // Левый край берём у контейнера: у самой ленты он уже сдвинут
    // собственным transform, и карточки никогда не считались бы ушедшими.
    const laneLeft = (viewport || lane.parentElement || lane).getBoundingClientRect().left;
    // Никогда не съедаем больше карточек, чем нужно для заполнения окна.
    const keep = m.rows * (m.perRow + 2);
    while (lane.children.length > keep && lane.firstElementChild) {
      const first = lane.firstElementChild as HTMLElement;
      const r = first.getBoundingClientRect();
      if (r.right > laneLeft + 1) break;
      first.querySelectorAll<HTMLVideoElement>(".home-feed-video").forEach(stopVideo);
      first.remove();
      offset -= r.width + GAP;
    }
    if (offset < 0) offset = 0;
  };

  let driftTimer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;

  const clearTimers = () => {
    if (driftTimer) clearTimeout(driftTimer);
    driftTimer = null;
  };

  /** Перемотка: сдвиг на 2–4 карточки быстрым движением. */
  function jump(myToken: number) {
    if (myToken !== token) return;

    // Сколько карточек прокручиваем: от двух до четырёх.
    const span = 2 + Math.floor(Math.random() * 3);
    offset += span * (m.cardWidth + GAP);

    lane.style.transition = `transform ${JUMP_MS}ms ${JUMP_EASE}`;
    lane.style.transform = `translateX(${-offset}px)`;

    driftTimer = setTimeout(() => {
      if (myToken !== token) return;
      clearTimers();
      append(span);
      trim();
      drift(myToken);
    }, JUMP_MS + 40);
  }

  /** Медленный ход: 14 пикселей за DRIFT_MS, ease-in-out. */
  function drift(myToken: number) {
    if (myToken !== token) return;

    const from = offset;
    offset += DRIFT_PX;

    lane.style.transition = `transform ${DRIFT_MS}ms ${DRIFT_EASE}`;
    lane.style.transform = `translateX(${-offset}px)`;

    driftTimer = setTimeout(() => {
      if (myToken !== token) return;
      clearTimers();
      // Если карточка успела уйти за левый край во время ползучего хода,
      // подтягиваем смещение, иначе лента оторвётся от окна.
      trim();
      lane.style.transition = "none";
      lane.style.transform = `translateX(${-offset}px)`;
      jump(myToken);
    }, DRIFT_MS);
    void from;
  }

  function resetLane() {
    lane.classList.add("is-instant");
    lane.style.transition = "none";
    offset = 0;
    lane.style.transform = "translateX(0px)";
    void lane.offsetWidth;
    lane.classList.remove("is-instant");
  }

  // Без движения лента просто показывает работы и не грузит видео.
  if (prefersReducedMotion || saveData) {
    applyCardSize();
    lane.classList.add("is-static");
    append(m.visible);
    return;
  }

  applyCardSize();
  append(m.rows * (m.perRow + 2));
  lane.style.transform = "translateX(0px)";

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      m = metrics();
      applyCardSize();
      lane.querySelectorAll<HTMLVideoElement>(".home-feed-video").forEach(stopVideo);
      lane.textContent = "";
      append(m.rows * (m.perRow + 2));
      resetLane();
    }, 200);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      token++;
      clearTimers();
      if (resizeTimer) clearTimeout(resizeTimer);
      lane.querySelectorAll<HTMLVideoElement>(".home-feed-video").forEach(stopVideo);
    } else {
      token++;
      drift(token);
    }
  });

  window.addEventListener("pagehide", () => {
    token++;
    clearTimers();
    if (resizeTimer) clearTimeout(resizeTimer);
    lane.querySelectorAll<HTMLVideoElement>(".home-feed-video").forEach(stopVideo);
  });

  drift(token);
}

/** Тасует копию массива: порядок каждый раз случайный. */
function shuffled<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
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

// A publish that a previous page started continues here, before React mounts.
void resumePendingJobs();

const DROP_CACHE = "spine-drop-handoff";

/**
 * Pick up files parked by public/drop-handoff.js. The server-rendered pages
 * (world archive, /p/:id) ship no app bundle, so a drop there is stored in the
 * Cache API and the browser is sent to /?upload=work&restored=1. This reads
 * them back and hands them to the normal pipeline, then clears the cache so a
 * reload never resurrects a stale drop.
 */
async function restoreDroppedFiles(): Promise<void> {
  if (typeof caches === "undefined") return;
  let names: { key: string; name: string; type: string; lastModified: number }[];
  try {
    const cache = await caches.open(DROP_CACHE);
    const hit = await cache.match(new Request("/__spine_drop__/manifest", { cache: "no-store" }));
    if (!hit) return;
    names = JSON.parse(await hit.text());
    await Promise.all(
      names.map((entry) =>
        cache.match(new Request(entry.key, { cache: "no-store" })).then((response) => response?.blob())
      )
    ).then((blobs) => {
      const files = blobs
        .map((blob, index) => {
          if (!blob || !names[index]) return null;
          return new File([blob], names[index].name, {
            type: names[index].type,
            lastModified: names[index].lastModified,
          });
        })
        .filter((file): file is File => Boolean(file));
      if (files.length) receiveFiles(files);
    });
  } catch {
    return;
  } finally {
    try {
      await caches.delete(DROP_CACHE);
    } catch {}
  }
}

if (bootSearchParams.get("restored") === "1") {
  void restoreDroppedFiles();
}

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

function getAnonymousAccount(): { id: string; fingerprint: string } {
  try {
    const stored = localStorage.getItem("spine-link-anonymous-account");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.id?.startsWith("anon_") && parsed.fingerprint) return parsed;
    }
  } catch {}
  const account = { id: `anon_${Math.random().toString(36).slice(2, 10)}_${Math.random().toString(36).slice(2, 12)}`, fingerprint: Math.random().toString(36).slice(2, 18) + Date.now().toString(36) };
  try { localStorage.setItem("spine-link-anonymous-account", JSON.stringify(account)); } catch {}
  return account;
}

function getBackgroundUploads(): BackgroundUploadEntry[] {
  try {
    const raw = localStorage.getItem(backgroundUploadKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveBackgroundUploads(uploads: BackgroundUploadEntry[]) {
  try {
    localStorage.setItem(backgroundUploadKey, JSON.stringify(uploads));
  } catch {}
}

function addBackgroundUpload(entry: Partial<BackgroundUploadEntry>) {
  const uploads = getBackgroundUploads();
  const newEntry: BackgroundUploadEntry = { id: crypto.randomUUID(), uploadId: "", uploadPath: "", uploadUrl: "", files: [], startedAt: Date.now(), status: "pending", ...entry };
  uploads.unshift(newEntry);
  saveBackgroundUploads(uploads.slice(0, 20));
  return newEntry;
}

function updateBackgroundUpload(id: string, updates: Partial<BackgroundUploadEntry>) {
  const uploads = getBackgroundUploads();
  const index = uploads.findIndex((u) => u.id === id);
  if (index === -1) return;
  uploads[index] = { ...uploads[index], ...updates };
  saveBackgroundUploads(uploads);
}

const KEEPALIVE_MAX_BYTES = 60000;

// Vercel refuses to run overlapping invocations of the upload function and
// answers with a non-JSON "FUNCTION_INVOCATION_FAILED" 500, which loses the
// file. It is a platform limit, not a bug in the handler, so the fix is to stop
// asking: one request to this endpoint at a time, process-wide. Chunks are
// already replayed safely, so serialising costs a little wall clock and buys
// reliability.
let uploadChain: Promise<unknown> = Promise.resolve();

function withUploadSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = uploadChain.then(task, task);
  // Keep the chain alive regardless of this task's outcome.
  uploadChain = run.then(() => undefined, () => undefined);
  return run;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadFileKeepAlive(url: string, data: Record<string, unknown>): Promise<{ ok: boolean; status: number; data?: unknown }> {
  const file = data.file as File | undefined;
  if (!file) return { ok: false, status: 0 };

  const base64 = await fileToBase64(file);
  const fileSize = file.size;

  if (fileSize <= KEEPALIVE_MAX_BYTES) {
    const body = JSON.stringify({
      ...data,
      fileName: file.name,
      fileSize: file.size,
      fileContentType: file.type || "application/octet-stream",
      fileBase64: base64,
    });
    try {
      // Whole-file path. Kept on the same queue: it can run alongside a
      // chunked upload, and overlapping invocations are what Vercel refuses.
      const response = await withUploadSlot(() => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
      return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  const chunkBase64 = base64;
  const CHUNK_SIZE = KEEPALIVE_MAX_BYTES;
  // GitHub rate limits and transient 5xx responses are shared by every
  // anonymous upload, so replay a failed chunk instead of aborting the file.
  const CHUNK_ATTEMPTS = 5;
  // Honour GitHub's own backoff when it tells us how long to wait, otherwise
  // back off exponentially with jitter so concurrent uploads don't resynchronise
  // and all retry in lockstep. Capped so a wedged upload still fails visibly
  // instead of hanging forever.
  const chunkRetryDelayMs = (response: Response, payload: any, attempt: number) => {
    const header = Number(response.headers.get("Retry-After"));
    const body = Number(payload?.retryAfter);
    const asked = Number.isFinite(header) && header > 0 ? header * 1000
      : Number.isFinite(body) && body > 0 ? body * 1000
        : 0;
    if (asked > 0) return Math.min(asked, 60_000);
    return Math.min(400 * 2 ** attempt + Math.floor(Math.random() * 250), 10_000);
  };
  const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);
  const uploadId = String(data.uploadId || "");
  let chunkIndex = 0;

  const sendChunk = async (): Promise<{ ok: boolean; status: number; data?: unknown }> => {
    if (chunkIndex >= totalChunks) return { ok: true, status: 200 };
    const chunk = chunkBase64.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);
    chunkIndex++;
    const chunkBody = JSON.stringify({
      action: "background-upload-chunk",
      uploadId,
      uploadPath: data.uploadPath || "",
      fileName: file.name,
      chunkIndex: chunkIndex - 1,
      chunkCount: totalChunks,
      chunkBase64: chunk,
      totalBytes: fileSize,
      anonymousAccount: data.anonymousAccount,
      settings: data.settings,
    });
    // A failed chunk is not fatal: the server derives the chunk path from
    // uploadPath + fileName + chunkIndex and writes it idempotently, so
    // replaying the identical body is safe.
    //
    // Every anonymous upload shares one GITHUB_TOKEN, so GitHub rate limits
    // arrive as 429 + Retry-After. Replaying immediately just burns the window
    // and loses the file, so wait out whatever GitHub asked for. The server's
    // own message is logged because a bare "500" in the console is useless
    // for diagnosing it.
    for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt += 1) {
      try {
        // No keepalive here: it caps the body at 64 KB and fails at the
        // transport layer ("TypeError: Failed to fetch") under overlap. Queued
        // through the shared slot so we never have two in flight.
        const response = await withUploadSlot(() => fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chunkBody,
        }));
        if (response.ok) return sendChunk();
        const payload = await response.json().catch(() => ({}));
        // 4xx (other than 429) is a definitive answer from our own handler: the
        // server already tried to fix it and could not. Replaying just spends
        // the user's time and hides the real message behind retry noise.
        const definitive = response.status >= 400 && response.status < 500 && response.status !== 429;
        if (attempt === CHUNK_ATTEMPTS - 1 || definitive) {
          console.error(
            `[spine] upload chunk ${chunkIndex}/${totalChunks} for ${file.name} failed: HTTP ${response.status}`,
            payload?.error || payload,
          );
          return { ok: false, status: response.status, data: payload };
        }
        const waitMs = chunkRetryDelayMs(response, payload, attempt);
        // Say which chunk died even when we are about to retry, so a slow
        // upload is diagnosable from the console without waiting for the end.
        if (waitMs > 0) {
          console.warn(
            `[spine] chunk ${chunkIndex}/${totalChunks} of ${file.name} got HTTP ${response.status}, retrying in ${Math.round(waitMs)}ms`,
            payload?.error || "",
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      } catch (error) {
        if (attempt === CHUNK_ATTEMPTS - 1) {
          console.error(`[spine] upload chunk ${chunkIndex}/${totalChunks} for ${file.name} failed:`, error);
          return { ok: false, status: 0 };
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      }
    }
    return { ok: false, status: 0 };
  };

  const result = await sendChunk();
  if (!result.ok) return result;

  const reassembleBody = JSON.stringify({
    action: "background-upload-reassemble",
    uploadId,
    uploadPath: data.uploadPath || "",
    fileName: file.name,
    chunkCount: totalChunks,
    totalBytes: fileSize,
    anonymousAccount: data.anonymousAccount,
    settings: data.settings,
  });
  try {
      const response = await withUploadSlot(() => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: reassembleBody }));
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0 };
  }
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function startBackgroundUpload(files: File[]) {
  const anonymousAccount = getAnonymousAccount();
  const uploadedAt = new Date().toISOString();
  const title = files.find((f) => f.name.toLowerCase().endsWith(".json"))?.name.replace(/\.[^.]+$/, "") || "Spine animation";
  const safeTitle = title.replace(/[^a-z0-9._-]/gi, "-").replace(/-+/g, "-").slice(0, 60);
  const uploadId = `${safeTitle}-${uploadedAt.replace(/[:.]/g, "-")}`;
  const uploadPath = `library/${uploadId}`;
  const origin = window.location.origin;
  const uploadEntry = addBackgroundUpload({
    uploadId,
    uploadPath,
    uploadUrl: `${origin}/p/${encodeURIComponent(uploadId)}`,
    files: files.map((f) => ({ name: f.name, size: f.size })),
    status: "uploading",
  });

  let fileIndex = 0;
  let error: string | null = null;

  const uploadNextFile = async () => {
    if (fileIndex >= files.length) {
      await finalizeBackgroundUpload(uploadEntry.id, uploadId, uploadPath, uploadedAt);
      return;
    }
    const file = files[fileIndex];
    fileIndex++;
    const result = await uploadFileKeepAlive("/api/github-upload", {
      action: "background-upload",
      uploadId,
      uploadPath,
      uploadedAt,
      anonymousAccount,
      settings: { owner: "vladleopold", repo: "spine", branch: "main", basePath: "library", title },
      file,
      anonymousAccountId: anonymousAccount.id,
      anonymousFingerprint: anonymousAccount.fingerprint,
    });
    if (!result.ok) {
      error = typeof (result.data as any)?.error === "string" ? (result.data as any).error : `Upload failed: ${result.status}`;
      updateBackgroundUpload(uploadEntry.id, { status: "failed", error: error ?? undefined });
      showBackgroundPopup(uploadEntry.id, null, error);
      return;
    }
    updateBackgroundUpload(uploadEntry.id, { status: "uploading" });
    uploadNextFile();
  };

  uploadNextFile();
}

async function finalizeBackgroundUpload(entryId: string, uploadId: string, uploadPath: string, uploadedAt: string) {
  const anonymousAccount = getAnonymousAccount();
  const body = JSON.stringify({
    action: "background-finalize-index",
    uploadedAt,
    uploadId,
    uploadPath,
    anonymousAccount,
    settings: { owner: "vladleopold", repo: "spine", branch: "main", basePath: "library" },
    entry: { id: uploadId, uploadedAt, previewPath: uploadPath },
    commitPrefix: "Background upload",
  });
  try {
    const response = await withUploadSlot(() => fetch("/api/github-upload", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      updateBackgroundUpload(entryId, { status: "failed", error: result?.error || "Index update failed" });
      showBackgroundPopup(entryId, null, result?.error || "Index update failed");
      return;
    }
  } catch {
    updateBackgroundUpload(entryId, { status: "failed", error: "Finalization failed" });
    showBackgroundPopup(entryId, null, "Finalization failed");
    return;
  }
  const previewUrl = `${window.location.origin}/p/${encodeURIComponent(uploadId)}`;
  updateBackgroundUpload(entryId, { status: "complete", uploadUrl: previewUrl });
  try { localStorage.setItem("__spineUploadComplete", JSON.stringify({ url: previewUrl, timestamp: Date.now() })); } catch {}
  window.dispatchEvent(new CustomEvent("spine-upload-complete", { detail: { url: previewUrl } }));
  showBackgroundPopup(entryId, previewUrl, null);
}

function showBackgroundPopup(entryId: string, url: string | null, error: string | null) {
  if (window.location.pathname.includes("/p/")) return;
  const existing = document.getElementById("spine-upload-popup");
  if (existing) existing.remove();
  const popup = document.createElement("div");
  popup.id = "spine-upload-popup";
  popup.className = "upload-toast is-visible";
  popup.innerHTML = `
    <strong>${error ? "Upload failed" : url ? "Upload complete" : "Upload in progress"}</strong>
    ${url ? `<a href="${url}" target="_blank" rel="noreferrer">Open animation</a>` : ""}
    ${error ? `<span style="color:#ff76ab;font-size:12px">${escapeHtml(error)}</span>` : ""}
    <button class="upload-toast-close" type="button" aria-label="Close notification">&times;</button>
  `;
  popup.querySelector(".upload-toast-close")?.addEventListener("click", () => {
    popup.classList.remove("is-visible");
    setTimeout(() => popup.remove(), 300);
  });
  document.body.appendChild(popup);
}

window.addEventListener("storage", (event: StorageEvent) => {
  if (event.key === "__spineUploadComplete" && event.newValue) {
    try {
      const data = JSON.parse(event.newValue);
      if (data?.url && !window.location.pathname.includes("/p/")) {
        const existing = document.getElementById("spine-upload-popup");
        if (!existing) showBackgroundPopup("storage-event", data.url, null);
      }
    } catch {}
  }
});

document.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  renderHomeShell(false);
  if (isAppMounted && mountedFileReceiver) {
    mountedFileReceiver(files);
  } else {
    startBackgroundUpload(files);
  }
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

window.addEventListener("load", () => {
  const uploads = getBackgroundUploads();
  for (const upload of uploads) {
    if (upload.status === "complete" && upload.uploadUrl) {
      try {
        const lastShown = localStorage.getItem(uploadCompletePopupKey);
        const alreadyShown = lastShown && typeof lastShown === "string" && lastShown.includes(upload.uploadUrl);
        if (!alreadyShown) {
          showBackgroundPopup(upload.id, upload.uploadUrl, null);
          localStorage.setItem(uploadCompletePopupKey, JSON.stringify({ url: upload.uploadUrl, timestamp: Date.now() }));
        }
      } catch {}
    }
  }
});
