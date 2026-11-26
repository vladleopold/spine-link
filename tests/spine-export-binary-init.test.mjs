import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('binary skeleton version is detected before 2.x conversion reads it', () => {
  const source = fs.readFileSync(new URL('../scripts/spine-export-webm.mjs', import.meta.url), 'utf8');
  const detection = source.indexOf('const skeletonVersion = detectSkeletonVersion(skeletonFilePath);');
  const conversion = source.indexOf('convertedSkeletonPath = await convertSkeleton2xTo3x(skeletonFilePath, skeletonVersion);');
  assert.ok(detection >= 0, 'skeleton version detection must exist');
  assert.ok(conversion > detection, 'version must be initialized before it is passed to the converter');
});
