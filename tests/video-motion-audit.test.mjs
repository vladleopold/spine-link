import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { auditVideoMotion } from '../scripts/video-motion-audit.mjs';

function frameAt(position) {
  const width = 96, height = 96;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data[i * 4 + 3] = 255;
  const left = 8 + position * 7;
  for (let y = 28; y < 54; y += 1) {
    for (let x = left; x < left + 18; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 240;
      data[offset + 1] = 180;
      data[offset + 2] = 60;
    }
  }
  return data;
}

function fakeVideo(frames) {
  let index = 0;
  return {
    readyState: 2,
    videoWidth: 480,
    videoHeight: 360,
    paused: false,
    currentFrame: null,
    requestVideoFrameCallback(callback) {
      this.currentFrame = frames[Math.min(index, frames.length - 1)];
      index += 1;
      queueMicrotask(() => callback(performance.now(), { presentedFrames: index }));
    },
  };
}

async function withCanvas(run) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            current: null,
            drawImage(video) { this.current = video.currentFrame; },
            getImageData() { return { data: this.current }; },
          };
        },
      };
    },
  };
  try { return await run(); }
  finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test('archive playback acceptance requires eight distinct nonzero moving frames', async () => {
  await withCanvas(async () => {
    const frames = Array.from({ length: 12 }, (_, index) => frameAt(index));
    const result = await auditVideoMotion(fakeVideo(frames), {
      minDistinctFrames: 8, maxFrames: 16, timeoutMs: 1000,
    });
    assert.equal(result.ok, true);
    assert.ok(result.distinctFrames >= 8);
    assert.ok(result.nonzeroFrames >= 8);
    assert.ok(result.motionFrames >= 7);
  });
});

test('a valid but static video is rejected', async () => {
  await withCanvas(async () => {
    const still = frameAt(0);
    const result = await auditVideoMotion(fakeVideo(Array(12).fill(still)), {
      minDistinctFrames: 8, maxFrames: 12, timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.distinctFrames, 1);
    assert.equal(result.motionFrames, 0);
  });
});

test('empty frames and paused videos are rejected', async () => {
  await withCanvas(async () => {
    const empty = new Uint8ClampedArray(96 * 96 * 4);
    const black = await auditVideoMotion(fakeVideo(Array(12).fill(empty)), {
      minDistinctFrames: 8, maxFrames: 12, timeoutMs: 1000,
    });
    assert.equal(black.ok, false);
    assert.equal(black.nonzeroFrames, 0);
    const paused = fakeVideo([frameAt(0)]);
    paused.paused = true;
    assert.equal((await auditVideoMotion(paused)).reason, 'video-not-playing');
  });
});

test('the hourly Chromium audit wires the eight-frame motion gate into each playback sample', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/archive-live-speed.yml', import.meta.url), 'utf8');
  assert.match(workflow, /auditVideoMotion/);
  assert.match(workflow, /minDistinctFrames:\s*8/);
  assert.match(workflow, /sample-video-lacks-eight-distinct-motion-frames/);
  assert.match(workflow, /motionVerifiedSamples/);
  assert.match(workflow, /PREVIEW_BLOCKED=PREVIEW_NOT_PUBLIC/);
  assert.match(workflow, /continuing with production archive audit/);
  assert.match(workflow, /pr-preview-unavailable/);
});
