import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSpineJsonFromUnityTextAsset,
  spineUnityTextAssetVersionFromBase64,
} from '../lib/spine-unity-textasset.js';

const embedded = JSON.stringify({
  skeleton: { hash: 'fixture', spine: '4.2.42', width: 100, height: 100 },
  bones: [{ name: 'root' }],
  animations: { idle: {} },
});
const unityTextAsset = `TextAsset Base
  string m_Name = "20938824"
  string m_Script = "${embedded}"
  int m_PathID = 0
`;

test('detects the Spine version from the Unity TextAsset header without reading the full skeleton', () => {
  const head = Buffer.from(unityTextAsset).subarray(0, 256).toString('base64');
  assert.equal(spineUnityTextAssetVersionFromBase64(head), '4.2.42');
});

test('extracts a valid Spine JSON document from a Unity TextAsset wrapper', () => {
  const json = JSON.parse(extractSpineJsonFromUnityTextAsset(Buffer.from(unityTextAsset)));
  assert.equal(json.skeleton.spine, '4.2.42');
  assert.equal(json.animations.idle !== undefined, true);
});

test('rejects ordinary text and non-Spine TextAsset payloads', () => {
  assert.equal(spineUnityTextAssetVersionFromBase64(Buffer.from('not a Unity asset').toString('base64')), '');
  assert.throws(() => extractSpineJsonFromUnityTextAsset(Buffer.from('not a Unity asset')), /not a Unity/);
  const unrelated = `TextAsset Base
  string m_Script = ${JSON.stringify('{"name":"not spine"}')}
`;
  assert.throws(() => extractSpineJsonFromUnityTextAsset(Buffer.from(unrelated)), /not a versioned Spine/);
});
