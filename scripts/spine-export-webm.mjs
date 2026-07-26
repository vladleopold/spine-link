#!/usr/bin/env node

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = {
  uploadId: '',
  origin: 'https://spine-link.vercel.app',
  animation: '',
  defaultAnimation: '',
  output: '',
  repoPath: '.',
  basePath: 'library',
  owner: 'vladleopold',
  repo: 'spine',
  branch: 'main',
  githubToken: '',
};

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--upload-id=')) args.uploadId = arg.split('=')[1];
  else if (arg.startsWith('--origin=')) args.origin = arg.split('=')[1];
  else if (arg.startsWith('--animation=')) args.animation = arg.split('=')[1];
  else if (arg.startsWith('--default-animation=')) args.defaultAnimation = arg.split('=')[1];
  else if (arg.startsWith('--output=')) args.output = arg.split('=')[1];
  else if (arg.startsWith('--repo-path=')) args.repoPath = arg.split('=')[1];
  else if (arg.startsWith('--base-path=')) args.basePath = arg.split('=')[1];
  else if (arg.startsWith('--owner=')) args.owner = arg.split('=')[1];
  else if (arg.startsWith('--repo=')) args.repo = arg.split('=')[1];
  else if (arg.startsWith('--github-token=')) args.githubToken = arg.split('=')[1];
}

if (!args.uploadId) {
  console.error('Usage: spine-export-webm.mjs --upload-id=<id> --animation=<name> [options]');
  process.exit(1);
}

const repoRoot = path.resolve(args.repoPath);
const indexPath = path.join(repoRoot, args.basePath, 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`Index not found at ${indexPath}`);
  process.exit(1);
}

const indexEntries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const entry = indexEntries.find(e => e.id === args.uploadId);
if (!entry) {
  console.error(`Entry ${args.uploadId} not found in index`);
  process.exit(1);
}

const uploadPath = entry.previewPath || path.posix.join(args.basePath, args.uploadId);

function findSetDirectories(baseDir) {
  const results = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const dirPath = path.join(baseDir, dirent.name);
      try {
        const files = fs.readdirSync(dirPath);
        const hasSkeleton = files.some(f => /\.(json|skel)$/i.test(f));
        const hasAtlas = files.some(f => /\.(atlas|atlas\.txt|atlas\.docx)$/i.test(f));
        const hasImage = files.some(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
        if (hasSkeleton && hasAtlas && hasImage) {
          results.push({ name: dirent.name, path: dirPath });
        }
      } catch { }
    }
  } catch { }
  return results;
}

const previewDir = path.join(repoRoot, uploadPath);
const sets = findSetDirectories(previewDir);

if (sets.length === 0) {
  console.error(`No Spine sets found in ${previewDir}`);
  process.exit(1);
}

const firstSet = sets[0];
const setFiles = fs.readdirSync(firstSet.path);
const skeletonFile = setFiles.find(f => /\.(json|skel)$/i.test(f));
const atlasFile = setFiles.find(f => /\.(atlas|atlas\.txt|atlas\.docx)$/i.test(f));
const textureFiles = setFiles.filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

if (!skeletonFile || !atlasFile || textureFiles.length === 0) {
  console.error(`Set ${firstSet.name} is missing required files`);
  process.exit(1);
}

function detectSkeletonVersion(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return String(content?.skeleton?.spine || '').trim();
    }
    if (ext === '.skel') {
      const buffer = fs.readFileSync(filePath);
      const versionEnd = buffer.indexOf(0);
      if (versionEnd > 0) return buffer.toString('utf8', 0, versionEnd).trim();
      return buffer.toString('utf8', 0, Math.min(buffer.length, 80)).split('\0')[0].trim();
    }
  } catch { }
  return '4.0';
}

const skeletonFilePath = path.join(firstSet.path, skeletonFile);
const skeletonVersion = detectSkeletonVersion(skeletonFilePath);
const targetAnimation = args.animation || entry.defaultAnimation || '';

const versionMajor = skeletonVersion.split('.')[0] || '4';
const isLegacy = parseInt(versionMajor, 10) < 4;
const runtimeMinor = isLegacy ? (skeletonVersion.split('.')[1] || '8') : '';

const playerJsUrl = isLegacy
  ? `${args.origin}/vendor-spine-player-${versionMajor}.${runtimeMinor}.js`
  : 'https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/iife/spine-player.js';
const playerCssUrl = isLegacy
  ? `${args.origin}/vendor-spine-player-${versionMajor}.${runtimeMinor}.css`
  : 'https://cdn.jsdelivr.net/npm/@esotericsoftware/spine-player@4.3.13/dist/spine-player.css';

const skeletonKey = skeletonFile.toLowerCase().endsWith('.skel') ? 'skelUrl' : 'jsonUrl';
const atlasKey = 'atlasUrl';

const setSegments = [uploadPath, firstSet.name];

function rawUrl(filename) {
  return `https://raw.githubusercontent.com/${args.owner}/${args.repo}/${args.branch}/${setSegments.join('/')}/${encodeURIComponent(filename)}`;
}

const skeletonRawUrl = rawUrl(skeletonFile);
const atlasRawUrl = rawUrl(atlasFile);
const textureRawUrls = textureFiles.map(f => rawUrl(f));

const isDefault = args.animation && args.defaultAnimation && args.animation === args.defaultAnimation;

console.error(`Entry: ${args.uploadId}`);
console.error(`Set: ${firstSet.name}`);
console.error(`Skeleton: ${skeletonFile} (v${skeletonVersion})`);
console.error(`Atlas: ${atlasFile}`);
console.error(`Animation: ${targetAnimation}`);
console.error(`Is default: ${isDefault}`);

const captureHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${playerCssUrl}">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; background: #050607; overflow: hidden; }
#player { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="player"></div>
<script src="${playerJsUrl}"></script>
<script>
(function() {
  var config = {
    ${skeletonKey}: ${JSON.stringify(skeletonRawUrl)},
    ${atlasKey}: ${JSON.stringify(atlasRawUrl)},
    textures: ${JSON.stringify(textureRawUrls)},
    animation: ${JSON.stringify(targetAnimation)},
    showLoading: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    alpha: true,
    backgroundColor: '#050607',
    viewport: { padLeft: '14%', padRight: '14%', padTop: '14%', padBottom: '14%' },
  };

  var player;
  try {
    player = new spine.SpinePlayer('player', config);
  } catch (e) {
    window.__captureError = 'Player creation failed: ' + e.message;
    return;
  }

  player.canvas.addEventListener('webglcontextlost', function() {
    window.__captureError = 'WebGL context lost';
  });

  window.__startCapture = function() {
    var canvas = player.canvas;
    if (!canvas || canvas.width < 50 || canvas.height < 50) return;

    try {
      if (player.state && player.state.setAnimation) {
        player.state.setAnimation(0, ${JSON.stringify(targetAnimation)}, false);
      }
    } catch (e) {}

    var fps = 30;
    var mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    var mimeType = mimeTypes.find(function(t) { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t); });
    if (!mimeType) {
      window.__captureError = 'No supported webm mime type';
      return;
    }

    try {
      var stream = canvas.captureStream(fps);
      if (!stream || !stream.getVideoTracks || !stream.getVideoTracks().length) {
        window.__captureError = 'captureStream returned no video tracks';
        return;
      }

      var chunks = [];
      var recorder = new MediaRecorder(stream, {
        mimeType: mimeType,
        videoBitsPerSecond: Math.min(6000000, Math.max(1000000, canvas.width * canvas.height * 8)),
      });

      recorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = function() {
        stream.getTracks().forEach(function(t) { t.stop(); });
        if (chunks.length === 0) {
          window.__captureError = 'No data captured';
          return;
        }
        var blob = new Blob(chunks, { type: 'video/webm' });
        var reader = new FileReader();
        reader.onload = function() {
          window.__captureResult = {
            base64: reader.result.split(',')[1],
            mimeType: mimeType,
            width: canvas.width,
            height: canvas.height,
          };
        };
        reader.onerror = function() {
          window.__captureError = 'FileReader error';
        };
        reader.readAsDataURL(blob);
      };

      recorder.onerror = function() {
        window.__captureError = 'MediaRecorder error';
        stream.getTracks().forEach(function(t) { t.stop(); });
      };

      recorder.start(250);
      window.__recorder = recorder;

      var offscreen = document.createElement('canvas');
      offscreen.width = 80;
      offscreen.height = 60;
      var offCtx = offscreen.getContext('2d');

      var prevSum = null;
      var stableCount = 0;
      var recordingStart = Date.now();
      var MIN_RECORDING = 2000;
      var MAX_RECORDING = 60000;
      var STABLE_NEEDED = 10;
      var SAMPLE_MS = 100;

      function getFrameSum() {
        try {
          offCtx.drawImage(canvas, 0, 0, 80, 60);
          var data = offCtx.getImageData(0, 0, 80, 60).data;
          var sum = 0;
          for (var i = 0; i < data.length; i += 4) {
            sum += data[i] + data[i+1] + data[i+2];
          }
          return sum;
        } catch (e) {
          return prevSum !== null ? prevSum : 0;
        }
      }

      function checkStability() {
        if (recorder.state !== 'recording') return;

        var sum = getFrameSum();
        var elapsed = Date.now() - recordingStart;

        if (prevSum !== null) {
          var diff = Math.abs(sum - prevSum);
          if (diff < 300) {
            stableCount++;
            if (stableCount >= STABLE_NEEDED && elapsed >= MIN_RECORDING) {
              recorder.stop();
              return;
            }
          } else {
            stableCount = 0;
          }
        }
        prevSum = sum;

        if (elapsed >= MAX_RECORDING) {
          recorder.stop();
          return;
        }

        setTimeout(checkStability, SAMPLE_MS);
      }

      setTimeout(checkStability, SAMPLE_MS);
    } catch (e) {
      window.__captureError = 'Capture error: ' + e.message;
    }
  };

  var checkReady = function() {
    var canvas = player.canvas;
    if (canvas && canvas.width > 50 && canvas.height > 50) {
      setTimeout(window.__startCapture, 400);
    } else {
      setTimeout(checkReady, 300);
    }
  };

  setTimeout(checkReady, 600);
})();
</script>
</body>
</html>`;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
  ],
});

try {
  const context = await browser.newContext({
    viewport: { width: 960, height: 720 },
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();

  await page.setContent(captureHtml, { waitUntil: 'networkidle', timeout: 60000 });

  await page.waitForFunction(
    () => window.__captureResult !== null || window.__captureError,
    { timeout: 120000, polling: 500 },
  );

  const error = await page.evaluate(() => window.__captureError || null);
  if (error) {
    console.error(`Capture failed: ${error}`);
    process.exit(1);
  }

  const result = await page.evaluate(() => window.__captureResult);
  if (!result || !result.base64) {
    console.error('No capture result');
    process.exit(1);
  }

  const binary = Buffer.from(result.base64, 'base64');
  const outputPath = args.output || `${args.uploadId}-${targetAnimation}-preview.webm`;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, binary);

  console.error(`WebM saved: ${outputPath} (${binary.length} bytes, ${result.width}x${result.height})`);

  const sha256 = createHash('sha256').update(binary).digest('hex');
  console.log(JSON.stringify({ ok: true, path: outputPath, bytes: binary.length, width: result.width, height: result.height, sha256, isDefault }));

} finally {
  await browser.close();
}
