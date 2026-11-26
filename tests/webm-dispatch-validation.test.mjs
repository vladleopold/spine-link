import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWebmDispatch } from '../scripts/validate-webm-dispatch.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-webm-dispatch-'));
  const library = path.join(root, 'library_01');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'index.json'), '[]');
  return {
    root,
    library,
    writeIndex(entries) {
      fs.writeFileSync(path.join(library, 'index.json'), JSON.stringify(entries));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('stale dispatch for a deleted upload is acknowledged as a no-op', () => {
  const f = fixture();
  try {
    f.writeIndex([]);
    const result = validateWebmDispatch(f.root, 'deleted-upload-123', 'walk');
    assert.equal(result.found, false);
    assert.equal(result.reason, 'upload-not-indexed');
  } finally {
    f.cleanup();
  }
});

test('an index row whose upload directory was removed is treated as stale', () => {
  const f = fixture();
  try {
    f.writeIndex([{ id: 'upload-123' }]);
    const result = validateWebmDispatch(f.root, 'upload-123', 'walk');
    assert.equal(result.found, false);
    assert.equal(result.reason, 'upload-directory-missing');
  } finally {
    f.cleanup();
  }
});

test('a live indexed JSON+PNG upload is accepted only for an existing animation', () => {
  const f = fixture();
  try {
    const upload = path.join(f.library, 'upload-123');
    const set = path.join(upload, 'set-a');
    fs.mkdirSync(set, { recursive: true });
    fs.writeFileSync(path.join(set, 'skeleton.json'), JSON.stringify({
      bones: [{ name: 'root' }],
      animations: { walk: {}, idle: {} },
    }));
    fs.writeFileSync(path.join(set, 'body.png'), Buffer.from([137, 80, 78, 71]));
    f.writeIndex([{ id: 'upload-123' }]);

    const result = validateWebmDispatch(f.root, 'upload-123', 'walk');
    assert.equal(result.found, true);
    assert.equal(result.basePath, 'library_01');
    assert.equal(result.skeletonPath, path.join('library_01', 'upload-123', 'set-a', 'skeleton.json'));
  } finally {
    f.cleanup();
  }
});

test('a live upload with a removed animation is not sent to the exporter', () => {
  const f = fixture();
  try {
    const set = path.join(f.library, 'upload-123', 'set-a');
    fs.mkdirSync(set, { recursive: true });
    fs.writeFileSync(path.join(set, 'skeleton.json'), JSON.stringify({
      bones: [{ name: 'root' }],
      animations: { idle: {} },
    }));
    fs.writeFileSync(path.join(set, 'body.png'), Buffer.from([137, 80, 78, 71]));
    f.writeIndex([{ id: 'upload-123' }]);

    const result = validateWebmDispatch(f.root, 'upload-123', 'walk');
    assert.equal(result.found, false);
    assert.equal(result.reason, 'animation-not-found');
  } finally {
    f.cleanup();
  }
});


test('a live indexed binary .skel upload can be dispatched for runtime animation validation', () => {
  const f = fixture();
  try {
    const set = path.join(f.library, 'upload-123', 'set-a');
    fs.mkdirSync(set, { recursive: true });
    // Binary contents are intentionally opaque to this lightweight validator.
    // The exporter's pinned Spine runtime performs the authoritative track check.
    fs.writeFileSync(path.join(set, 'skeleton.skel'), Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(path.join(set, 'body.atlas'), 'body.png\nsize: 1,1\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n');
    fs.writeFileSync(path.join(set, 'body.png'), Buffer.from([137, 80, 78, 71]));
    f.writeIndex([{ id: 'upload-123', animations: [] }]);

    const result = validateWebmDispatch(f.root, 'upload-123', 'idle');
    assert.equal(result.found, true);
    assert.equal(result.skeletonPath, path.join('library_01', 'upload-123', 'set-a', 'skeleton.skel'));
  } finally {
    f.cleanup();
  }
});


test('JSON skeleton with indexed tracks can be dispatched for runtime default selection', () => {
  const f = fixture();
  try {
    const set = path.join(f.library, 'upload-123', 'set-a');
    fs.mkdirSync(set, { recursive: true });
    fs.writeFileSync(path.join(set, 'skeleton.json'), JSON.stringify({
      bones: [{ name: 'root' }],
      animations: { appear: {}, idle: {}, hit: {} },
    }));
    fs.writeFileSync(path.join(set, 'body.png'), Buffer.from([137, 80, 78, 71]));
    f.writeIndex([{ id: 'upload-123' }]);

    const result = validateWebmDispatch(f.root, 'upload-123', '__SPINE_AUTO__');
    assert.equal(result.found, true);
    assert.equal(result.runtimeDiscovery, true);
  } finally {
    f.cleanup();
  }
});

test('binary skeleton with no indexed animation can be dispatched for runtime discovery', () => {
  const f = fixture();
  try {
    const set = path.join(f.library, 'upload-123', 'set-a');
    fs.mkdirSync(set, { recursive: true });
    fs.writeFileSync(path.join(set, 'skeleton.skel'), Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(path.join(set, 'body.atlas'), 'body.png\nsize: 1,1\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n');
    fs.writeFileSync(path.join(set, 'body.png'), Buffer.from([137, 80, 78, 71]));
    f.writeIndex([{ id: 'upload-123', animations: [] }]);

    const result = validateWebmDispatch(f.root, 'upload-123', '__SPINE_AUTO__');
    assert.equal(result.found, true);
    assert.equal(result.binary, true);
    assert.equal(result.runtimeDiscovery, true);
  } finally {
    f.cleanup();
  }
});
