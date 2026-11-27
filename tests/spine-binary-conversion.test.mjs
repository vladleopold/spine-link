import test from 'node:test';
import assert from 'node:assert/strict';
import { convertLegacySpineAsset } from '../lib/spine-binary-conversion.js';

function fakeConverter(detected, result = {}) {
  let optionsSeen;
  return {
    get optionsSeen() { return optionsSeen; },
    detect() { return detected; },
    convert(_bytes, options) {
      optionsSeen = options;
      return { data: new Uint8Array([123, 125]), lossCount: 0, maxImpact: 'none', report: [], ...result };
    },
  };
}

test('converts Spine 3.7 binary skeleton data to Spine 4.3 JSON', async () => {
  const converter = fakeConverter({ format: 'binary', version: '3.7.94' });
  const result = await convertLegacySpineAsset(new Uint8Array([1, 2, 3]), 'skeleton', converter);
  assert.equal(result.sourceVersion, '3.7.94');
  assert.equal(result.targetVersion, '4.3');
  assert.deepEqual([...result.buffer], [123, 125]);
  assert.deepEqual(converter.optionsSeen, {
    targetVersion: '4.3',
    targetFormat: 'json',
    failOnLoss: false,
  });
});

test('converts a legacy atlas to the matching Spine 4.3 atlas format', async () => {
  const converter = fakeConverter({ format: 'atlas', version: '3.7' });
  const result = await convertLegacySpineAsset(new TextEncoder().encode('page.png'), 'atlas', converter);
  assert.equal(result.targetVersion, '4.3');
  assert.equal(converter.optionsSeen.targetFormat, 'atlas');
});

test('does not route JSON or other binary versions through the legacy conversion', async () => {
  await assert.rejects(
    convertLegacySpineAsset(new Uint8Array([1]), 'skeleton', fakeConverter({ format: 'json', version: '3.7.94' })),
    /Only Spine 3.7 binary/,
  );
  await assert.rejects(
    convertLegacySpineAsset(new Uint8Array([1]), 'skeleton', fakeConverter({ format: 'binary', version: '4.0.64' })),
    /Only Spine 3.7 binary/,
  );
});

test('rejects malformed or empty conversion output', async () => {
  await assert.rejects(
    convertLegacySpineAsset(new Uint8Array(0), 'skeleton', fakeConverter({ format: 'binary', version: '3.7.94' })),
    /non-empty/,
  );
  await assert.rejects(
    convertLegacySpineAsset(new Uint8Array([1]), 'skeleton', fakeConverter(
      { format: 'binary', version: '3.7.94' }, { data: new Uint8Array(0) },
    )),
    /empty asset/,
  );
});
