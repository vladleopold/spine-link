import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

const previewSource = readFileSync(new URL('../api/github-preview.js', import.meta.url), 'utf8');

test('Spine 3.8 previews use the same-origin bundled runtime', () => {
  assert.match(
    previewSource,
    /const base = "\/vendor-spine-player-3\.8";\s*setPlayerStylesheet\(base \+ "\.css"\);\s*await loadScriptOnce\(base \+ "\.js"\);/,
  );
  assert.ok(existsSync(new URL('../public/vendor-spine-player-3.8.js', import.meta.url)));
  assert.ok(existsSync(new URL('../public/vendor-spine-player-3.8.css', import.meta.url)));
});
