/*
 * Drop handoff for the server-rendered pages (world archive, /p/:id, /u/:id).
 *
 * Those pages are plain HTML with no app bundle, so a dropped file had nothing
 * to react to and the browser silently did nothing. This captures the drop,
 * parks the files in the Cache API, and navigates to the upload page, which
 * picks them back up (see restoreDroppedFiles in src/main.tsx).
 *
 * Kept dependency-free and small on purpose: it is served straight from
 * public/ and loaded by pages that ship no JavaScript otherwise.
 */
(function () {
  if (window.__spineDropHandoff) return;
  window.__spineDropHandoff = true;

  var CACHE = "spine-drop-handoff";
  var TARGET = "/?upload=work&restored=1";
  var overlay = null;
  var depth = 0;

  function hasFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i += 1) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  function show() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "spine-dnd-overlay";
    overlay.textContent = "Drop to open the Spine uploader";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483000",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:rgba(6,8,12,0.82)",
      "color:#fff",
      "font:600 20px/1.4 system-ui,-apple-system,Segoe UI,sans-serif",
      "letter-spacing:0.01em",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(overlay);
  }

  function hide() {
    depth = 0;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  async function store(files) {
    if (!("caches" in window)) return false;
    var cache = await caches.open(CACHE);
    var request = new Request("/__spine_drop__/manifest", { cache: "no-store" });
    var names = [];
    for (var i = 0; i < files.length; i += 1) {
      var key = "/__spine_drop__/f" + i;
      await cache.put(
        new Request(key, { method: "GET" }),
        new Response(files[i], { headers: { "content-type": files[i].type || "application/octet-stream" } })
      );
      names.push({ key: key, name: files[i].name, type: files[i].type || "", lastModified: files[i].lastModified || 0 });
    }
    await cache.put(request, new Response(JSON.stringify(names), { headers: { "content-type": "application/json" } }));
    return true;
  }

  document.addEventListener(
    "dragenter",
    function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      show();
    },
    true
  );

  document.addEventListener(
    "dragover",
    function (event) {
      if (!hasFiles(event)) return;
      // Without preventDefault the browser navigates to the dropped file and
      // the page is simply replaced.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    },
    true
  );

  document.addEventListener(
    "dragleave",
    function (event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) hide();
    },
    true
  );

  document.addEventListener(
    "drop",
    function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      hide();
      var files = Array.prototype.slice.call(event.dataTransfer.files || []);
      if (!files.length) return;
      show();
      store(files).then(
        function (ok) {
          if (ok) {
            window.location.assign(TARGET);
            return;
          }
          // No Cache API: send the user to the uploader and ask for a re-drop.
          window.location.assign("/?upload=work&nodrop=1");
        },
        function () {
          window.location.assign("/?upload=work&nodrop=1");
        }
      );
    },
    true
  );
})();
