import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeVersionOverrideForSpineSkeleton } from '../lib/spine-runtime-file-selection.js';
import { sanitizeSkeletonJson } from '../lib/spine-json-sanitize.js';

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

test('sanitizes Spine 3.8 object-keyed skins without losing its runtime version', () => {
  const source = {
    skeleton: {spine:'3.8.97'},
    skins: {default: {body: {mesh: {type:'mesh'}}}},
  };
  const result = sanitizeSkeletonJson(source);
  assert.equal(result.skeleton.spine, '3.8.97');
  assert.equal(result.skins[0].name, 'default');
  assert.deepEqual(result.skins[0].attachments.body.mesh.uvs, []);
  assert.deepEqual(result.skins[0].attachments.body.mesh.vertices, []);
  assert.deepEqual(result.skins[0].attachments.body.mesh.triangles, []);
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
