(function () {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const hasNativeViewTransitions = "startViewTransition" in document;

  function isPlainLeftClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  function shouldTransition(link) {
    if (!link || link.target || link.hasAttribute("download") || link.dataset.noTransition === "true") return false;
    const href = link.getAttribute("href") || "";
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return false;

    const targetUrl = new URL(href, window.location.href);
    if (targetUrl.origin !== window.location.origin) return false;

    const sameDocument =
      targetUrl.pathname === window.location.pathname &&
      targetUrl.search === window.location.search &&
      targetUrl.hash;
    return !sameDocument;
  }

  if (!reduceMotion && !hasNativeViewTransitions) {
    document.addEventListener(
      "click",
      (event) => {
        if (!isPlainLeftClick(event)) return;
        const link = event.target?.closest?.("a[href]");
        if (!shouldTransition(link)) return;

        event.preventDefault();
        root.classList.add("spine-page-leaving");
        window.setTimeout(() => {
          window.location.href = link.href;
        }, 150);
      },
      true,
    );

    window.addEventListener("pageshow", () => {
      root.classList.remove("spine-page-leaving");
    });
  }

  function startQuietSeoParticles() {
    return;
    if (document.getElementById("root") || document.getElementById("app") || document.querySelector(".library-grid") || document.querySelector(".grid .tile")) return;
    if (document.querySelector(".particle-field")) return;
    const canvas = document.createElement("canvas");
    canvas.className = "particle-field particle-field--seo";
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.particleMode = "quiet";
    document.body.prepend(canvas);

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const saveData = Boolean(navigator.connection?.saveData);
    const particles = [];
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let frame = 0;

    function resize() {
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.ceil(window.visualViewport?.width || window.innerWidth || 1);
      height = Math.ceil(window.visualViewport?.height || window.innerHeight || 1);
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const count = saveData ? 14 : Math.max(18, Math.min(42, Math.round((width * height) / 46000)));
      while (particles.length < count) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: 0.7 + Math.random() * 1.8,
          a: 0.08 + Math.random() * 0.22,
          s: 0.035 + Math.random() * 0.11,
          w: Math.random() * Math.PI * 2,
          c: Math.random() > 0.58 ? "255,106,40" : "92,194,255",
        });
      }
      particles.length = count;
    }

    function draw(time) {
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";
      for (const p of particles) {
        p.y -= p.s;
        p.x += Math.sin(time * 0.00025 + p.w) * 0.035;
        if (p.y < -12) {
          p.y = height + Math.random() * 32;
          p.x = Math.random() * width;
        }
        const alpha = p.a * (0.72 + Math.sin(time * 0.0008 + p.w) * 0.18);
        context.fillStyle = `rgba(${p.c}, ${alpha * 0.12})`;
        context.beginPath();
        context.arc(p.x, p.y, p.r * 2.4, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = `rgba(${p.c}, ${alpha})`;
        context.beginPath();
        context.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        context.fill();
      }
      context.globalCompositeOperation = "source-over";
      frame = window.requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener("resize", resize);
    if (!reduceMotion) frame = window.requestAnimationFrame(draw);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) window.cancelAnimationFrame(frame);
      else if (!reduceMotion) frame = window.requestAnimationFrame(draw);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startQuietSeoParticles, { once: true });
  } else {
    startQuietSeoParticles();
  }
})();
