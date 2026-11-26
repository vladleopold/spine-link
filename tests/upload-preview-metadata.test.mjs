import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('background upload sends parsed Spine animation names and an explicit default animation', () => {
  assert.match(source, /spineAnimationMetadataFromJson/);
  assert.match(source, /animations:\s*animationMetadata\.animations/);
  assert.match(source, /defaultAnimation:\s*animationMetadata\.defaultAnimation/);
  assert.match(source, /runtimeSkeletonFile\s*&&\s*\/\\.skel\$\/i\.test\(runtimeSkeletonFile\.name\)/);
  assert.match(source, /defaultAnimation:\s*"__SPINE_AUTO__"/);
});

test('the upload metadata parser selects the first real Spine animation without inventing one', async () => {
  const { spineAnimationMetadataFromJson } = await import('../lib/spine-upload-animation-metadata.js');
  assert.deepEqual(
    spineAnimationMetadataFromJson(JSON.stringify({ animations: { idle: {}, walk: {}, jump: {} } })),
    { animations: ['idle', 'walk', 'jump'], defaultAnimation: 'idle' },
  );
  assert.deepEqual(
    spineAnimationMetadataFromJson(JSON.stringify({ skeleton: { hash: 'abc' } })),
    { animations: [], defaultAnimation: '' },
  );
  assert.deepEqual(
    spineAnimationMetadataFromJson('{broken'),
    { animations: [], defaultAnimation: '' },
  );
});
