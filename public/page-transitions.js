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

  // Летящие искры фона живут отдельным модулем (spine-embers.js) и подключаются
  // самой страницей, поэтому работают и на страницах без этого файла.
})();
