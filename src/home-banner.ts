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
  previewPath?: string;
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
  indexRoot: string;
}): BannerHost {
  const { panel, indexRoot } = options;
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

  // The feed endpoint only carries poster material, while the banner needs the
  // skeleton itself, so entries come from the library index: it lists every
  // collection and holds the files needed to start a player.
  async function loadEntries(): Promise<BannerEntry[]> {
    const folders = listCollectionFolders();
    const found: BannerEntry[] = [];
    for (const folder of folders) {
      try {
        const response = await fetch(`${indexRoot}/${folder}/index.json?t=${Date.now()}`, {
          credentials: "same-origin",
        });
        if (!response.ok) continue;
        const entries = (await response.json().catch(() => [])) as BannerEntry[];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!entry || !entry.id) continue;
          const base = entry.previewPath || `${folder}/${entry.id}`;
          found.push({
            ...entry,
            skeleton: toAssetUrl(base, entry.skeleton),
            jsonUrl: toAssetUrl(base, entry.jsonUrl || entry.skeleton),
            atlas: toAssetUrl(base, entry.atlas),
            atlasUrl: toAssetUrl(base, entry.atlasUrl || entry.atlas),
          });
        }
      } catch {
        // A collection that cannot be read is simply skipped.
      }
    }
    return found;
  }

  // Collections are library_01, library_02, ...; the old `library` folder may
  // still hold works from before the rename, so it is probed too.
  function listCollectionFolders(): string[] {
    const folders = ["library"];
    for (let index = 1; index <= 40; index += 1) {
      folders.push(`library_${String(index).padStart(2, "0")}`);
    }
    return folders;
  }

  function toAssetUrl(base: string, file: unknown): string {
    const name = String(file || "").trim();
    if (!name) return "";
    if (/^https?:\/\//i.test(name)) return name;
    const cleanBase = String(base || "").replace(/^\/+/, "");
    return `/assets/${cleanBase}/${name.replace(/^\/+/, "")}`;
  }

  async function pickEntry(): Promise<BannerEntry | null> {
    const entries = await loadEntries();
    const candidates = entries.filter((entry) => entry.id && entry.skeleton && entry.atlas);
    if (!candidates.length) return null;
    // A random pick each round, so the banner does not follow a fixed order.
    const pool = candidates.filter((entry) => String(entry.id) !== currentId);
    const source = pool.length ? pool : candidates;
    return source[Math.floor(Math.random() * source.length)];
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
