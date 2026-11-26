import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/SpineApp.tsx', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../scripts/spine-export-webm.mjs', import.meta.url), 'utf8');

test('Spine Player does not turn missing atlas regions into null attachments', () => {
  assert.doesNotMatch(app, /patchAtlasAttachmentLoader|__spinePatched/);
  assert.doesNotMatch(app, /msg\.includes\("Region not set"\)|msg\.includes\("Region not found"\)/);
  assert.match(app, /\.catch\(\(runtimeError: unknown\) =>/);
  assert.match(app, /runtimeError\.message/);
  assert.match(app, /success: \(player: SpinePlayerInstance\) =>/);
  assert.match(app, /setAnimations\(names\)/);
});

test('WebM renderer preserves Spine runtime atlas diagnostics', () => {
  assert.doesNotMatch(renderer, /window\.__spinePatched|AtlasAttachmentLoader\.prototype|p\.findRegion\s*=|computeUVs\s*=/);
  assert.match(renderer, /error: function \(p, err\)/);
  assert.match(renderer, /window\.__captureError = 'Player creation failed: ' \+ err/);
});
