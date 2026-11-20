// Inspect decoded video frames in Chromium; do not accept a valid EBML header as proof of motion.
export async function auditVideoMotion(video, options = {}) {
  const minDistinctFrames = Number.isInteger(options.minDistinctFrames) && options.minDistinctFrames > 0
    ? options.minDistinctFrames : 8;
  const maxFrames = Number.isInteger(options.maxFrames) && options.maxFrames >= minDistinctFrames
    ? options.maxFrames : 48;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : 12000;
  const width = 96;
  const height = 96;
  const result = { ok: false, frames: 0, distinctFrames: 0, nonzeroFrames: 0, motionFrames: 0 };

  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.paused) {
    return { ...result, reason: 'video-not-playing' };
  }
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return { ...result, reason: 'video-frame-callback-unavailable' };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { ...result, reason: 'canvas-context-unavailable' };

  const signatures = new Set();
  let previous = null;
  const deadline = performance.now() + timeoutMs;
  while (result.frames < maxFrames && signatures.size < minDistinctFrames &&
         performance.now() < deadline) {
    const remaining = deadline - performance.now();
    const frame = await new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(null), Math.max(1, Math.min(1000, remaining)));
      try {
        video.requestVideoFrameCallback((now, metadata) => finish(metadata || { now }));
      } catch {
        finish(null);
      }
    });
    if (!frame) break;

    result.frames += 1;
    let pixels;
    try {
      context.drawImage(video, 0, 0, width, height);
      pixels = context.getImageData(0, 0, width, height).data;
    } catch {
      return { ...result, reason: 'video-frame-read-failed' };
    }

    const quantized = new Uint8Array(width * height * 3);
    let hash = 2166136261;
    let nonzeroPixels = 0;
    let changedPixels = 0;
    for (let source = 0, target = 0; source < pixels.length; source += 4, target += 3) {
      const red = pixels[source] >> 4;
      const green = pixels[source + 1] >> 4;
      const blue = pixels[source + 2] >> 4;
      quantized[target] = red;
      quantized[target + 1] = green;
      quantized[target + 2] = blue;
      if (pixels[source + 3] > 8 && red + green + blue > 0) nonzeroPixels += 1;
      hash = Math.imul(hash ^ red, 16777619);
      hash = Math.imul(hash ^ green, 16777619);
      hash = Math.imul(hash ^ blue, 16777619);
      if (previous) {
        const delta = Math.abs(red - previous[target]) +
          Math.abs(green - previous[target + 1]) +
          Math.abs(blue - previous[target + 2]);
        if (delta >= 3) changedPixels += 1;
      }
    }

    const signature = hash >>> 0;
    const minimumChangedPixels = Math.max(2, Math.ceil(width * height * 0.0005));
    if (nonzeroPixels > 0 && !signatures.has(signature) &&
        (!previous || changedPixels >= minimumChangedPixels)) {
      signatures.add(signature);
      result.nonzeroFrames += 1;
      if (previous) result.motionFrames += 1;
    }
    previous = quantized;
  }

  result.distinctFrames = signatures.size;
  result.ok = result.distinctFrames >= minDistinctFrames &&
    result.nonzeroFrames >= minDistinctFrames &&
    result.motionFrames >= minDistinctFrames - 1;
  return { ...result, reason: result.ok ? '' : 'insufficient-distinct-motion-frames' };
}
