const root = document.getElementById("root");
let isAppLoading = false;
let isAppMounted = false;
let bootDraggingState: boolean | null = null;
let stopBootParticles: (() => void) | null = null;
let bootParticleStartFrame = 0;

function renderBootShell(isDragging = false) {
  if (!root || isAppMounted) return;
  if (bootDraggingState === isDragging && root.querySelector(".app-shell")) return;
  bootDraggingState = isDragging;
  stopBootParticles?.();

  root.innerHTML = `
    <main class="app-shell is-empty ${isDragging ? "is-docking" : ""}">
      <canvas class="particle-field" aria-hidden="true"></canvas>
      <section class="seo-intro" aria-label="Spine-Link SEO description">
        <h1>Spine-Link online Spine preview and Spine web viewer</h1>
        <p>Spine-Link is a browser based Spine preview tool for Spine online workflows, Spine web previews, Spine webview links, JSON and SKEL animation files, atlas files, and texture images.</p>
      </section>
      <section class="workspace">
        <header class="topbar">
          <a class="brand-link" href="/" aria-label="Spine-Link home">
              <span class="brand-logo" aria-hidden="true">
              <span>S</span><span>P</span>
              <span class="brand-spine-mark"><i></i><i></i><i></i><i></i><i></i></span>
              <span>N</span><span>E</span><span class="brand-plus">LINK</span>
            </span>
          </a>
          <details class="site-menu">
            <summary class="site-menu-toggle" aria-label="Open site menu" title="Menu">
              <span></span><span></span><span></span>
            </summary>
            <nav class="site-menu-panel" aria-label="Site pages">
              <a href="/spine-animation-dataset.html">
                <strong>Animation Dataset</strong>
                <span>Curated Spine data page</span>
              </a>
              <a href="/spine-web-viewer.html">
                <strong>Web Viewer</strong>
                <span>Open Spine files online</span>
              </a>
              <a href="/spine-animation-preview.html">
                <strong>Animation Preview</strong>
                <span>Preview Spine animations</span>
              </a>
            </nav>
          </details>
          <div class="auth-panel">
            <button class="my-library-button" type="button" data-open-library>My Portfolio</button>
            <button class="google-fallback-button" type="button" data-open-app><span aria-hidden="true">G</span><span>Portfolio with Google</span></button>
          </div>
        </header>
        <label class="drop-zone boot-drop-zone ${isDragging ? "is-dragging" : ""}">
          <input type="file" multiple accept=".json,.skel,.atlas,.txt,.docx,.png,.jpg,.jpeg,.webp" data-file-input>
          <svg class="boot-upload-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v13m0-13 5 5m-5-5-5 5M5 15v4h14v-4" />
          </svg>
          <strong>Drag files here</strong>
          <span>json/skel, atlas, and one or more texture images</span>
        </label>
      </section>
      <a class="site-credit" href="https://t.me/vladleopold" target="_blank" rel="noreferrer">by leopold</a>
      <a class="world-archive-link" href="/world-spine-archive">WORLD SPINE ARCHIVE</a>
    </main>
  `;

  root.querySelectorAll<HTMLElement>("[data-open-app], [data-open-library]").forEach((button) => {
    button.addEventListener("click", () => void mountApp([], { openLibrary: button.hasAttribute("data-open-library") }));
  });
  root.querySelector<HTMLInputElement>("[data-file-input]")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files?.length) void mountApp(Array.from(input.files));
  });
  startBootParticles();
}

function renderLoadingShell() {
  if (!root) return;
  bootDraggingState = null;
  stopBootParticles?.();
  root.innerHTML = `
    <main class="app-shell is-empty">
      <canvas class="particle-field" aria-hidden="true"></canvas>
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
  startBootParticles();
}

function startBootParticles() {
  window.cancelAnimationFrame(bootParticleStartFrame);
  bootParticleStartFrame = window.requestAnimationFrame(() => {
    bootParticleStartFrame = window.requestAnimationFrame(startBootParticlesNow);
  });
}

function startBootParticlesNow() {
  const canvas = root?.querySelector<HTMLCanvasElement>(".particle-field");
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  const colors = ["255,255,255", "140,199,255", "255,106,40"];
  const particles: Array<{
    x: number;
    y: number;
    radius: number;
    speedX: number;
    speedY: number;
    alpha: number;
    pulse: number;
    color: string;
  }> = [];
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let animationFrame = 0;

  const resetParticle = (particle: (typeof particles)[number], randomizePosition = false) => {
    particle.x = Math.random() * width;
    particle.y = randomizePosition ? Math.random() * height : height + Math.random() * 80;
    particle.radius = 0.55 + Math.random() * 1.8;
    particle.speedX = (Math.random() - 0.5) * 0.16;
    particle.speedY = -(0.08 + Math.random() * 0.34);
    particle.alpha = 0.18 + Math.random() * 0.64;
    particle.pulse = Math.random() * Math.PI * 2;
    particle.color = colors[Math.floor(Math.random() * colors.length)];
  };

  const resize = () => {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.ceil(window.visualViewport?.width || window.innerWidth);
    height = Math.ceil(window.visualViewport?.height || window.innerHeight);
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const targetCount = Math.min(170, Math.max(72, Math.floor((width * height) / 9000)));
    while (particles.length < targetCount) {
      const particle = {} as (typeof particles)[number];
      resetParticle(particle, true);
      particles.push(particle);
    }
    particles.length = targetCount;
  };

  const draw = (time: number) => {
    context.clearRect(0, 0, width, height);

    for (const particle of particles) {
      particle.x += particle.speedX + Math.sin(time * 0.00025 + particle.pulse) * 0.035;
      particle.y += particle.speedY;

      if (particle.y < -24 || particle.x < -32 || particle.x > width + 32) {
        resetParticle(particle);
      }

      const alpha = particle.alpha * (0.68 + Math.sin(time * 0.0012 + particle.pulse) * 0.32);
      const glowRadius = particle.radius * 5.5;
      const gradient = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, glowRadius);
      gradient.addColorStop(0, `rgba(${particle.color}, ${alpha})`);
      gradient.addColorStop(0.42, `rgba(${particle.color}, ${alpha * 0.24})`);
      gradient.addColorStop(1, `rgba(${particle.color}, 0)`);
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2);
      context.fill();
    }

    animationFrame = window.requestAnimationFrame(draw);
  };

  resize();
  animationFrame = window.requestAnimationFrame(draw);
  window.addEventListener("resize", resize);

  stopBootParticles = () => {
    window.cancelAnimationFrame(bootParticleStartFrame);
    window.cancelAnimationFrame(animationFrame);
    window.removeEventListener("resize", resize);
    stopBootParticles = null;
  };
}

async function mountApp(initialFiles: File[] = [], options: { openLibrary?: boolean } = {}) {
  if (!root || isAppLoading || isAppMounted) return;
  isAppLoading = true;
  renderLoadingShell();

  const [{ createElement, StrictMode }, { createRoot }, { App }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./SpineApp"),
  ]);

  isAppMounted = true;
  stopBootParticles?.();
  createRoot(root).render(createElement(StrictMode, null, createElement(App, { initialFiles, initialOpenLibrary: options.openLibrary })));
}

renderBootShell();

if (new URLSearchParams(window.location.search).has("edit")) {
  void mountApp();
}

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  renderBootShell(true);
});

document.addEventListener("dragleave", (event) => {
  if (!root || root.contains(event.relatedTarget as Node | null)) return;
  renderBootShell(false);
});

document.addEventListener("drop", (event) => {
  event.preventDefault();
  renderBootShell(false);
  if (event.dataTransfer?.files.length) void mountApp(Array.from(event.dataTransfer.files));
});
