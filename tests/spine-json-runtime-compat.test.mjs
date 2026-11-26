import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpineJsonForLegacy38Runtime } from '../lib/spine-json-runtime-compat.js';

test('converts object-keyed Spine 3.8 skins to named runtime skin records', () => {
  const source = JSON.stringify({
    skeleton: { spine: '3.8.97' },
    bones: [{ name: 'root' }],
    skins: {
      default: { body: { attachment: { type: 'region', path: 'body' } } },
      alternate: { body: { attachment: { type: 'region', path: 'body_alt' } } },
    },
    animations: { idle: {} },
  });
  const result = JSON.parse(normalizeSpineJsonForLegacy38Runtime(source));
  assert.deepEqual(result.skins.map(skin => skin.name), ['default', 'alternate']);
  assert.equal(result.skins[0].attachments.body.attachment.path, 'body');
  assert.equal(result.skins[1].attachments.body.attachment.path, 'body_alt');
  assert.equal(result.skeleton.spine, '3.8.97');
  assert.equal(result.animations.idle !== undefined, true);
});

test('leaves array-based Spine 3.8 skins unchanged', () => {
  const source = JSON.stringify({
    skeleton: { spine: '3.8.99' },
    skins: [{ name: 'default', attachments: { body: { attachment: { type: 'region' } } } }],
  });
  assert.equal(normalizeSpineJsonForLegacy38Runtime(source), source);
});

test('does not convert native Spine 4.x skin records', () => {
  const source = JSON.stringify({
    skeleton: { spine: '4.2.120' },
    skins: { default: { body: { attachment: { type: 'region' } } } },
  });
  assert.equal(normalizeSpineJsonForLegacy38Runtime(source), source);
});

test('rejects invalid Spine 3.8 skin-map entries instead of silently dropping them', () => {
  const source = JSON.stringify({ skeleton: { spine: '3.8.97' }, skins: { default: null } });
  assert.throws(() => normalizeSpineJsonForLegacy38Runtime(source), /Invalid Spine 3\.8 skin map entry/);
});

test('normalizes Buffer input for the versioned asset route and preserves its byte type', () => {
  const source = Buffer.from(JSON.stringify({
    skeleton: { spine: '3.8.97' },
    skins: { default: { body: { mesh: { type: 'mesh' } } } },
  }));
  const result = normalizeSpineJsonForLegacy38Runtime(source);
  assert.ok(Buffer.isBuffer(result));
  const data = JSON.parse(result.toString('utf8'));
  assert.equal(data.skins[0].name, 'default');
  assert.deepEqual(data.skins[0].attachments.body.mesh.uvs, []);
});
