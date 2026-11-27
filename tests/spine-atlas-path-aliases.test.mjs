import test from 'node:test';
import assert from 'node:assert/strict';
import { addSpineAtlasPathAliases } from '../lib/spine-atlas-path-aliases.js';

const atlas = `page.png
  size: 256, 256
  filter: Linear, Linear
body
  bounds: 0, 0, 32, 48
face
  bounds: 32, 0, 16, 16

page-two.png
  size: 128, 128
hair
  bounds: 0, 0, 20, 20
`;

test('adds aliases for folder-qualified attachment paths without changing packed bounds', () => {
  const skeleton = { skins: [{ name: 'default', attachments: {
    bodySlot: { 'parts/body': { type: 'region' } },
    faceSlot: { face: { type: 'region', path: 'new/face' } },
  } }] };
  const result = addSpineAtlasPathAliases(atlas, skeleton);
  assert.match(result, /parts\/body\n  bounds: 0, 0, 32, 48/);
  assert.match(result, /new\/face\n  bounds: 32, 0, 16, 16/);
  assert.match(result, /page-two\.png\n  size: 128, 128\nhair\n  bounds: 0, 0, 20, 20/);
});

test('keeps duplicate base regions distinct and maps qualified names in encounter order', () => {
  const duplicateAtlas = `page.png
  size: 128, 128
eye
  bounds: 0, 0, 10, 10
eye
  bounds: 10, 0, 12, 12
`;
  const skeleton = { skins: [{ name: 'default', attachments: {
    first: { 'left/eye': { type: 'region' } },
    second: { 'right/eye': { type: 'region' } },
  } }] };
  const result = addSpineAtlasPathAliases(duplicateAtlas, skeleton);
  assert.match(result, /left\/eye\n  bounds: 0, 0, 10, 10/);
  assert.match(result, /right\/eye\n  bounds: 10, 0, 12, 12/);
});

test('does not duplicate aliases already present in the atlas', () => {
  const source = `page.png
  size: 32, 32
new/body
  bounds: 0, 0, 8, 8
`;
  assert.equal(addSpineAtlasPathAliases(source, { skins: [{ attachments: {
    slot: { 'new/body': { type: 'region' } },
  } }] }), source);
});

test('leaves atlas text unchanged when no matching folder-qualified paths exist', () => {
  assert.equal(addSpineAtlasPathAliases(atlas, { skins: [] }), atlas);
});
