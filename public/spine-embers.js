/**
 * Искры Spine — летящие частицы на фоне, общие для всех страниц Spine-Link.
 *
 * Перенесено с фона галереи spinefolio.vercel.app: мягкие светящиеся искры
 * медленно поднимаются вверх, покачиваются на сквозняке, мерцают и отталкиваются
 * при свайпах по экрану. Рисуется на канве во весь экран, лежит под всем
 * контентом и никогда не перехватывает клики.
 *
 * Экономия ресурсов: учитывается prefers-reduced-motion (рисуется один
 * неподвижный кадр) и navigator.connection.saveData (меньше искр), а в
 * неактивной вкладке анимация останавливается.
 */
(function () {
  if (window.__spineEmbers) return;

  var reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var saveData = Boolean(navigator.connection && navigator.connection.saveData);

  // Те же четыре цвета, что и на исходном сайте.
  var COLORS = ["#22c55e", "#fde047", "#ef4444", "#ffffff"];
  var COUNT = reduceMotion || saveData ? 24 : 70;
  var MAX = 140;

  // Готовим sprite-текстуры: белое ядро с цветным ореолом, края растворяются.
  function makeSprites() {
    return COLORS.map(function (color) {
      var canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      var ctx = canvas.getContext("2d");
      var gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      gradient.addColorStop(0, "#ffffff");
      gradient.addColorStop(0.25, color);
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 32, 32);
      return canvas;
    });
  }

  function boot() {
    var canvas = document.createElement("canvas");
    canvas.className = "spine-embers-canvas";
    canvas.setAttribute("aria-hidden", "true");
    var ctx = canvas.getContext("2d");
    if (!ctx) return;

    var sprites = makeSprites();
    var width = window.innerWidth;
    var height = window.innerHeight;
    var frame = 0;
    var running = true;
    var time = 0;

    // side: 0 — появляется снизу, 1 — слева, 2 — справа.
    function spawn(side) {
      if (side === undefined) side = Math.floor(Math.random() * 4);
      var ember = {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: 0.15 + Math.random() * 0.45,
        r: 1.5 + Math.random() * 3.5,
        sprite: sprites[Math.floor(Math.random() * sprites.length)],
        life: 0.6 + Math.random() * 0.4,
        decay: 0.0006 + Math.random() * 0.0012,
        tw: Math.random() * Math.PI * 2,
        twSpeed: 0.02 + Math.random() * 0.05,
        gustX: 0,
        gustY: 0,
      };
      if (side === 0) {
        ember.y = -10;
        ember.x = Math.random() * width;
      } else if (side === 1) {
        ember.x = -10;
        ember.vx = Math.abs(ember.vx) + 0.2;
      } else if (side === 2) {
        ember.x = width + 10;
        ember.vx = -Math.abs(ember.vx) - 0.2;
      }
      return ember;
    }

    var embers = [];

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    }
    resize();
    // Первый набор искр раскладываем по всей площади экрана, чтобы при
    // открытии страницы фон был заполнен сразу, а не собирался в углу.
    for (var i = 0; i < COUNT; i++) {
      var seeded = spawn();
      seeded.x = Math.random() * width;
      seeded.y = Math.random() * height;
      embers.push(seeded);
    }

    // Свайп по тач-экране толкает все искры и поднимает небольшой залп.
    var lastX = null;
    var lastY = null;
    function onTouchStart(event) {
      var touch = event.touches[0];
      lastX = touch.clientX;
      lastY = touch.clientY;
    }
    function onTouchEnd(event) {
      if (lastX === null) return;
      var touch = event.changedTouches[0];
      var dx = touch.clientX - lastX;
      var dy = touch.clientY - lastY;
      var dist = Math.hypot(dx, dy);
      if (dist > 24) {
        var nx = dx / dist;
        var ny = dy / dist;
        var force = Math.min(6, 2 + dist / 60);
        embers.forEach(function (ember) {
          ember.gustX += nx * force;
          ember.gustY += ny * force;
        });
        for (var j = 0; j < 8; j++) {
          var burst = spawn(nx > 0 ? 2 : 1);
          burst.gustX = nx * force * 0.7;
          burst.gustY = ny * force * 0.7;
          embers.push(burst);
        }
        if (embers.length > MAX) embers = embers.slice(-MAX);
      }
      lastX = lastY = null;
    }

    function draw() {
      if (!running) return;
      time += 0.016;
      // Медленный порывистый ветер: две синусоиды разной частоты.
      var wind = Math.sin(time * 0.4) * 0.25 + Math.sin(time * 1.1) * 0.08;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";
      for (var i = embers.length - 1; i >= 0; i--) {
        var ember = embers[i];
        if (!reduceMotion) {
          ember.gustX *= 0.985;
          ember.gustY *= 0.985;
          ember.x += ember.vx + wind + ember.gustX;
          ember.y += ember.vy + ember.gustY * 0.6;
        }
        ember.tw += ember.twSpeed;
        ember.life -= ember.decay;
        var twinkle = 0.45 + 0.55 * Math.abs(Math.sin(ember.tw));
        var alpha = Math.max(0, Math.min(1, ember.life)) * twinkle;
        // Улетела за край или погасла — пересоздаём на противоположной стороне.
        if (ember.life <= 0 || ember.x < -20 || ember.x > width + 20 || ember.y > height + 20) {
          embers[i] = spawn();
          continue;
        }
        var size = ember.r * (0.6 + 0.4 * Math.abs(Math.sin(ember.tw * 0.7)));
        ctx.globalAlpha = alpha * 0.9;
        ctx.drawImage(ember.sprite, ember.x - size, ember.y - size, size * 2, size * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      frame = window.requestAnimationFrame(draw);
    }

    // На скрытой вкладке анимацию ставим на паузу.
    function onVisibility() {
      if (document.hidden) {
        running = false;
        window.cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        frame = window.requestAnimationFrame(draw);
      }
    }

    if (reduceMotion) {
      // Один неподвижный кадр: без ветра, без мерцания, без движения.
      // Прозрачность фиксированная, иначе почти погасшие искры не видно.
      ctx.globalCompositeOperation = "lighter";
      embers.forEach(function (ember) {
        var alpha = Math.max(0.25, Math.min(1, ember.life)) * 0.75;
        var size = ember.r * 0.85;
        ctx.globalAlpha = alpha;
        ctx.drawImage(ember.sprite, ember.x - size, ember.y - size, size * 2, size * 2);
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    } else {
      frame = window.requestAnimationFrame(draw);
    }

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    if (!reduceMotion) {
      window.addEventListener("touchstart", onTouchStart, { passive: true });
      window.addEventListener("touchend", onTouchEnd, { passive: true });
    }

    (document.body || document.documentElement).appendChild(canvas);
    window.__spineEmbers = true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
