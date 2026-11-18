import assert from 'node:assert/strict';
import { inspectRuntimeAssetSet } from '../lib/runtime-acceptance.js';
const cases = [
  {name:'runtime PNG',files:['character.skel','character.atlas','character.png'],accepted:true},
  {name:'legacy DDS',files:['character.skel','character.atlas','character.dds'],accepted:true},
  {name:'nested PNG',files:['character.json','character.atlas','images/a.png'],accepted:true},
  {name:'only .skel',files:['character.skel'],accepted:false,missing:['atlas','texture']},
  {name:'no texture',files:['character.skel','character.atlas'],accepted:false,missing:['texture']},
  {name:'no skeleton',files:['character.atlas','character.png'],accepted:false,missing:['skeleton']},
  {name:'path traversal',files:['../character.skel','character.atlas','character.png'],accepted:false,missing:['unsafe-path']},
];
for (const test of cases) {
  const actual=inspectRuntimeAssetSet(test.files);
  assert.equal(actual.accepted,test.accepted,test.name);
  if(test.missing)for(const missing of test.missing)
    assert.ok(actual.missing.includes(missing),test.name+' missing '+missing);
  console.log('PASS acceptance: '+test.name);
}
