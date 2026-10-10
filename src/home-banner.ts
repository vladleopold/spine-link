/**
 * Home-page drop panel host.
 *
 * The drag-drop panel shows no animation preview anymore — only the panel
 * itself and its pulse. This module used to mount a Spine player behind the
 * drop zone; it is now a no-op so the panel renders as a plain static affordance.
 */

type BannerHost = {
  mount(banner: HTMLElement): void;
  start(): void;
  dispose(): void;
};

export function mountHomeBanner(): BannerHost {
  return {
    mount() {},
    start() {},
    dispose() {},
  };
}
