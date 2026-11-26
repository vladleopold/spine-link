import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const exporter = fs.readFileSync(new URL('../scripts/spine-export-webm.mjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/spine-export-webm.yml', import.meta.url), 'utf8');

test('binary skeleton without indexed tracks discovers names using the pinned runtime before selection', () => {
  const warmup = exporter.indexOf('async function warmUpAnimations()');
  const discovery = exporter.indexOf('availableAnimations = await warmUpAnimations()');
  const capture = exporter.indexOf('const captureAnimation = targetAnimation');
  assert.ok(warmup >= 0);
  assert.ok(discovery > warmup && capture > discovery);
  assert.match(exporter, /Discovering binary Spine animation names with the pinned runtime/);
});

test('export metadata records the exact chosen animation and workflow persists it as previewAnimation', () => {
  assert.match(exporter, /const meta = \{[\s\S]*?animation: targetAnimation/);
  assert.match(workflow, /previewAnimation: videoMeta\.animation/);
  assert.match(workflow, /previewStatus: 'ready'/);
});
