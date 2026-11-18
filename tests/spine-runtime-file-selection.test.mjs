import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSpineRuntimeSkeleton as select} from '../lib/spine-runtime-file-selection.js';

test('selects actual large Spine JSON when config.json is also uploaded',()=>{
 const files=[{name:'config.json',size:91},{name:'player-main.json',size:18980882},{name:'player-main.atlas'}];
 assert.equal(select(files,'player-main.atlas')?.name,'player-main.json');
});
test('prefers matching binary skeleton over unrelated JSON metadata',()=>{
 const files=[{name:'config.json'},{name:'cowgirl.skel'},{name:'doggy.skel'}];
 assert.equal(select(files,'doggy.atlas')?.name,'doggy.skel');
});
test('never treats lone config JSON as a runtime skeleton',()=>{
 assert.equal(select([{name:'config.json'}]),null);
});
test('supports single JSON with missing atlas as a recoverable import',()=>{
 assert.equal(select([{name:'boss_1.json'},{name:'boss_1.png'}])?.name,'boss_1.json');
});
