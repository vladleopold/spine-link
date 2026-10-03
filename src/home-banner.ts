/**
 * Баннер главной страницы: случайная работа из библиотеки, показанная поверх
 * панели загрузки.
 *
 * Каждые пять минут берётся новая работа, её анимация запускается в рантайме
 * Spine. Слой намеренно полупрозрачный, повёрнут и растянут на всю панель,
 * чтобы текст «Drag and Drop» оставался читаемым поверх картинки.
 */
import type { SpinePlayer as SpinePlayerInstance } from "@esotericsoftware/spine-player";

const ROTATION_MS = 5 * 60 * 1000;
const PLAYER_JS = "https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/iife/spine-player.js";
const PLAYER_CSS = "https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/spine-player.css";
const LEGACY_PLAYER_JS = "/vendor-spine-player-3.8.js";

type BannerEntry = {
  id?: string;
  skeleton?: string;
  jsonUrl?: string;
  atlas?: string;
  atlasUrl?: string;
  skeletonVersion?: string;
  skin?: string;
  defaultAnimation?: string;
  title?: string;
};

type BannerHost = {
  mount(banner: HTMLElement): void;
  start(): void;
  dispose(): void;
};

let runtimePromise: Promise<unknown> | null = null;

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Could not load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

function loadStylesheetOnce(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

// Spine 3.7/3.8 skeletons need their own runtime bundle, same as the preview page.
function legacyRuntimeFor(entry: BannerEntry): "3.7" | "3.8" | "" {
  const version = String(entry?.skeletonVersion || "");
  if (/^3\.7(?:\.|$)/.test(version)) return "3.7";
  if (/^3\.8(?:\.|$)/.test(version)) return "3.8";
  return "";
}

function isEntryFolderName(name: string): boolean {
  return /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(name);
}

export function mountHomeBanner(options: {
  panel: HTMLElement;
  feedUrl: string;
  indexUrl: string;
}): BannerHost {
  const { panel, feedUrl, indexUrl } = options;
  let player: SpinePlayerInstance | null = null;
  let timer = 0;
  let stopped = false;
  let currentId = "";

  const layer = document.createElement("div");
  layer.className = "home-banner-layer";
  layer.setAttribute("aria-hidden", "true");
  panel.prepend(layer);

  const label = document.createElement("div");
  label.className = "home-banner-caption";
  label.innerHTML = '<span class="home-banner-name"></span><span class="home-banner-cycle">Next work in 5 min</span>';
  panel.append(label);

  async function pickEntry(): Promise<BannerEntry | null> {
    // The feed endpoint already answers with a shuffled selection, so its first
    // usable entry changes on every rotation.
    const response = await fetch(feedUrl, { credentials: "same-origin" });
    const payload = (await response.json().catch(() => ({}))) as { entries?: BannerEntry[] };
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const candidates = entries.filter((entry) => entry && entry.id && (entry.skeleton || entry.jsonUrl));
    if (!candidates.length) return null;
    const next = candidates.find((entry) => String(entry.id) !== currentId) || candidates[0];
    return next;
  }

  async function ensureRuntime(entry: BannerEntry): Promise<any> {
    const legacy = legacyRuntimeFor(entry);
    if (legacy) {
      loadStylesheetOnce(`/vendor-spine-player-${legacy}.css`);
      await loadScriptOnce(LEGACY_PLAYER_JS);
    } else {
      loadStylesheetOnce(PLAYER_CSS);
      await loadScriptOnce(PLAYER_JS);
    }
    return (window as any).spine;
  }

  function applyLook() {
    if (!player) return;
    // The artwork sits behind the drop zone copy: transparent, tilted, and
    // stretched past the panel so no edge of the frame shows.
    layer.style.setProperty("--banner-opacity", "0.3");
    layer.style.setProperty("--banner-scale", "1.22");
    layer.style.setProperty("--banner-tilt", "-9deg");
  }

  async function show(entry: BannerEntry) {
    if (stopped) return;
    currentId = String(entry.id || "");
    const nameEl = label.querySelector<HTMLElement>(".home-banner-name");
    if (nameEl) nameEl.textContent = String(entry.title || entry.id || "");
    try {
      const spine = await ensureRuntime(entry);
      const SpinePlayer = spine?.SpinePlayer;
      if (!SpinePlayer) return;
      player?.dispose?.();
      layer.innerHTML = "";
      const host = document.createElement("div");
      host.className = "home-banner-player";
      layer.appendChild(host);
      player = new SpinePlayer(host, {
        skeleton: entry.skeleton || entry.jsonUrl,
        jsonUrl: entry.jsonUrl || entry.skeleton,
        atlas: entry.atlas || entry.atlasUrl,
        atlasUrl: entry.atlasUrl || entry.atlas,
        skin: entry.skin || "default",
        backgroundColor: "00000000",
        alpha: true,
        premultipliedAlpha: false,
        showControls: false,
        preserveDrawingBuffer: false,
        viewport: { padLeft: "6%", padRight: "6%", padTop: "6%", padBottom: "6%" },
        success: (loaded: SpinePlayerInstance) => {
          // Every stage of the clip plays on its own, so the banner keeps moving.
          const state = loaded.animationState;
          const animations = loaded.skeleton?.data?.animations ?? [];
          if (state && animations.length) {
            state.setAnimation(0, animations[0].name, true);
            animations.forEach((animation: { name: string }, index: number) => {
              if (index === 0) return;
              state.addAnimation(0, animation.name, true, 0);
            });
          }
          loaded.play?.();
          applyLook();
        },
        error: () => {
          // A work that will not play simply leaves the panel as it was.
        },
      } as never);
      applyLook();
    } catch {
      // Keep the page usable when a banner work fails to load.
    }
  }

  async function rotate() {
    if (stopped) return;
    const entry = await pickEntry();
    if (entry) await show(entry);
  }

  function schedule() {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      void rotate();
      schedule();
    }, ROTATION_MS);
  }

  void rotate();
  schedule();

  return {
    mount(banner: HTMLElement) {
      banner.append(layer);
    },
    start() {
      schedule();
    },
    dispose() {
      stopped = true;
      window.clearTimeout(timer);
      player?.dispose?.();
      layer.remove();
      label.remove();
    },
  };
}
