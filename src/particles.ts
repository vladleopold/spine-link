/**
 * Искры Spine — летящие частицы фона.
 *
 * Перенесено с фона галереи spinefolio.vercel.app: светящиеся искры
 * поднимаются вверх, покачиваются на медленном ветру, мерцают и
 * отталкиваются при свайпах по тач-экрану.
 *
 * Экономия ресурсов: учитываются prefers-reduced-motion (рисуется один
 * неподвижный кадр) и navigator.connection.saveData (меньше искр),
 * в неактивной вкладке анимация останавливается.
 */

/** Цвета искр — те же четыре, что и на исходном сайте. */
const EMBER_COLORS = ["#22c55e", "#fde047", "#ef4444", "#ffffff"];

/** Базовая плотность частиц и потолок после свайпов. */
const BASE_COUNT = 70;
const MAX_COUNT = 140;

type Ember = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  sprite: HTMLCanvasElement;
  life: number;
  decay: number;
  twinkle: number;
  twinkleSpeed: number;
  gustX: number;
  gustY: number;
};

/** Откуда появилась искра: снизу, слева или справа. */
type SpawnSide = 0 | 1 | 2 | 3;

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function prefersReducedData() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return Boolean(connection?.saveData);
}

/** Готовим текстуры: белое ядро с цветным ореолом, края растворяются. */
function createSprites(): HTMLCanvasElement[] {
  return EMBER_COLORS.map((color) => {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 32;
    const context = sprite.getContext("2d");
    if (!context) return sprite;
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.25, color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
    return sprite;
  });
}

/**
 * Запускает поле искр на канве и возвращает функцию остановки.
 * Канва должна лежать в DOM: сам скрипт её не создаёт.
 */
export function startParticleField(canvas: HTMLCanvasElement) {
  const rawContext = canvas.getContext("2d");
  if (!rawContext) return () => {};
  const context: CanvasRenderingContext2D = rawContext;

  const reducedMotion = prefersReducedMotion();
  const reducedData = prefersReducedData();
  const sprites = createSprites();

  let width = 0;
  let height = 0;
  let animationFrame = 0;
  let running = !document.hidden;
  let time = 0;

  function spawn(side?: SpawnSide): Ember {
    const origin = side ?? ((Math.random() * 4) as SpawnSide);
    const ember: Ember = {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: 0.15 + Math.random() * 0.45,
      radius: 1.5 + Math.random() * 3.5,
      sprite: sprites[Math.floor(Math.random() * sprites.length)],
      life: 0.6 + Math.random() * 0.4,
      decay: 0.0006 + Math.random() * 0.0012,
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.02 + Math.random() * 0.05,
      gustX: 0,
      gustY: 0,
    };

    if (origin === 0) {
      ember.y = -10;
      ember.x = Math.random() * width;
    } else if (origin === 1) {
      ember.x = -10;
      ember.vx = Math.abs(ember.vx) + 0.2;
    } else if (origin === 2) {
      ember.x = width + 10;
      ember.vx = -Math.abs(ember.vx) - 0.2;
    }

    return ember;
  }

  const count = reducedMotion || reducedData ? 24 : BASE_COUNT;
  const embers: Ember[] = [];

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
  }

  function draw() {
    if (!running) return;

    // Медленный порывистый ветер: две синусоиды разной частоты.
    const wind = Math.sin(time * 0.4) * 0.25 + Math.sin(time * 1.1) * 0.08;
    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = "lighter";

    for (let i = embers.length - 1; i >= 0; i--) {
      const ember = embers[i];

      if (!reducedMotion) {
        ember.gustX *= 0.985;
        ember.gustY *= 0.985;
        ember.x += ember.vx + wind + ember.gustX;
        ember.y += ember.vy + ember.gustY * 0.6;
        ember.twinkle += ember.twinkleSpeed;
        ember.life -= ember.decay;
      }

      const shimmer = 0.45 + 0.55 * Math.abs(Math.sin(ember.twinkle));
      const alpha = Math.max(0, Math.min(1, ember.life)) * shimmer;

      // Улетела за край или погасла — пересоздаём на противоположной стороне.
      if (ember.life <= 0 || ember.x < -20 || ember.x > width + 20 || ember.y > height + 20) {
        embers[i] = spawn();
        continue;
      }

      const size = ember.radius * (0.6 + 0.4 * Math.abs(Math.sin(ember.twinkle * 0.7)));
      context.globalAlpha = alpha * 0.9;
      context.drawImage(ember.sprite, ember.x - size, ember.y - size, size * 2, size * 2);
    }

    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    time += 0.016;
    animationFrame = window.requestAnimationFrame(draw);
  }

  // Свайп по тач-экране толкает все искры и поднимает небольшой залп.
  let lastX: number | null = null;
  let lastY: number | null = null;

  function handleTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    if (!touch) return;
    lastX = touch.clientX;
    lastY = touch.clientY;
  }

  function handleTouchEnd(event: TouchEvent) {
    if (lastX === null || lastY === null) return;
    const touch = event.changedTouches[0];
    if (!touch) {
      lastX = lastY = null;
      return;
    }

    const dx = touch.clientX - lastX;
    const dy = touch.clientY - lastY;
    const distance = Math.hypot(dx, dy);

    if (distance > 24) {
      const pushX = dx / distance;
      const pushY = dy / distance;
      const force = Math.min(6, 2 + distance / 60);

      for (const ember of embers) {
        ember.gustX += pushX * force;
        ember.gustY += pushY * force;
      }
      for (let i = 0; i < 8; i++) {
        const burst = spawn(pushX > 0 ? 2 : 1);
        burst.gustX = pushX * force * 0.7;
        burst.gustY = pushY * force * 0.7;
        embers.push(burst);
      }
      if (embers.length > MAX_COUNT) embers.splice(0, embers.length - MAX_COUNT);
    }

    lastX = lastY = null;
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      running = false;
      window.cancelAnimationFrame(animationFrame);
    } else if (!running) {
      running = true;
      animationFrame = window.requestAnimationFrame(draw);
    }
  }

  resize();
  // Первый набор искр раскладываем по всей площади экрана, а не у левого
  // верхнего угла: при открытии страницы фон уже заполнен, частицы не
  // собираются в одну кучу и сразу видны по всей высоте.
  for (let i = 0; i < count; i++) {
    const ember = spawn();
    ember.x = Math.random() * width;
    ember.y = Math.random() * height;
    embers.push(ember);
  }

  if (reducedMotion) {
    // Один неподвижный кадр: без ветра, без мерцания, без движения.
    // Прозрачность фиксированная, иначе почти погасшие искры не видно.
    context.globalCompositeOperation = "lighter";
    for (const ember of embers) {
      const alpha = Math.max(0.25, Math.min(1, ember.life)) * 0.75;
      const size = ember.radius * 0.85;
      context.globalAlpha = alpha;
      context.drawImage(ember.sprite, ember.x - size, ember.y - size, size * 2, size * 2);
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  } else {
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    animationFrame = window.requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    running = false;
    window.cancelAnimationFrame(animationFrame);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("touchstart", handleTouchStart);
    window.removeEventListener("touchend", handleTouchEnd);
    context.clearRect(0, 0, width, height);
  };
}
