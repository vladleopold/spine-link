import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeVersionOverrideForSpineSkeleton } from '../lib/spine-runtime-file-selection.js';
import { sanitizeSkeletonJson, sanitizeSkeletonJsonText } from '../lib/spine-json-sanitize.js';

test('rejects incompatible Spine 3.7 binary skeletons instead of routing them to 3.8', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('3.7.94', true), '');
});

test('keeps Spine 3.7 JSON skeletons on their native 3.7 player', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('3.7.94', false), '');
});

test('does not override native Spine 3.8 binary runtime selection', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('3.8.99', true), '');
});

test('does not override Spine 4.x runtime selection', () => {
  assert.equal(runtimeVersionOverrideForSpineSkeleton('4.2.120', true), '');
});

test('normalizes legacy object-keyed Spine 3.8 skins into the runtime array format', () => {
  const source = {
    skeleton: {spine:'3.8.97'},
    skins: {default: {body: {mesh: {type:'mesh'}}}},
  };
  const result = sanitizeSkeletonJson(source);
  assert.ok(Array.isArray(result.skins));
  assert.equal(result.skins[0].name, 'default');
  assert.equal(result.skins[0].attachments.body.mesh.type, 'mesh');
  assert.deepEqual(result.skins[0].attachments.body.mesh.uvs, []);
  assert.deepEqual(result.skins[0].attachments.body.mesh.vertices, []);
  assert.deepEqual(result.skins[0].attachments.body.mesh.triangles, []);
});

test('keeps Spine 3.7 object-keyed skins in their native format', () => {
  const source = {skeleton:{spine:'3.7.94'},skins:{default:{body:{image:{type:'region'}}}}};
  const result = sanitizeSkeletonJson(source);
  assert.equal(Array.isArray(result.skins), false);
  assert.ok(result.skins.default.body.image);
});

test('continues to sanitize Spine 4.x array-based skin records', () => {
  const source = {
    skeleton: {spine:'4.2.120'},
    skins: [{name:'default', attachments:{body:{mesh:{type:'mesh'}}}}],
  };
  const result = sanitizeSkeletonJson(source);
  assert.equal(result.skins[0].name, 'default');
  assert.deepEqual(result.skins[0].attachments.body.mesh.uvs, []);
});
test('continues to sanitize Spine 4.x array-based skin records', () => {
  const source = {
    skeleton: {spine:'4.2.120'},
    skins: [{name:'default', attachments:{body:{mesh:{type:'mesh'}}}}],
  };
  const result = sanitizeSkeletonJson(source);
  assert.equal(result.skeleton.spine, '4.2.120');
  assert.deepEqual(result.skins[0].attachments.body.mesh.uvs, []);
});

test('normalizes the actual Spine 3.8 JSON asset response before serving it to the player', () => {
  const source = JSON.stringify({
    skeleton:{spine:'3.8.97'},
    skins:{default:{body:{mesh:{type:'mesh'}}}},
  });
  const normalized = JSON.parse(sanitizeSkeletonJsonText(source));
  assert.ok(Array.isArray(normalized.skins));
  assert.equal(normalized.skins[0].name, 'default');
  assert.ok(normalized.skins[0].attachments.body.mesh);
});

test('leaves unrelated JSON assets untouched by the Spine sanitizer', () => {
  const source = '{"name":"not-a-skeleton","items":[1,2,3]}';
  assert.equal(sanitizeSkeletonJsonText(source), source);
});
