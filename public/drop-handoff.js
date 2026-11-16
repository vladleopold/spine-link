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

  // Resolve filesystem entries before the DataTransfer object is invalidated.
  // A directory in dataTransfer.files is not an enumerable list of its files.
  async function readEntry(entry, parents) {
    if (entry.isFile) {
      var file = await new Promise(function (resolve, reject) {
        entry.file(resolve, reject);
      });
      return [{ file: file, path: parents.concat(entry.name).join("/") }];
    }
    if (!entry.isDirectory) return [];
    var reader = entry.createReader();
    var children = [];
    // readEntries is paged by Chromium: a single call can omit most textures.
    while (true) {
      var batch = await new Promise(function (resolve, reject) {
        reader.readEntries(resolve, reject);
      });
      if (!batch.length) break;
      children.push.apply(children, batch);
    }
    var nested = await Promise.all(children.map(function (child) {
      return readEntry(child, parents.concat(entry.name));
    }));
    return nested.flat();
  }

  async function store(files) {
    if (!("caches" in window)) return false;
    if (!files.length || files.length > 3000) throw Error("Unsupported drop size");
    var total = 0;
    for (var n = 0; n < files.length; n += 1) {
      total += files[n].file.size || 0;
      if (total > 512 * 1024 * 1024) throw Error("Drop exceeds browser handoff limit");
    }
    // A failed partial handoff must never mix with an earlier manifest.
    await caches.delete(CACHE);
    var cache = await caches.open(CACHE);
    var request = new Request("/__spine_drop__/manifest", { cache: "no-store" });
    var names = [];
    for (var i = 0; i < files.length; i += 1) {
      var key = "/__spine_drop__/f" + i;
      var file = files[i].file;
      await cache.put(
        new Request(key, { method: "GET" }),
        new Response(file, { headers: { "content-type": file.type || "application/octet-stream" } })
      );
      names.push({ key: key, name: file.name, path: files[i].path,
        type: file.type || "", lastModified: file.lastModified || 0 });
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
      var transfer = event.dataTransfer;
      // IMPORTANT: entry handles must be acquired synchronously during drop.
      var entries = Array.prototype.slice.call(transfer.items || [])
        .filter(function (item) { return item.kind === "file"; })
        .map(function (item) { return item.webkitGetAsEntry && item.webkitGetAsEntry(); })
        .filter(Boolean);
      var flatFiles = Array.prototype.slice.call(transfer.files || []);
      if (!entries.length && !flatFiles.length) return;
      show();
      overlay.textContent = "Preparing Spine files...";
      var selection = entries.length
        ? Promise.all(entries.map(function (entry) { return readEntry(entry, []); }))
            .then(function (groups) { return groups.flat(); })
        : Promise.resolve(flatFiles.map(function (file) {
            return { file: file, path: file.webkitRelativePath || file.name };
          }));
      selection.then(store).then(
        function (ok) {
          // All file bytes and relative texture paths are now persisted.
          window.location.assign(ok ? TARGET : "/?upload=work&nodrop=1");
        },
        function () {
          // Unsupported browser or quota exceeded: never claim the drop was saved.
          window.location.assign("/?upload=work&nodrop=1");
        }
      );
    },
    true
  );
})();
